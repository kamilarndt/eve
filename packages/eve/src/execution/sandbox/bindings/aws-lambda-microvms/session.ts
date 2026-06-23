import { posix } from "node:path";

import { buildSandboxSession } from "#execution/sandbox/session.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type {
  InternalSandboxSession,
  SandboxSession,
  SandboxSpawnOptions,
} from "#shared/sandbox-session.js";

import type { AwsLambdaMicrovmController } from "./controller-client.js";

export function createAwsLambdaMicrovmSession(input: {
  readonly beforeOperation?: () => Promise<void>;
  readonly controller: AwsLambdaMicrovmController;
  readonly id: string;
  readonly onMutate?: () => void;
}): SandboxSession {
  const primitives: InternalSandboxSession = {
    id: input.id,
    async readFile(options) {
      await input.beforeOperation?.();
      return await input.controller.readFile(options.path, options.abortSignal);
    },
    async removePath(options) {
      await input.beforeOperation?.();
      input.onMutate?.();
      await input.controller.removePath(options);
    },
    resolvePath,
    async spawn(options: SandboxSpawnOptions) {
      await input.beforeOperation?.();
      input.onMutate?.();
      return await input.controller.spawn({
        abortSignal: options.abortSignal,
        command: options.command,
        env: options.env,
        workingDirectory: resolvePath(options.workingDirectory ?? WORKSPACE_ROOT),
      });
    },
    async writeFile(options) {
      await input.beforeOperation?.();
      input.onMutate?.();
      await input.controller.writeFile(
        options.path,
        await streamToBuffer(options.content),
        options.abortSignal,
      );
    },
  };

  return buildSandboxSession(primitives, async (policy) => {
    await input.beforeOperation?.();
    await rejectRuntimeNetworkPolicy(policy);
  });
}

function resolvePath(path: string): string {
  if (posix.isAbsolute(path)) return posix.normalize(path);
  return posix.resolve(WORKSPACE_ROOT, path);
}

async function rejectRuntimeNetworkPolicy(_policy: SandboxNetworkPolicy): Promise<void> {
  throw new Error(
    "AWS Lambda MicroVM network connectors are immutable after launch. Configure runtimeEgressNetworkConnectorArns in awsLambdaMicrovm().",
  );
}
