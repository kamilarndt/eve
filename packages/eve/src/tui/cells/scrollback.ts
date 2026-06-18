/**
 * The scrollback + live-region presenter — the "own native scrollback" model
 * (Claude Code / Ink, and eve's own `live-region.ts`). Unlike {@link ./present.ts}
 * (a fixed-grid absolute-positioned diff that clears the screen and owns the
 * viewport), this commits *settled* lines to the terminal's native scrollback
 * (printed once, they scroll with history and survive exit / copy-paste) and
 * repaints only the live tail in place with relative cursor moves.
 *
 * The caller supplies a `liveY` boundary: lines `[0, liveY)` are settled (the
 * transcript above the first live block) and commit-eligible; `[liveY, …)` is the
 * live region (the streaming tail + footer), repainted every frame. A retroactive
 * change to already-committed lines (e.g. `/loglevel` re-showing hidden blocks)
 * is detected as a prefix divergence and handled by a full clear + replay — the
 * analogue of the terminal renderer's `#replayTranscript`. The whole write is
 * wrapped in DEC 2026 synchronized-output markers so it paints atomically.
 */
import type { Cell } from "./buffer.js";

const ESC = "\x1b";
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const CLEAR_AND_HOME = `${ESC}[2J${ESC}[H`;
const ERASE_TO_END = `${ESC}[0J`;

/** Render one row of cells to an ANSI string, trailing blanks trimmed and styles
 * reset at the end so nothing bleeds into the next line. */
export function lineToAnsi(cells: readonly Cell[]): string {
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.char === " " && cells[end - 1]!.style === "") end -= 1;
  let out = "";
  let style = "";
  for (let i = 0; i < end; i += 1) {
    const cell = cells[i]!;
    if (cell.style !== style) {
      out += RESET + cell.style;
      style = cell.style;
    }
    out += cell.char;
  }
  if (style !== "") out += RESET;
  return out;
}

export interface ScrollbackPresenter {
  /** ANSI to advance the terminal to the new frame. `lines` is the full rendered
   * output; `liveY` is the first live (repaint) row. Returns "" when idle. */
  present(lines: Cell[][], liveY: number): string;
  /** Forget committed state (used when the surrounding runtime tears down). */
  reset(): void;
}

function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  if (prefix.length > of.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] !== of[i]) return false;
  return true;
}

export function createScrollbackPresenter(): ScrollbackPresenter {
  let flushed: string[] = []; // committed line strings, in scrollback
  let liveHeight = 0; // rows the live region occupied last frame
  let started = false;

  return {
    present(lines, liveY) {
      const boundary = Math.max(0, Math.min(liveY, lines.length));
      const committable = lines.slice(0, boundary).map(lineToAnsi);
      const live = lines.slice(boundary).map(lineToAnsi);
      let body = "";

      if (!started) {
        // First paint: hide the cursor, commit the settled prefix, draw the tail.
        body += HIDE_CURSOR;
        for (const line of committable) body += `${line}\n`;
        body += live.join("\n");
      } else if (!isPrefix(flushed, committable)) {
        // Retroactive change to committed content → full clear + replay.
        body += CLEAR_AND_HOME;
        for (const line of committable) body += `${line}\n`;
        body += live.join("\n");
      } else {
        // Move to the top of the previous live region, erase it, commit any newly
        // settled lines (they scroll into history), then redraw the live tail.
        body += liveHeight > 1 ? `${ESC}[${liveHeight - 1}F` : "\r";
        body += ERASE_TO_END;
        for (const line of committable.slice(flushed.length)) body += `${line}\n`;
        body += live.join("\n");
      }

      started = true;
      flushed = committable;
      liveHeight = live.length;
      return body ? `${SYNC_BEGIN}${body}${SYNC_END}` : "";
    },
    reset() {
      flushed = [];
      liveHeight = 0;
      started = false;
    },
  };
}
