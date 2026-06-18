/**
 * Keyboard input: read a stdin-like stream, decode it with eve's existing
 * `nextKey` tokenizer (reused, not reimplemented — it already reassembles
 * escape sequences split across reads), and dispatch decoded {@link TerminalKey}
 * events to registered handlers. This is the `onKey(...)` layer from the
 * authoring sketch; handlers typically call `shared.setState(...)`.
 *
 * The stream is injected, so tests drive it with a plain EventEmitter and real
 * use passes `process.stdin` (raw mode enabled while reading).
 */
import { nextKey, type TerminalKey } from "../cli/dev/tui/stream-format.js";

export interface InputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off?(event: "data", listener: (chunk: Buffer | string) => void): void;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
}

export type KeyHandler = (key: TerminalKey) => void;

export interface Input {
  /** Handle one key kind (e.g. "ctrl-l", "enter", "character"). Returns an
   * unsubscribe function. */
  onKey(type: TerminalKey["type"], handler: KeyHandler): () => void;
  /** Handle every decoded key. Returns an unsubscribe function. */
  onAnyKey(handler: KeyHandler): () => void;
  /** Stop reading and restore the stream. */
  dispose(): void;
}

interface Registration {
  type: TerminalKey["type"] | undefined;
  handler: KeyHandler;
}

export function createInput(stream: InputStream = process.stdin as unknown as InputStream): Input {
  const registrations = new Set<Registration>();
  let pending = "";

  const dispatch = (key: TerminalKey): void => {
    if (key.type === "ignore") return;
    for (const registration of registrations) {
      if (registration.type === undefined || registration.type === key.type) {
        registration.handler(key);
      }
    }
  };

  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (pending.length > 0) {
      const token = nextKey(pending);
      if (token.incomplete) break;
      pending = pending.slice(token.consumed || 1);
      if (token.key) dispatch(token.key);
    }
  };

  stream.setRawMode?.(true);
  stream.resume?.();
  stream.on("data", onData);

  const register = (registration: Registration): (() => void) => {
    registrations.add(registration);
    return () => {
      registrations.delete(registration);
    };
  };

  return {
    onKey: (type, handler) => register({ type, handler }),
    onAnyKey: (handler) => register({ type: undefined, handler }),
    dispose: () => {
      stream.off?.("data", onData);
      stream.setRawMode?.(false);
      stream.pause?.();
      registrations.clear();
    },
  };
}
