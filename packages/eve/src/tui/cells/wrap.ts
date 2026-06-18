/**
 * Word-aware wrapping of styled characters into lines — the primitive prose
 * needs. Operates on the per-character style stream from {@link parseAnsi}, so
 * emphasis is preserved across wraps. Hard newlines always break; a word longer
 * than the width is hard-broken. Always returns at least one (possibly empty)
 * line, so an empty Text still occupies one row.
 *
 * P2 counts one column per character; wide-character (CJK/emoji) widths are a
 * later refinement that plugs into the width accounting here.
 */
import { parseAnsi, type StyledChar } from "./style.js";

function splitOnNewlines(chars: StyledChar[]): StyledChar[][] {
  const lines: StyledChar[][] = [[]];
  for (const char of chars) {
    if (char.ch === "\n") lines.push([]);
    else lines[lines.length - 1]!.push(char);
  }
  return lines;
}

function lastSpaceIndex(line: StyledChar[]): number {
  for (let i = line.length - 1; i >= 0; i -= 1) if (line[i]!.ch === " ") return i;
  return -1;
}

export function wrapStyledChars(chars: StyledChar[], width: number): StyledChar[][] {
  if (!(width > 0) || !Number.isFinite(width)) return splitOnNewlines(chars);

  const lines: StyledChar[][] = [];
  let line: StyledChar[] = [];
  let lastSpace = -1;

  for (const char of chars) {
    if (char.ch === "\n") {
      lines.push(line);
      line = [];
      lastSpace = -1;
      continue;
    }
    line.push(char);
    if (char.ch === " ") lastSpace = line.length - 1;
    if (line.length > width) {
      if (lastSpace > 0) {
        const tail = line.slice(lastSpace + 1); // length <= width
        line.length = lastSpace; // drop the breaking space and the tail
        lines.push(line);
        line = tail;
      } else {
        const overflow = line.pop()!; // no break point: hard-break
        lines.push(line);
        line = [overflow];
      }
      lastSpace = lastSpaceIndex(line);
    }
  }
  lines.push(line);
  return lines;
}

/** Convenience: parse an ANSI string and wrap it. */
export function wrapAnsi(content: string, width: number): StyledChar[][] {
  return wrapStyledChars(parseAnsi(content), width);
}

/** Visible width of a wrapped line (one column per character for now). */
export function lineWidth(line: StyledChar[]): number {
  return line.length;
}
