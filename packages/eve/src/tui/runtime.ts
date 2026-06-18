/**
 * Mount a React element into the terminal: drive `react-reconciler`
 * synchronously, and on each commit render the host tree to lines and present
 * them with the scrollback + live-region discipline (see
 * {@link ./cells/scrollback.ts}) — settled transcript commits to native
 * scrollback (survives scroll / copy-paste / exit), the live tail repaints in
 * place. The output is any `{ write }` sink, so tests can capture bytes without
 * a PTY and real use passes `process.stdout`.
 *
 * `<Main>` marks the live boundary with a `liveBoundary` box; absent one, the
 * whole frame is treated as live (still correct, just no commit).
 */
import type { ReactNode } from "react";

import { createScrollbackPresenter } from "./cells/scrollback.js";
import { createElement, type ElementNode } from "./host/nodes.js";
import { CONCURRENT_ROOT, reconciler } from "./host/reconciler.js";
import { renderToLines } from "./render.js";

const ESC = "\x1b";
const SHOW_CURSOR = `${ESC}[?25h`;

export interface OutputStream {
  write(chunk: string): void;
  columns?: number;
  rows?: number;
}

export interface RenderOptions {
  stdout?: OutputStream;
  width?: number;
  height?: number;
}

export interface RenderHandle {
  /** Re-render with a new element (drives frames from an external loop). */
  update(element: ReactNode): void;
  unmount(): void;
}

export function render(element: ReactNode, options: RenderOptions = {}): RenderHandle {
  const out: OutputStream = options.stdout ?? process.stdout;
  const width = options.width ?? out.columns ?? 80;

  const root: ElementNode = createElement("eve-root", {});
  const presenter = createScrollbackPresenter();

  root.onCommit = () => {
    const { lines, liveY } = renderToLines(root, width);
    const chunk = presenter.present(lines, liveY);
    if (chunk) out.write(chunk);
  };

  const noop = () => {};
  const onError = (error: unknown) => {
    throw error;
  };
  const container = reconciler.createContainer(
    root,
    CONCURRENT_ROOT,
    null,
    false,
    null,
    "",
    onError,
    onError,
    noop,
    null,
  );

  const commit = (node: ReactNode): void => {
    reconciler.updateContainerSync(node, container, null, null);
    reconciler.flushSyncWork();
  };

  commit(element);

  return {
    update(node: ReactNode) {
      commit(node);
    },
    unmount() {
      commit(null);
      out.write(SHOW_CURSOR);
    },
  };
}
