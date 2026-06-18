import type { VercelCredentialBrokering } from "#execution/sandbox/bindings/vercel-credentials.js";
import type { Command } from "#compiled/@vercel/sandbox/index.js";
import { normalizeVercelReadStream } from "#execution/sandbox/bindings/vercel-read-stream.js";
import type { VercelSandbox } from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { adaptMultiplexedCommandToSandboxProcess } from "#execution/sandbox/multiplexed-command.js";
import { resolveVercelCredentialPolicy } from "#execution/sandbox/bindings/vercel-credentials.js";
import {
  clearVercelEgressDemandMarkers,
  readVercelEgressDemandedRuleIds,
} from "#execution/sandbox/bindings/vercel-egress-demand.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxBackendHandle } from "#public/definitions/sandbox-backend.js";
import type { VercelSandboxSessionUseOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "#shared/sandbox-session.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

export function createVercelSandboxHandle(
  sandbox: VercelSandbox,
  sessionKey: string,
  brokering: VercelCredentialBrokering | undefined,
  brokeredPolicy: SandboxNetworkPolicy | undefined,
  initialCredentials: ReadonlyMap<
    string,
    import("#runtime/connections/types.js").TokenResult
  > = new Map(),
): SandboxBackendHandle<VercelSandboxSessionUseOptions> {
  let credentials = new Map(initialCredentials);
  const onRequestRuleIds =
    brokering === undefined
      ? []
      : [...brokering.rules.values()]
          .filter((rule) => rule.credentialResolution === "on-request")
          .map((rule) => rule.id);
  const demandHandler =
    brokering === undefined
      ? undefined
      : {
          hasDemand: async (): Promise<boolean> =>
            (await readVercelEgressDemandedRuleIds(sandbox, onRequestRuleIds)).length > 0,
          resolveDemand: async (): Promise<void> => {
            const demanded = await readVercelEgressDemandedRuleIds(sandbox, onRequestRuleIds);
            const unresolved = demanded.filter((ruleId) => !credentials.has(ruleId));
            if (unresolved.length === 0) {
              await clearVercelEgressDemandMarkers(sandbox, demanded);
              return;
            }
            let resolved;
            try {
              resolved = await resolveVercelCredentialPolicy(
                brokering,
                sessionKey,
                unresolved,
                sandbox.name,
              );
            } catch (error) {
              await sandbox.update({
                networkPolicy: brokering.buildPolicy(credentials, sandbox.name),
              });
              await clearVercelEgressDemandMarkers(sandbox, unresolved);
              throw error;
            }
            credentials = new Map([...credentials, ...resolved.credentials]);
            await sandbox.update({
              networkPolicy: brokering.buildPolicy(credentials, sandbox.name),
            });
            await clearVercelEgressDemandMarkers(sandbox, unresolved);
            if (resolved.unresolvedRuleIds.length > 0) {
              throw new Error(
                `Sandbox credentials remained unavailable for on-request rules: ${resolved.unresolvedRuleIds.join(
                  ", ",
                )}.`,
              );
            }
          },
        };
  return {
    session: buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, sessionKey, demandHandler),
      createVercelNetworkPolicySetter(sandbox, brokering !== undefined),
    ),
    useSessionFn: async (options?: VercelSandboxSessionUseOptions) => {
      if (options !== undefined) {
        if (brokering !== undefined && options.networkPolicy !== undefined) {
          throw new Error(
            "vercel(): `onSession` cannot replace `networkPolicy` when managed `auth` rules exist.",
          );
        }
        await sandbox.update(options);
      }
      if (brokeredPolicy !== undefined) {
        await sandbox.update({ networkPolicy: brokeredPolicy });
      }
      return buildSandboxSession(
        createVercelInternalSandboxSession(sandbox, sessionKey, demandHandler),
        createVercelNetworkPolicySetter(sandbox, brokering !== undefined),
      );
    },
    async captureState() {
      return {
        backendName: "vercel",
        metadata: { sandboxName: sandbox.name },
        sessionKey,
      };
    },
    async dispose() {
      if (brokering !== undefined) {
        await sandbox.update({ networkPolicy: brokering.clearedPolicy });
      }
    },
  };
}

