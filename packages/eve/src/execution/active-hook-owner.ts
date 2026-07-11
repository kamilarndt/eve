import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getHookByToken } from "#internal/workflow/runtime.js";

export interface ActiveHookOwner {
  readonly runId: string;
}

/** Reads the active stable-token owner, or null while no owner is visible. */
export async function readActiveHookOwner(
  token: string,
  label = "Workflow hook",
): Promise<ActiveHookOwner | null> {
  try {
    const value = await getHookByToken(token);
    if (typeof value !== "object" || value === null || !("runId" in value)) {
      throw new Error(`${label} did not include a run id.`);
    }
    const runId = Reflect.get(value, "runId");
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error(`${label} did not include a run id.`);
    }
    return { runId };
  } catch (error) {
    if (HookNotFoundError.is(error)) return null;
    throw error;
  }
}
