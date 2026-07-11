import { createHash, randomUUID } from "node:crypto";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { ContextContainer, loadContext } from "#context/container.js";
import {
  AuthKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  LocalSubagentsOnlyKey,
  ModeKey,
  SessionIdKey,
} from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  createExperimentalWorkflowEntryInput,
  getExperimentalWorkflowReadyToken,
  type ExperimentalWorkflowEntryInput,
} from "#execution/durable-session-migrations/experimental-workflow.js";
import {
  experimentalWorkflowEntryReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import { createSession } from "#execution/session.js";
import { ensureWorkflowContinuationSecurity } from "#harness/workflow-continuation-security.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import {
  parseExperimentalWorkflowReference,
  parseExperimentalWorkflowSnapshot,
} from "#runtime/experimental-workflow-boundary.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import type { JsonValue } from "#shared/json.js";
import type {
  ExperimentalWorkflowStartResult,
  ExperimentalWorkflowStopInput,
  ExperimentalWorkflowStopResult,
} from "#shared/experimental-workflow-definition.js";

const CONTROL_HOOK_RETRY_ATTEMPTS = 300;
const CONTROL_HOOK_RETRY_DELAY_MS = 100;
const LOCAL_EXPERIMENTAL_WORKFLOW_SCOPE = `process:${randomUUID()}`;
export { experimentalWorkflowEntryReference } from "#execution/workflow-runtime.js";

export type { ExperimentalWorkflowEntryInput } from "#execution/durable-session-migrations/experimental-workflow.js";

export type {
  ExperimentalWorkflowStartResult,
  ExperimentalWorkflowStopInput,
  ExperimentalWorkflowStopResult,
} from "#shared/experimental-workflow-definition.js";

export class ExperimentalWorkflowNoActiveControllerError extends Error {
  readonly runId: string;
  readonly terminalKind?: string;

  constructor(runId: string, terminalKind?: string) {
    const terminal = terminalKind === undefined ? "settled" : `settled as ${terminalKind}`;
    super(
      `ExperimentalWorkflow controller "${runId}" ${terminal} before becoming ready; no active controller exists.`,
    );
    this.name = "ExperimentalWorkflowNoActiveControllerError";
    this.runId = runId;
    this.terminalKind = terminalKind;
  }
}

