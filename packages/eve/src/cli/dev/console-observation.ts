import { contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import {
  fingerprintConsoleArguments,
  normalizeConsoleType,
} from "#internal/devtools/console-correlation.js";
import type { DevObservationSink } from "#internal/devtools/observation.js";

const OBSERVED_CONSOLE_METHODS = ["debug", "error", "info", "log", "trace", "warn"] as const;

type ObservedConsoleMethod = (typeof OBSERVED_CONSOLE_METHODS)[number];

export function observeConsoleContext(
  observation: DevObservationSink,
  target: Pick<Console, ObservedConsoleMethod> = console,
): () => void {
  const originals = new Map<ObservedConsoleMethod, (...args: unknown[]) => void>();

  for (const method of OBSERVED_CONSOLE_METHODS) {
    const original = target[method] as (...args: unknown[]) => void;
    originals.set(method, original);
    target[method] = ((...args: unknown[]) => {
      const session = contextStorage.getStore()?.get(SessionKey);
      observation.emit("runtime.console.context", () => ({
        coordinates:
          session === undefined
            ? undefined
            : {
                session: session.sessionId,
                turn: session.turn.id,
              },
        fingerprint: fingerprintConsoleArguments(args),
        type: normalizeConsoleType(method),
      }));
      Reflect.apply(original, target, args);
    }) as Console[ObservedConsoleMethod];
  }

  return () => {
    for (const [method, original] of originals) {
      target[method] = original as Console[ObservedConsoleMethod];
    }
  };
}
