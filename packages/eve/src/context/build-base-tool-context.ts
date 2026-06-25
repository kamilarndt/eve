import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
};

export function buildBaseToolContext(abortSignal: AbortSignal | undefined): BaseToolContext {
  if (abortSignal === undefined) {
    throw new Error("Authored tool execution is missing the turn abort signal.");
  }

  return {
    ...buildCallbackContext(),
    abortSignal,
  };
}
