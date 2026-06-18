import { EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, EVE_INFO_ROUTE_PATH } from "#protocol/routes.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import { Client } from "#client/index.js";
import type { DevToolsEventHub } from "#internal/devtools/event-hub.js";
import { DevToolsApiError } from "#internal/devtools/host/errors.js";
import type { DevToolsRuntimeState } from "#internal/devtools/host/types.js";

const RUNTIME_REQUEST_TIMEOUT_MS = 1_000;

export interface DevToolsRuntimeDomain {
  assertInteractive(): string;
  getAgentSnapshot(): Promise<{
    readonly agent?: unknown;
    readonly diagnostics?: readonly { readonly message: string }[];
  }>;
  getInternalState(): DevToolsRuntimeState;
  getPublicState(): Omit<DevToolsRuntimeState, "inspectorUrl">;
  refreshRevision(): Promise<void>;
  update(patch: Partial<DevToolsRuntimeState>): void;
}

export function createDevToolsRuntimeDomain(input: {
  readonly eventHub: DevToolsEventHub;
  readonly getState: () => DevToolsRuntimeState;
  readonly updateState: (patch: Partial<DevToolsRuntimeState>) => void;
}): DevToolsRuntimeDomain {
  let cachedAgent: unknown;

  const update = (patch: Partial<DevToolsRuntimeState>) => {
    input.updateState(patch);
    input.eventHub.publish("runtime.state", () => ({ runtime: publicState(input.getState()) }));
  };

  return {
    assertInteractive() {
      const state = input.getState();
      if (state.status !== "ready" || state.runtimeUrl === undefined) {
        throw new DevToolsApiError(
          409,
          "runtime_unavailable",
          `Runtime cannot accept interaction while ${state.status}.`,
        );
      }
      return state.runtimeUrl;
    },
    async getAgentSnapshot() {
      const state = input.getState();
      if (state.runtimeUrl === undefined || state.status !== "ready") {
        return {
          agent: cachedAgent,
          diagnostics: [
            { message: `Runtime is ${state.status}; showing the last agent snapshot.` },
          ],
        };
      }

      try {
        const response = await fetchRuntime(state.runtimeUrl, EVE_INFO_ROUTE_PATH);
        if (!response.ok) {
          throw new Error((await response.text()) || `Runtime returned HTTP ${response.status}.`);
        }
        cachedAgent = (await response.json()) as unknown;
        return { agent: cachedAgent };
      } catch (error) {
        return {
          agent: cachedAgent,
          diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
    getInternalState: input.getState,
    getPublicState() {
      return publicState(input.getState());
    },
    async refreshRevision() {
      const state = input.getState();
      if (state.status !== "ready" || state.runtimeUrl === undefined) return;
      try {
        const response = await fetchRuntime(state.runtimeUrl, EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH);
        if (!response.ok) return;
        const payload = (await response.json()) as { revision?: unknown };
        if (typeof payload.revision === "string" && payload.revision !== state.revision) {
          update({ revision: payload.revision });
        }
      } catch {
        // A paused or rebuilding runtime must not make the supervisor unavailable.
      }
    },
    update,
  };
}

async function fetchRuntime(runtimeUrl: string, path: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNTIME_REQUEST_TIMEOUT_MS);
  try {
    return await new Client(resolveDevelopmentClientOptions(runtimeUrl)).fetch(path, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function publicState(state: DevToolsRuntimeState): Omit<DevToolsRuntimeState, "inspectorUrl"> {
  const { inspectorUrl: _inspectorUrl, ...publicRuntime } = state;
  return publicRuntime;
}
