/**
 * JSX intrinsic elements for the terminal renderer. Declaring these teaches
 * TypeScript the props of our host elements so `<eve-box>` / `<eve-text>`
 * typecheck (and autocomplete) like any JSX host tag. The reconciler turns
 * these lowercase tags into host nodes (see {@link ./host/nodes.ts}); the props
 * here mirror the layout style read in `styleFromProps`.
 */
import type { ReactNode } from "react";

import type { StyledSegment } from "./cells/style.js";

interface EveBoxProps {
  flexDirection?: "row" | "column";
  width?: number;
  height?: number;
  flexGrow?: number;
  flexShrink?: number;
  /** Marks the live-region boundary for the scrollback presenter (read by
   * `render.ts`; layout-inert). */
  liveBoundary?: boolean;
  children?: ReactNode;
}

interface EveTextProps {
  /** Structured styled runs (preferred — no ANSI strings). */
  segments?: StyledSegment[];
  children?: ReactNode;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "eve-box": EveBoxProps;
      "eve-text": EveTextProps;
    }
  }
}
