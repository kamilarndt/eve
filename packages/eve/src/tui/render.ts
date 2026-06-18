/**
 * Lay out the host node tree with Yoga, then rasterize it into a
 * {@link CellBuffer}. One `calculateLayout` pass on the root, then a walk that
 * accumulates parent offsets (Yoga reports positions relative to the parent)
 * and writes each `eve-text` element's content — wrapped to its computed width
 * — at its computed cell, preserving per-character style.
 */
import { type Cell, CellBuffer } from "./cells/buffer.js";
import { wrapStyledChars } from "./cells/wrap.js";
import { styledCharsOf, type ElementNode, type HostNode } from "./host/nodes.js";
import { calculateLayout } from "./layout/yoga.js";

/** Rasterize one element's wrapped text into the buffer at its computed cell. */
function drawNode(
  node: HostNode,
  offsetX: number,
  offsetY: number,
  buffer: CellBuffer,
  onBoundary?: (y: number) => void,
): void {
  if (node.kind === "text") return;
  const x = offsetX + node.yoga.getComputedLeft();
  const y = offsetY + node.yoga.getComputedTop();
  // A `liveBoundary`-marked box reports the first live (repaint) row to the
  // scrollback presenter; everything above it is settled and commit-eligible.
  if (onBoundary && node.props.liveBoundary === true) onBoundary(Math.round(y));
  if (node.type === "eve-text") {
    const computedWidth = Math.round(node.yoga.getComputedWidth());
    const lines = wrapStyledChars(
      styledCharsOf(node),
      computedWidth > 0 ? computedWidth : Number.POSITIVE_INFINITY,
    );
    const baseX = Math.round(x);
    const baseY = Math.round(y);
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row]!;
      for (let col = 0; col < line.length; col += 1) {
        buffer.setCell(baseX + col, baseY + row, line[col]!.ch, line[col]!.style);
      }
    }
    return;
  }
  for (const child of node.children) drawNode(child, x, y, buffer, onBoundary);
}

/** Fixed-grid rasterization (terminal-height buffer). Used by the test harness
 * and the absolute-positioned presenter. */
export function renderToBuffer(root: ElementNode, width: number, height: number): CellBuffer {
  root.yoga.setWidth(width);
  root.yoga.setHeight(height);
  calculateLayout(root.yoga, width, height);

  const buffer = new CellBuffer(width, height);
  drawNode(root, 0, 0, buffer);
  return buffer;
}

/**
 * Content-height rasterization for the scrollback presenter: lay out with an
 * automatic (content-driven) height so the whole transcript is rendered, not
 * clipped to the viewport, then read it back as rows of cells. `liveY` is the
 * first live (repaint) row — the computed top of the `liveBoundary` box, or the
 * full height when there is none (everything live).
 */
export function renderToLines(
  root: ElementNode,
  width: number,
): { lines: Cell[][]; liveY: number } {
  root.yoga.setWidth(width);
  root.yoga.setHeightAuto();
  // NaN height = "auto" to Yoga: the root grows to fit its content.
  calculateLayout(root.yoga, width, Number.NaN);

  const height = Math.max(1, Math.ceil(root.yoga.getComputedHeight()));
  const buffer = new CellBuffer(width, height);
  let liveY = height;
  drawNode(root, 0, 0, buffer, (y) => {
    liveY = Math.max(0, Math.min(y, height));
  });

  const lines: Cell[][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x += 1) row.push(buffer.getCell(x, y));
    lines.push(row);
  }
  return { lines, liveY };
}
