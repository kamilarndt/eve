/**
 * Markdown rendered as a component tree — the port of `renderMarkdown`. Each
 * source line becomes a wrapping `<Text>` (heading / list item / blockquote /
 * paragraph) in a column, and inline emphasis (bold / italic / inline code) is
 * parsed into structured styled segments. GFM tables (header + separator row)
 * are detected during the line scan and rendered as aligned `<Box>` rows. No
 * ANSI strings are built; styling is carried as tone-derived segment styles and
 * the wrapper preserves it.
 *
 * Line-based, mirroring eve's `renderMarkdown`.
 */
import type { ReactNode } from "react";

import type { Style, StyledSegment } from "../cells/style.js";
import { visibleLength } from "../../cli/dev/tui/terminal-text.js";
import { Box, Text, toneStyle } from "./primitives.js";

const BOLD = toneStyle("bold");
const ITALIC = toneStyle("italic");
const CODE = toneStyle("cyan");
const QUOTE = toneStyle("dim");

const INLINE = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
// Matches an http(s) URL run; used to shield it from emphasis parsing.
const URL = /https?:\/\/\S+/g;
const TABLE_SEPARATOR = "─";

/** Parse a single non-URL chunk into emphasis segments over a base style. */
function parseEmphasis(text: string, base: Style, out: StyledSegment[]): void {
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), style: base });
    const token = match[0];
    if (token.startsWith("`")) {
      out.push({ text: token.slice(1, -1), style: base + CODE });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push({ text: token.slice(2, -2), style: base + BOLD });
    } else {
      out.push({ text: token.slice(1, -1), style: base + ITALIC });
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), style: base });
}

/** Parse inline markdown (code, bold, italic) into styled segments over a base
 * style. URLs are emitted verbatim as plain segments so emphasis markers inside
 * them (e.g. a `sca_…` token or a callback path) are not misread as emphasis
 * and stripped. Styles combine by concatenating their SGR prefixes. */
export function parseInline(text: string, base: Style = ""): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL.lastIndex = 0;
  while ((match = URL.exec(text)) !== null) {
    if (match.index > last) parseEmphasis(text.slice(last, match.index), base, segments);
    segments.push({ text: match[0], style: base });
    last = URL.lastIndex;
  }
  if (last < text.length) parseEmphasis(text.slice(last), base, segments);
  if (segments.length === 0) segments.push({ text: "", style: base });
  return segments;
}

/** Classify one source line into styled segments. */
export function lineSegments(line: string): StyledSegment[] {
  if (line.startsWith("### "))
    return [{ text: "▶ ", style: BOLD }, ...parseInline(line.slice(4), BOLD)];
  if (line.startsWith("## "))
    return [{ text: "■ ", style: BOLD }, ...parseInline(line.slice(3), BOLD)];
  if (line.startsWith("# "))
    return [{ text: "█ ", style: BOLD }, ...parseInline(line.slice(2), BOLD)];

  const unordered = line.match(/^(\s*)[-+*]\s+(.*)$/);
  if (unordered) {
    const indent = unordered[1] ?? "";
    const rest = unordered[2] ?? "";
    return [{ text: `${indent}• `, style: "" }, ...parseInline(rest)];
  }

  if (/^\d+\.\s/.test(line)) return parseInline(line);
  if (line.startsWith("> "))
    return [{ text: "│ ", style: QUOTE }, ...parseInline(line.slice(2), QUOTE)];
  return parseInline(line);
}

type TableAlignment = "left" | "center" | "right";

type ParsedTable = {
  alignments: TableAlignment[];
  endIndex: number;
  header: string[];
  rows: string[][];
};

/** Detect a GFM table starting at `startIndex` (header + separator row), ported
 * from eve's `parseTable`. Returns `undefined` when the lines aren't a table. */
function parseTable(lines: string[], startIndex: number): ParsedTable | undefined {
  const header = parseTableCells(lines[startIndex] ?? "");
  if (header == null || header.length < 2) return undefined;

  const separatorCells = parseTableCells(lines[startIndex + 1] ?? "");
  if (separatorCells == null || separatorCells.length !== header.length) return undefined;

  const alignments = parseTableAlignments(separatorCells);
  if (alignments == null) return undefined;

  const rows: string[][] = [];
  let endIndex = startIndex + 2;
  while (endIndex < lines.length) {
    const row = parseTableCells(lines[endIndex] ?? "");
    if (row == null) break;
    rows.push(normalizeTableRow(row, header.length));
    endIndex += 1;
  }

  return { alignments, endIndex, header, rows };
}

