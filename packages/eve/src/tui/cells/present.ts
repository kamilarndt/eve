/**
 * The presenter: turn the difference between two frames into the minimal ANSI
 * byte string. Walks the grid; for each changed cell it moves the cursor (only
 * when not already contiguous), emits a style transition when the cell's style
 * differs from the last emitted one (a full reset + the cell's accumulated SGR,
 * so styles never bleed across runs), then the character. The whole update is
 * wrapped in DEC 2026 synchronized-output markers so the terminal paints it
 * atomically (no tearing).
 *
 * Absolute cursor positioning for now — the runtime clears the screen on first
 * paint, so the frame occupies the top-left. The scrollback + live-region
 * discipline is a later refinement layered on this same diff.
 */
import type { Cell, CellBuffer } from "./buffer.js";

const ESC = "\x1b";
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const RESET = `${ESC}[0m`;

function moveTo(x: number, y: number): string {
  return `${ESC}[${y + 1};${x + 1}H`;
}

function isBlank(cell: Cell): boolean {
  return cell.char === " " && cell.style === "";
}

function equal(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.style === b.style;
}

/**
 * ANSI to transform `prev` into `next`. When `prev` is null every non-blank
 * cell is emitted (initial paint). Returns "" when nothing changed.
 */
export function present(prev: CellBuffer | null, next: CellBuffer): string {
  let body = "";
  let emittedStyle = "";
  let cursorX = -1;
  let cursorY = -1;

  for (let y = 0; y < next.height; y += 1) {
    for (let x = 0; x < next.width; x += 1) {
      const cell = next.getCell(x, y);
      const changed = prev ? !equal(prev.getCell(x, y), cell) : !isBlank(cell);
      if (!changed) continue;

      if (cursorY !== y || cursorX !== x) {
        body += moveTo(x, y);
      }
      if (cell.style !== emittedStyle) {
        body += RESET + cell.style;
        emittedStyle = cell.style;
      }
      body += cell.char;
      cursorX = x + 1;
      cursorY = y;
    }
  }

  if (!body) return "";
  if (emittedStyle !== "") body += RESET; // leave the terminal in a clean state
  return `${SYNC_BEGIN}${body}${SYNC_END}`;
}
