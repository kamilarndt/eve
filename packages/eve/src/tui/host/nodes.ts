/**
 * Host node model for the React-driven terminal renderer.
 *
 * `react-reconciler` calls into the host config (see {@link ./reconciler.ts})
 * to build and mutate a tree of these nodes — the terminal analogue of the
 * DOM. Each element node owns a Yoga node for flex layout; text nodes carry a
 * string and live inside an `eve-text` element, which is always a Yoga leaf
 * that measures its own collected text. Layout + rasterization (see
 * {@link ../render.ts}) walk this tree; React never sees cells, only nodes.
 */
import { parseAnsi, type StyledChar, type StyledSegment } from "../cells/style.js";
import { lineWidth, wrapStyledChars } from "../cells/wrap.js";
import { applyStyle, createYogaNode, type LayoutStyle, type YogaNode } from "../layout/yoga.js";

/** Host element kinds the reconciler may create. Lowercase strings authored in
 * components (`<eve-box>` / `createElement("eve-box")`) map here. */
export type ElementType = "eve-root" | "eve-box" | "eve-text";

export interface ElementNode {
  readonly kind: "element";
  readonly type: ElementType;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: ElementNode | undefined;
  readonly yoga: YogaNode;
  /** Set on the root container only; invoked after every commit. */
  onCommit?: () => void;
}

export interface TextNode {
  readonly kind: "text";
  value: string;
  parent: ElementNode | undefined;
}

export type HostNode = ElementNode | TextNode;

/** Concatenate text content under an element (text nodes + nested eve-text). */
export function collectText(node: ElementNode): string {
  let text = "";
  for (const child of node.children) {
    if (child.kind === "text") text += child.value;
    else if (child.type === "eve-text") text += collectText(child);
  }
  return text;
}

/**
 * The styled characters an `<eve-text>` should render. Prefers a structured
 * `segments` prop (components hand styled runs directly — no ANSI strings);
 * falls back to parsing ANSI from text children for plain/legacy content.
 */
export function styledCharsOf(node: ElementNode): StyledChar[] {
  const segments = node.props.segments as StyledSegment[] | undefined;
  if (Array.isArray(segments)) {
    const chars: StyledChar[] = [];
    for (const segment of segments) {
      for (const ch of segment.text) chars.push({ ch, style: segment.style });
    }
    return chars;
  }
  return parseAnsi(collectText(node));
}

function styleFromProps(props: Record<string, unknown>): LayoutStyle {
  const style: LayoutStyle = {};
  const direction = props.flexDirection;
  if (direction === "row" || direction === "column") style.flexDirection = direction;
  if (typeof props.width === "number") style.width = props.width;
  if (typeof props.height === "number") style.height = props.height;
  if (typeof props.flexGrow === "number") style.flexGrow = props.flexGrow;
  if (typeof props.flexShrink === "number") style.flexShrink = props.flexShrink;
  return style;
}

/** (Re)apply layout style from a node's props to its Yoga node. */
export function syncStyle(node: ElementNode): void {
  applyStyle(node.yoga, styleFromProps(node.props));
}

export function createElement(type: ElementType, props: Record<string, unknown>): ElementNode {
  const yoga = createYogaNode();
  const node: ElementNode = { kind: "element", type, props, children: [], parent: undefined, yoga };
  syncStyle(node);
  if (type === "eve-text") {
    // eve-text is a Yoga leaf; it measures its own collected text, wrapping to
    // the available width. widthMode 0 (Undefined) means "natural size" — used
    // for row segments — so we don't wrap there. The closure reads `node` live,
    // so text updates (+ markDirty) are picked up.
    yoga.setMeasureFunc((width, widthMode) => {
      const chars = styledCharsOf(node);
      const wrapWidth =
        widthMode === 0 || !Number.isFinite(width) ? Number.POSITIVE_INFINITY : width;
      const lines = wrapStyledChars(chars, wrapWidth);
      const measured = lines.reduce((max, line) => Math.max(max, lineWidth(line)), 0);
      return {
        width: Number.isFinite(wrapWidth) ? Math.min(width, measured) : measured,
        height: Math.max(1, lines.length),
      };
    });
  }
  return node;
}

export function createText(value: string): TextNode {
  return { kind: "text", value, parent: undefined };
}

/** Yoga children are element children only (text lives inside eve-text's
 * measure). This maps a DOM child index to the Yoga child index. */
function yogaIndexOf(parent: ElementNode, domIndex: number): number {
  let count = 0;
  for (let i = 0; i < domIndex; i += 1) {
    const child = parent.children[i];
    if (child && child.kind === "element") count += 1;
  }
  return count;
}

/**
 * Detach a child that already lives under `parent` (from both the children
 * array and Yoga) so it can be re-inserted at a new position. react-reconciler
 * performs a keyed move by calling appendChild/insertBefore on the SAME existing
 * instance — without a prior removeChild — so the node is still owned, and
 * Yoga's `insertChild` aborts with "Child already has a owner" unless we detach
 * first. No-op for a brand-new child.
 */
function detachIfPresent(parent: ElementNode, child: HostNode): void {
  const existing = parent.children.indexOf(child);
  if (existing < 0) return;
  parent.children.splice(existing, 1);
  if (parent.type !== "eve-text" && child.kind === "element") {
    parent.yoga.removeChild(child.yoga);
  }
}

export function appendChild(parent: ElementNode, child: HostNode): void {
  detachIfPresent(parent, child);
  child.parent = parent;
  parent.children.push(child);
  if (parent.type !== "eve-text" && child.kind === "element") {
    parent.yoga.insertChild(child.yoga, yogaIndexOf(parent, parent.children.length - 1));
  }
}

export function insertBefore(parent: ElementNode, child: HostNode, before: HostNode): void {
  detachIfPresent(parent, child);
  const index = parent.children.indexOf(before);
  const at = index < 0 ? parent.children.length : index;
  child.parent = parent;
  parent.children.splice(at, 0, child);
  if (parent.type !== "eve-text" && child.kind === "element") {
    parent.yoga.insertChild(child.yoga, yogaIndexOf(parent, at));
  }
}

export function removeChild(parent: ElementNode, child: HostNode): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
  child.parent = undefined;
  if (parent.type !== "eve-text" && child.kind === "element") {
    parent.yoga.removeChild(child.yoga);
    // react-reconciler calls removeChild only for genuine deletions (keyed moves
    // go through insertBefore on the existing instance), so the detached subtree
    // is discarded for good — free its Yoga nodes to avoid leaking native memory.
    child.yoga.freeRecursive();
  }
}