/** Split a `|`-delimited table line into trimmed cells (handles escaped `\|`). */
function parseTableCells(line: string): string[] | undefined {
  if (!line.includes("|")) return undefined;

  let tableLine = line.trim();
  if (tableLine.startsWith("|")) tableLine = tableLine.slice(1);
  if (tableLine.endsWith("|") && !tableLine.endsWith("\\|")) tableLine = tableLine.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < tableLine.length; index += 1) {
    const character = tableLine[index];
    const nextCharacter = tableLine[index + 1];
    if (character === "\\" && nextCharacter === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

/** Read per-column alignment from a separator row (`:---`, `:--:`, `---:`). */
function parseTableAlignments(cells: string[]): TableAlignment[] | undefined {
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const match = cell.match(/^(:)?-{3,}(:)?$/);
    if (match == null) return undefined;
    const [, left, right] = match;
    alignments.push(left != null && right != null ? "center" : right != null ? "right" : "left");
  }
  return alignments;
}

function normalizeTableRow(row: string[], length: number): string[] {
  return Array.from({ length }, (_, index) => row[index] ?? "");
}

/** Pad a cell's segments to `width` visible columns per its alignment, mirroring
 * eve's `alignTableCell`. Padding is appended/prepended as plain segments. */
function alignCell(
  segments: StyledSegment[],
  width: number,
  alignment: TableAlignment,
): StyledSegment[] {
  const text = segments.map((segment) => segment.text).join("");
  const padding = Math.max(0, width - visibleLength(text));
  if (padding === 0) return segments;

  if (alignment === "right") return [{ text: " ".repeat(padding), style: "" }, ...segments];
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return [
      { text: " ".repeat(left), style: "" },
      ...segments,
      { text: " ".repeat(padding - left), style: "" },
    ];
  }
  return [...segments, { text: " ".repeat(padding), style: "" }];
}

/** Render a parsed table as a column of row Boxes, columns padded to a shared
 * width and joined by two spaces — the component-tree port of `renderTable`. */
function Table({ table, keyPrefix }: { table: ParsedTable; keyPrefix: number }) {
  const headerCells = table.header.map((cell) => parseInline(cell, BOLD));
  const bodyCells = table.rows.map((row) => row.map((cell) => parseInline(cell)));
  const allRows = [headerCells, ...bodyCells];
  const widths = table.alignments.map((_, column) =>
    Math.max(
      3,
      ...allRows.map((row) => visibleLength((row[column] ?? []).map((s) => s.text).join(""))),
    ),
  );

  const renderRow = (cells: StyledSegment[][], rowKey: string) => {
    const segments: StyledSegment[] = [];
    cells.forEach((cell, column) => {
      if (column > 0) segments.push({ text: "  ", style: "" });
      segments.push(...alignCell(cell, widths[column] ?? 0, table.alignments[column] ?? "left"));
    });
    return <Text key={rowKey} segments={segments} />;
  };

  const separator: StyledSegment[] = [];
  widths.forEach((width, column) => {
    if (column > 0) separator.push({ text: "  ", style: "" });
    separator.push({ text: TABLE_SEPARATOR.repeat(width), style: "" });
  });

  return (
    <Box flexDirection="column">
      {renderRow(headerCells, `${keyPrefix}-h`)}
      <Text key={`${keyPrefix}-s`} segments={separator} />
      {bodyCells.map((cells, index) => renderRow(cells, `${keyPrefix}-r${index}`))}
    </Box>
  );
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split("\n");
  const nodes: ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const table = parseTable(lines, index);
    if (table != null) {
      nodes.push(<Table key={index} table={table} keyPrefix={index} />);
      index = table.endIndex - 1;
      continue;
    }
    nodes.push(<Text key={index} segments={lineSegments(lines[index] ?? "")} />);
  }

  return <Box flexDirection="column">{nodes}</Box>;
}
