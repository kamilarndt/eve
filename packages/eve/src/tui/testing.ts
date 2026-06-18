/**
 * Test harness: mount a React element into the terminal renderer and capture
 * the resulting frame as plain text — the `captureCharFrame` pattern from
 * opentui's test renderer. No terminal, no PTY: `flushSync` forces React's
 * commit synchronously so the frame is ready to read the moment `update`
 * returns. The real-terminal runtime (raw mode, ANSI presenter) lands later;
 * this is enough to golden-test the React -> cells pipeline.
 */
import type { ReactNode } from "react";

import { createElement, type ElementNode } from "./host/nodes.js";
import { CONCURRENT_ROOT, reconciler } from "./host/reconciler.js";
import { renderToBuffer } from "./render.js";

export interface TestHandle {
  update(element: ReactNode): void;
  /** Flush pending work scheduled outside React (e.g. an external store
   * notifying `useSyncExternalStore` subscribers), so the frame reflects it. */
  flush(): void;
  captureCharFrame(): string;
  unmount(): void;
}

export function mountForTest(
  element: ReactNode,
  options: { width: number; height: number },
): TestHandle {
  const root: ElementNode = createElement("eve-root", {});
  let frame = "";
  root.onCommit = () => {
    frame = renderToBuffer(root, options.width, options.height).toString();
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

  const render = (next: ReactNode): void => {
    // Synchronous root: commit immediately so the frame is readable on return.
    reconciler.updateContainerSync(next, container, null, null);
    reconciler.flushSyncWork();
  };

  render(element);

  return {
    update: (next) => render(next),
    flush: () => reconciler.flushSyncWork(),
    captureCharFrame: () => frame,
    unmount: () => render(null),
  };
}
