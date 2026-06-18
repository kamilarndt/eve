/**
 * Cell style + ANSI parsing.
 *
 * A cell's `style` is the ANSI SGR prefix to emit before its character ("" =
 * terminal default). P1 keeps it as an opaque accumulated string: as SGR
 * sequences are seen they are appended, and a full reset (`ESC[0m` / `ESC[m`)
 * clears the accumulation. The presenter prepends a reset before each run, so
 * replaying the accumulated string reconstructs the exact visual state. A
 * structured StylePool that re-serializes a minimal sequence per cell (à la
 * Claude Code) is a later optimization — this is correct for eve's balanced
 * open/close formatters and bounded per run.
 */
export type Style = string;

export interface StyledChar {
  ch: string;
  style: Style;
}

/** A run of text sharing one style — the structured (non-ANSI-string) way a
 * component hands styled content to an `<eve-text>` leaf. */
export interface StyledSegment {
  text: string;
  style: Style;
}

const RESET_PARAMS = new Set(["", "0"]);

/**
 * Parse an ANSI-styled string into per-character cells carrying the active SGR
 * state. Recognizes CSI SGR sequences (`ESC[ … m`); other escape sequences are
 * skipped (not emitted as cells). Iterates UTF-16 code units, so BMP glyphs map
 * to one cell — wide-char / emoji cell width is handled later.
 */
export function parseAnsi(input: string): StyledChar[] {
  const out: StyledChar[] = [];
  let style: Style = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\x1b" && input[i + 1] === "[") {
      let j = i + 2;
      while (j < input.length && !/[A-Za-z]/u.test(input[j]!)) j += 1;
      const final = input[j];
      if (final === "m") {
        const params = input.slice(i + 2, j);
        style = RESET_PARAMS.has(params) ? "" : style + input.slice(i, j + 1);
      }
      i = final === undefined ? input.length : j + 1;
      continue;
    }
    out.push({ ch, style });
    i += 1;
  }
  return out;
}
