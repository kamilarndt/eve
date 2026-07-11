const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

/** Terminal outcome of a cancelled turn. */
export class TurnCancelledError extends Error {
  readonly fatal = true;

  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

/** True when the error, or one of its causes, is a {@link TurnCancelledError}. */
export function isTurnCancellation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: unknown }).name === TURN_CANCELLED_ERROR_NAME) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/** Throws when the turn signal has aborted. */
export function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted !== true) {
    return;
  }
  if (isTurnCancellation(abortSignal.reason)) {
    throw abortSignal.reason;
  }
  throw new TurnCancelledError();
}

/** Races asynchronous turn work against its cancellation signal. */
export async function raceWithTurnAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (abortSignal === undefined) {
    return await promise;
  }

  throwIfTurnAborted(abortSignal);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwIfTurnAborted(abortSignal);
      } catch (error) {
        reject(error);
      }
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}