export function createVercelInternalSandboxSession(
  sandbox: VercelSandbox,
  id: string,
  demandHandler?: VercelDemandHandler,
): InternalSandboxSession {
  return {
    id,
    resolvePath: resolveVercelSandboxPath,
    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const startCommand = async () =>
        await sandbox.runCommand({
          args: ["-lc", options.command],
          cmd: "bash",
          cwd: options.workingDirectory ?? WORKSPACE_ROOT,
          detached: true,
          env: options.env,
          signal: options.abortSignal,
        });
      const command = await startCommand();
      return demandHandler === undefined
        ? adaptMultiplexedCommandToSandboxProcess({
            command,
            getOutput: (log) => log.stream,
          })
        : adaptDemandAwareVercelProcess(command, startCommand, demandHandler);
    },
    async readFile(options: SandboxReadFileOptions) {
      return normalizeVercelReadStream(await sandbox.readFile({ path: options.path }));
    },
    async writeFile(options: SandboxWriteFileOptions) {
      const bytes = await streamToBuffer(options.content);
      await sandbox.writeFiles([{ content: bytes, path: options.path }]);
    },
    async removePath(options: SandboxRemovePathOptions) {
      await sandbox.fs.rm(options.path, {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
  };
}

export function createVercelNetworkPolicySetter(
  sandbox: VercelSandbox,
  managed = false,
): (policy: SandboxNetworkPolicy) => Promise<void> {
  return async (policy) => {
    if (managed) {
      throw new Error(
        "vercel(): `setNetworkPolicy` is unavailable when managed `auth` rules exist.",
      );
    }
    await sandbox.update({ networkPolicy: policy });
  };
}

const MAX_ON_REQUEST_REPLAYS = 3;
const DEMAND_POLL_INTERVAL_MS = 50;

function adaptDemandAwareVercelProcess(
  initialCommand: Command,
  startCommand: () => Promise<Command>,
  demandHandler: VercelDemandHandler,
): SandboxProcess {
  const encoder = new TextEncoder();
  let activeCommand = initialCommand;
  let killed = false;
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => (stdoutController = controller),
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => (stderrController = controller),
  });

  const execute = async (): Promise<{ readonly exitCode: number }> => {
    let replayCount = 0;
    try {
      while (true) {
        const command = activeCommand;
        const attemptLogs: Array<{
          readonly data: Uint8Array;
          readonly stream: "stdout" | "stderr";
        }> = [];
        const logs = collectCommandLogs(command, encoder, attemptLogs);
        const finished = command.wait();
        let result: Awaited<typeof finished> | undefined;
        let replayRequired = false;
        while (result === undefined) {
          const outcome = await Promise.race([
            finished.then((value) => ({ kind: "finished" as const, value })),
            delay(DEMAND_POLL_INTERVAL_MS).then(() => ({ kind: "poll" as const })),
          ]);
          if (outcome.kind === "finished") {
            result = outcome.value;
            break;
          }
          if (await demandHandler.hasDemand()) {
            await command.kill().catch(() => {});
            await finished.catch(() => undefined);
            await demandHandler.resolveDemand();
            replayRequired = true;
            break;
          }
        }
        await logs;
        const demandedAfterExit = await demandHandler.hasDemand();
        if (demandedAfterExit) {
          await demandHandler.resolveDemand();
          replayRequired = true;
        }
        if (!replayRequired && result !== undefined) {
          flushCommandLogs(attemptLogs, stdoutController, stderrController);
          return { exitCode: result.exitCode };
        }
        if (killed) return { exitCode: result?.exitCode ?? 137 };
        replayCount += 1;
        if (replayCount > MAX_ON_REQUEST_REPLAYS) {
          throw new Error(
            `Sandbox command exceeded ${MAX_ON_REQUEST_REPLAYS} on-request authorization replays.`,
          );
        }
        activeCommand = await startCommand();
      }
    } finally {
      stdoutController.close();
      stderrController.close();
    }
  };
  let execution: Promise<{ readonly exitCode: number }> | undefined;

  return {
    stdout,
    stderr,
    async wait() {
      execution ??= execute();
      return await execution;
    },
    async kill() {
      killed = true;
      await activeCommand.kill();
      if (execution === undefined) {
        stdoutController.close();
        stderrController.close();
      }
    },
  };
}

interface VercelDemandHandler {
  readonly hasDemand: () => Promise<boolean>;
  readonly resolveDemand: () => Promise<void>;
}

async function collectCommandLogs(
  command: Command,
  encoder: TextEncoder,
  output: Array<{ readonly data: Uint8Array; readonly stream: "stdout" | "stderr" }>,
): Promise<void> {
  for await (const message of command.logs()) {
    output.push({ data: encoder.encode(message.data), stream: message.stream });
  }
}

function flushCommandLogs(
  logs: readonly { readonly data: Uint8Array; readonly stream: "stdout" | "stderr" }[],
  stdout: ReadableStreamDefaultController<Uint8Array>,
  stderr: ReadableStreamDefaultController<Uint8Array>,
): void {
  for (const message of logs) {
    (message.stream === "stdout" ? stdout : stderr).enqueue(message.data);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveVercelSandboxPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${WORKSPACE_ROOT}/${path}`;
}
