import type {
  EffectCall,
  EffectName,
  EffectOutput,
  LoopBackend,
  SerializableFailure,
} from "./types.js";

export class EffectExhaustedError extends Error {
  readonly effect: EffectName;
  readonly failure: SerializableFailure;

  constructor(effect: EffectName, failure: SerializableFailure) {
    super(`Effect "${effect}" failed after backend retries: ${failure.message}`, {
      cause: new Error(failure.message),
    });
    this.effect = effect;
    this.failure = failure;
    this.name = "EffectExhaustedError";
  }
}

export async function runEffect<K extends EffectName>(
  backend: LoopBackend,
  call: EffectCall<K>,
): Promise<EffectOutput<K>> {
  const result = await backend.effect(call);
  if (result.kind === "exhausted") {
    throw new EffectExhaustedError(call.name, result.error);
  }
  return result.output;
}
