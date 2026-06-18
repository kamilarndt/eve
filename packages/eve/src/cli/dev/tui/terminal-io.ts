/**
 * The terminal IO contracts shared by every renderer — a stdin-like input and a
 * stdout-like output. Extracted from `terminal-renderer.ts` so the React/cell
 * renderer (`src/tui/`) and the mock terminal can depend on these without
 * depending on the legacy `TerminalRenderer` itself. This is the decoupling that
 * lets `TerminalRenderer` be removed once the React renderer reaches full smoke
 * parity, without disturbing the new renderer.
 */

/** A stdin-like source: raw-mode toggle + `"data"` chunks. Satisfied by
 * `process.stdin` and by the test `MockUserInput`. */
export type TerminalInput = {
  isTTY?: boolean;
  on(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  off(event: "data", listener: (chunk: Buffer) => void): TerminalInput;
  resume(): TerminalInput;
  pause(): TerminalInput;
  setRawMode?: (mode: boolean) => TerminalInput;
};

/** A stdout-like sink: `write` + size + `"resize"`. Satisfied by
 * `process.stdout` and by the test `MockScreen`. */
export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean;
  on(event: "resize", listener: () => void): TerminalOutput;
  off(event: "resize", listener: () => void): TerminalOutput;
};
