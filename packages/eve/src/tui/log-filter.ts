/**
 * Log-visibility filtering for the transcript, the declarative-renderer port of
 * `TerminalRenderer`'s `#shouldRenderLog` / `#isHiddenLog`. The store keeps every
 * captured `log`/`sandbox` block regardless of mode; the transcript filters at
 * read time, so a `/loglevel` switch is retroactive without re-buffering — React
 * just re-derives the visible list.
 */
import type { Block } from "../cli/dev/tui/blocks.js";
import type { LogDisplayMode } from "../cli/dev/tui/log-display-mode.js";

function shouldRenderLog(source: "stdout" | "stderr" | "sandbox", mode: LogDisplayMode): boolean {
  switch (mode) {
    case "none":
      return false;
    case "stderr":
      return source === "stderr";
    case "sandbox":
      return source === "sandbox";
    case "all":
      return true;
  }
}

/** True for a `log`/`sandbox` block the current display mode hides. Non-log
 * blocks are never hidden. */
export function isLogHidden(block: Block, mode: LogDisplayMode): boolean {
  if (block.kind === "sandbox") return !shouldRenderLog("sandbox", mode);
  if (block.kind !== "log") return false;
  return !shouldRenderLog(block.title === "stderr" ? "stderr" : "stdout", mode);
}

/** The transcript blocks visible under `mode` (default "all"). */
export function visibleBlocks(blocks: readonly Block[], mode: LogDisplayMode = "all"): Block[] {
  return blocks.filter((block) => !isLogHidden(block, mode));
}
