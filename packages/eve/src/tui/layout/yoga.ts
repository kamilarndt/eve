/**
 * Thin wrapper over `yoga-layout` (WASM flexbox, Node-safe). Keeps Yoga's API
 * behind an eve-owned surface (AGENTS.md principle 3) and centralizes the
 * style -> Yoga mapping. Host nodes own a `YogaNode` (see {@link ../host/nodes.ts});
 * the renderer calls {@link calculateLayout} once per frame and reads computed
 * positions back out.
 *
 * `yoga-layout`'s default entry loads its WASM at import time, so the node
 * factory below is synchronously usable once this module has loaded.
 */
import Yoga from "yoga-layout";
import { type Node as YogaNode } from "yoga-layout";

export type { YogaNode };

export interface LayoutStyle {
  flexDirection?: "row" | "column";
  width?: number;
  height?: number;
  flexGrow?: number;
  flexShrink?: number;
}

export function createYogaNode(): YogaNode {
  return Yoga.Node.create();
}

export function applyStyle(node: YogaNode, style: LayoutStyle): void {
  node.setFlexDirection(
    style.flexDirection === "row" ? Yoga.FLEX_DIRECTION_ROW : Yoga.FLEX_DIRECTION_COLUMN,
  );
  if (typeof style.width === "number") node.setWidth(style.width);
  else node.setWidthAuto();
  if (typeof style.height === "number") node.setHeight(style.height);
  else node.setHeightAuto();
  node.setFlexGrow(style.flexGrow ?? 0);
  node.setFlexShrink(style.flexShrink ?? 1);
}

export function calculateLayout(root: YogaNode, width: number, height: number): void {
  root.calculateLayout(width, height, Yoga.DIRECTION_LTR);
}