/** Starts or adopts the durable controller for one configured workflow reference. */
export async function startExperimentalWorkflow(
  referenceInput: unknown,
  abortSignal?: AbortSignal,
): Promise<ExperimentalWorkflowStartResult> {
  throwIfAborted(abortSignal);
  for (;;) {
    const captured = await captureExperimentalWorkflow(referenceInput);

    try {
      const owner = normalizeHookOwner(await getHookByToken(captured.controlToken));
      try {
        return await waitForActiveController(captured.readyToken, getRun(owner.runId), 300);
      } catch (error) {
        if (!(error instanceof ExperimentalWorkflowNoActiveControllerError)) throw error;
        await delay(CONTROL_HOOK_RETRY_DELAY_MS);
        continue;
      }
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
    }

    const started = await startWorkflowPreferLatest(experimentalWorkflowEntryReference, [captured]);
    try {
      return await waitForActiveController(captured.readyToken, started);
    } catch (error) {
      if (
        error instanceof ExperimentalWorkflowNoActiveControllerError &&
        (error.terminalKind === "stale" || error.terminalKind === "readiness changed")
      ) {
        await delay(CONTROL_HOOK_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}

/** Requests cooperative stop and waits until the owning workflow run settles. */
export async function stopExperimentalWorkflow(
  input: ExperimentalWorkflowStopInput,
  abortSignal?: AbortSignal,
): Promise<ExperimentalWorkflowStopResult> {
  throwIfAborted(abortSignal);
  const captured = await captureExperimentalWorkflow(input.reference, false);

  for (let attempt = 0; attempt < CONTROL_HOOK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const expectedRunId =
        input.runId ?? normalizeHookOwner(await getHookByToken(captured.controlToken)).runId;
      // Subscribe before delivering stop: a fast controller can settle and
      // disappear from an eventually-consistent run lookup before resumeHook
      // returns its owner.
      const settlement = getRun(expectedRunId).returnValue;
      void settlement.catch(() => undefined);
      const control: {
        expectedRunId: string;
        kind: "stop";
        reason?: string;
      } = {
        expectedRunId,
        kind: "stop",
      };
      if (input.reason !== undefined) control.reason = input.reason;
      const owner = normalizeHookOwner(await resumeHook(captured.controlToken, control));
      if (owner.runId !== expectedRunId) {
        if (input.runId !== undefined) return { runId: owner.runId, stopped: false };
        continue;
      }
      const result = await settlement;
      return {
        runId: owner.runId,
        stopped:
          typeof result === "object" &&
          result !== null &&
          Reflect.get(result, "kind") === "stopped",
      };
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if (attempt === CONTROL_HOOK_RETRY_ATTEMPTS - 1) {
        return input.runId === undefined
          ? { stopped: false }
          : { runId: input.runId, stopped: false };
      }
      await delay(CONTROL_HOOK_RETRY_DELAY_MS, abortSignal);
    }
  }

  return { stopped: false };
}

async function captureExperimentalWorkflow(
  referenceInput: unknown,
  includeReadySnapshot = true,
): Promise<ExperimentalWorkflowEntryInput> {
  const ctx = loadContext();
  const bundle = ctx.require(BundleKey);
  const definition = bundle.resolvedAgent.experimentalWorkflow;
  if (definition === undefined) {
    throw new Error("This agent does not configure an ExperimentalWorkflow persistence adapter.");
  }

  const reference = await parseExperimentalWorkflowReference(definition, referenceInput);
  const controllerHash = createHash("sha256")
    .update(definition.sourceId)
    .update("\0")
    .update(canonicalJson(reference));
  const deploymentScope = resolveExperimentalWorkflowDeploymentScope();
  if (deploymentScope !== undefined) {
    controllerHash.update("\0").update(deploymentScope);
  }
  const controllerId = controllerHash.digest("base64url");
  const controlToken = `eve:experimental-workflow:${controllerId}:control`;
  const detachedIdentity = `experimental-workflow:${controllerId}`;
  const serializedContext = createDetachedExperimentalWorkflowContext(
    ctx,
    bundle,
    detachedIdentity,
  );
  const session = createDetachedExperimentalWorkflowSession(bundle, detachedIdentity);

  const loadedSnapshot = includeReadySnapshot ? await definition.load(reference) : null;
  const snapshot =
    loadedSnapshot === null ? null : parseExperimentalWorkflowSnapshot(loadedSnapshot);

  return createExperimentalWorkflowEntryInput({
    controlToken,
    definitionSourceId: definition.sourceId,
    readyToken: getExperimentalWorkflowReadyToken(
      controlToken,
      snapshot === null ? null : { dueAt: snapshot.dueAt, iteration: snapshot.iteration },
    ),
    reference,
    serializedContext,
    sessionState: createDurableSessionState({ session }),
  });
}

function createDetachedExperimentalWorkflowContext(
  caller: ReturnType<typeof loadContext>,
  bundle: CompiledBundle,
  identity: string,
): Record<string, unknown> {
  // Persistent iterations keep the verified principal and channel so authored
  // tools can act for the requester and report to the requested destination.
  // Every turn/session-local key is omitted and the detached identity is seeded
  // explicitly, preventing caller lineage, input, approvals, and HITL state from
  // crossing into unattended work.
  const detached = new ContextContainer();
  detached.set(BundleKey, bundle);
  detached.set(ChannelKey, caller.require(ChannelKey));
  detached.set(AuthKey, caller.require(AuthKey));
  detached.set(InitiatorAuthKey, caller.require(InitiatorAuthKey));
  detached.set(SessionIdKey, identity);
  detached.set(ContinuationTokenKey, `${identity}:continuation`);
  detached.set(ModeKey, "task");
  detached.set(LocalSubagentsOnlyKey, true);
  return serializeContext(detached);
}

function createDetachedExperimentalWorkflowSession(bundle: CompiledBundle, identity: string) {
  const limits = bundle.resolvedAgent.config.limits;
  return ensureWorkflowContinuationSecurity(
    createSession({
      compactionOverrides: {
        thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
      },
      continuationToken: `${identity}:continuation`,
      limits: {
        maxInputTokensPerSession: limits?.maxInputTokensPerSession,
        maxOutputTokensPerSession: limits?.maxOutputTokensPerSession,
      },
      localSubagentsOnly: true,
      sessionId: identity,
      subagentDepth: 0,
      subagentMaxDepth: limits?.maxSubagentDepth,
      turnAgent: bundle.turnAgent,
      workflowMaxSubagents: limits?.maxSubagents,
    }),
  );
}

async function waitForActiveController(
  readyToken: string,
  started: Pick<Awaited<ReturnType<typeof startWorkflowPreferLatest>>, "returnValue" | "runId">,
  maxMissingAttempts?: number,
): Promise<ExperimentalWorkflowStartResult> {
  const terminal: Promise<ControllerTerminalOutcome> = started.returnValue.then(
    (result) => ({ kind: "settled" as const, result }),
    (error: unknown) => ({ error, kind: "rejected" as const }),
  );
  let missingAttempts = 0;
  while (true) {
    const readiness = await Promise.race([readHookReadiness(readyToken), terminal]);
    if (readiness.kind === "owner") return { runId: readiness.runId };
    if (readiness.kind === "rejected") throw readiness.error;
    if (readiness.kind === "settled")
      return await resolveSettledController(readyToken, started.runId, readiness.result);

    const retry = await Promise.race([
      delay(CONTROL_HOOK_RETRY_DELAY_MS).then(() => ({ kind: "retry" as const })),
      terminal,
    ]);
    if (retry.kind === "retry") {
      missingAttempts += 1;
      if (maxMissingAttempts !== undefined && missingAttempts >= maxMissingAttempts) {
        throw new ExperimentalWorkflowNoActiveControllerError(started.runId, "readiness changed");
      }
      continue;
    }
    if (retry.kind === "rejected") throw retry.error;
    return await resolveSettledController(readyToken, started.runId, retry.result);
  }
}

type ControllerTerminalOutcome =
  | { readonly error: unknown; readonly kind: "rejected" }
  | { readonly kind: "settled"; readonly result: unknown };

type ControlHookReadiness =
  | { readonly kind: "missing" }
  | { readonly kind: "owner"; readonly runId: string };

async function readHookReadiness(token: string): Promise<ControlHookReadiness> {
  try {
    const owner = normalizeHookOwner(await getHookByToken(token));
    return { kind: "owner", runId: owner.runId };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    return { kind: "missing" };
  }
}

function readTerminalKind(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const kind = Reflect.get(result, "kind");
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

async function resolveSettledController(
  readyToken: string,
  startedRunId: string,
  result: unknown,
): Promise<ExperimentalWorkflowStartResult> {
  if (
    typeof result === "object" &&
    result !== null &&
    Reflect.get(result, "kind") === "duplicate"
  ) {
    const duplicateRunId = Reflect.get(result, "runId");
    if (typeof duplicateRunId !== "string" || duplicateRunId.length === 0) {
      throw new Error("Duplicate ExperimentalWorkflow controller did not include a run id.");
    }
    return await waitForActiveController(readyToken, getRun(duplicateRunId), 300);
  }

  throw new ExperimentalWorkflowNoActiveControllerError(startedRunId, readTerminalKind(result));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const objectValue = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key] as JsonValue)}`)
    .join(",")}}`;
}

/** Keeps pinned deployments isolated while production controllers survive deploys. */
function resolveExperimentalWorkflowDeploymentScope(): string | undefined {
  if (process.env.VERCEL_ENV === "production") return undefined;

  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (deploymentId !== undefined && deploymentId.length > 0) {
    return `deployment:${deploymentId}`;
  }

  const deploymentUrl = process.env.VERCEL_URL?.trim();
  if (deploymentUrl !== undefined && deploymentUrl.length > 0) {
    return `url:${deploymentUrl}`;
  }

  return LOCAL_EXPERIMENTAL_WORKFLOW_SCOPE;
}

function normalizeHookOwner(value: unknown): { readonly runId: string } {
  if (typeof value !== "object" || value === null || !("runId" in value)) {
    throw new Error("ExperimentalWorkflow control hook did not include a run id.");
  }
  const runId = Reflect.get(value, "runId");
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("ExperimentalWorkflow control hook did not include a run id.");
  }
  return { runId };
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, milliseconds);
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason;
}
