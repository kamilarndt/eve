/**
 * The cell grid — the frame representation. A buffer is a `height x width` grid
 * of cells, each a character plus its {@link Style} (the ANSI prefix to render
 * it). `writeAnsi` rasterizes an eve-formatted ANSI string into styled cells;
 * `writeText` writes unstyled text. `toString` projects to plain text (style
 * stripped) for golden tests; the presenter diffs cells and emits ANSI.
 */
import { parseAnsi, type Style } from "./style.js";

export interface Cell {
  char: string;
  style: Style;
}

const BLANK: Cell = { char: " ", style: "" };

export class CellBuffer {
  readonly width: number;
  readonly height: number;
  private readonly rows: Cell[][];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.rows = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({ char: " ", style: "" })),
    );
  }

  setCell(x: number, y: number, char: string, style: Style = ""): void {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    const row = this.rows[y];
    if (row) row[x] = { char, style };
  }

  /** Writes unstyled `text` left-to-right from (x, y); clips at the edge. */
  writeText(x: number, y: number, text: string): void {
    for (let i = 0; i < text.length; i += 1) this.setCell(x + i, y, text[i]!, "");
  }

  /** Rasterizes an ANSI-styled string into styled cells from (x, y). Cell
   * positions advance by visible character; the escape sequences themselves
   * occupy no cells. */
  writeAnsi(x: number, y: number, input: string): void {
    const cells = parseAnsi(input);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]!;
      this.setCell(x + i, y, cell.ch, cell.style);
    }
  }

  getCell(x: number, y: number): Cell {
    return this.rows[y]?.[x] ?? BLANK;
  }

  /** The character at (x, y), or " " out of bounds. */
  getChar(x: number, y: number): string {
    return this.rows[y]?.[x]?.char ?? " ";
  }

  /** Plain-text projection (style stripped): trailing blanks per row trimmed,
   * trailing blank rows dropped. Stable enough to assert against in tests. */
  toString(): string {
    return this.rows
      .map((row) =>
        row
          .map((cell) => cell.char)
          .join("")
          .replace(/\s+$/u, ""),
      )
      .join("\n")
      .replace(/\n+$/u, "");
  }
}
