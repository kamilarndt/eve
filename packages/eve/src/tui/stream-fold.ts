/**
 * Folds an `AgentTUIStreamEvent` stream into the transcript `Block[]` the React
 * components render. This is the declarative-renderer port of `TerminalRenderer`'s
 * `#applyStreamEvent` + `#upsertBlock` (see `cli/dev/tui/terminal-renderer.ts`):
 * a faithful, mechanical transcription of the event→Block mapping.
 *
 * Two invariants carried over from the original, both load-bearing:
 *  - **Delta accumulation lives in fold state, not the Block.** Assistant and
 *    reasoning blocks always carry the *full* accumulated text; we keep
 *    `text`/`reasoning` maps (mirroring `RenderTurnState`) and rewrite the whole
 *    body each delta.
 *  - **Upsert by stable id with shallow merge.** `event.id` (assistant/reasoning)
 *    and `tool:${toolCallId}` (tools) are opaque stable keys; an event updates the
 *    matching block in place or appends a new one.
 *
 * Unlike the terminal renderer, there is no `committedIds` guard: P3 keeps the
 * whole transcript in the store and re-renders it each frame, so every block stays
 * updatable. The scrollback/committed distinction arrives with P4.
 */
import type { Block, ToolStatus } from "../cli/dev/tui/blocks.js";
import type { AgentTUIStreamEvent } from "../cli/dev/tui/runner.js";
import { stripTerminalControls } from "../cli/dev/tui/terminal-text.js";
import { summarizeToolArgs, summarizeToolResult } from "../cli/dev/tui/tool-format.js";
import type { TerminalPartDisplayMode } from "../cli/dev/tui/types.js";

/** Display modes that gate folding (only reasoning visibility matters here). */
export interface FoldDisplayModes {
  reasoning: TerminalPartDisplayMode;
}

const DEFAULT_MODES: FoldDisplayModes = { reasoning: "full" };

/** Per-tool accumulator, mirroring the terminal renderer's `NativeToolState`. */
interface ToolState {
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
  errorText?: string;
}

/** `collapsed` decision for a reasoning trace — ported from `collapseReasoning`.
 * A streaming trace (`live`) stays expanded under "auto-collapsed"; a settled one
 * collapses. "collapsed" always collapses; "full" never does. */
function collapseReasoning(mode: TerminalPartDisplayMode, live: boolean): boolean {
  if (mode === "collapsed") return true;
  if (mode === "auto-collapsed") return !live;
  return false;
}

function toolBlock(state: ToolState): Block {
  const result =
    state.status === "done"
      ? summarizeToolResult(state.output)
      : state.status === "error"
        ? stripTerminalControls(state.errorText ?? "")
        : undefined;
  return {
    kind: "tool",
    id: `tool:${state.toolCallId}`,
    title: state.toolName,
    subtitle: summarizeToolArgs(state.input),
    status: state.status,
    result,
    live: state.status === "running" || state.status === "approval",
    toolInput: state.input,
    toolOutput: state.output,
  };
}

/**
 * The transcript fold. Owns the per-turn accumulators and the live `blocks`
 * array; `apply` mutates in place (push / shallow-merge by id), so callers that
 * need a fresh reference for a store write should copy `blocks` after applying.
 */
export class StreamFold {
  readonly blocks: Block[] = [];
  #text = new Map<string, string>();
  #reasoning = new Map<string, string>();
  #tools = new Map<string, ToolState>();
  #childToolCallIds = new Set<string>();
  #modes: FoldDisplayModes;

  constructor(modes: FoldDisplayModes = DEFAULT_MODES) {
    this.#modes = modes;
  }

  /** Upsert a block by id (shallow merge into the existing one), or append. A
   * block without an id is always appended (errors). */
  #upsert(block: Block): void {
    if (block.id === undefined) {
      this.blocks.push(block);
      return;
    }
    const existing = this.blocks.find((b) => b.id === block.id);
    if (existing) Object.assign(existing, block);
    else this.blocks.push(block);
  }

  /** Append a non-stream block (a user-prompt echo, a notice, a captured log
   * line) into the same ordered transcript the stream folds into. */
  append(block: Block): void {
    this.blocks.push(block);
  }

  /** Upsert a block by id (subagent / connection-auth out-of-band updates):
   * shallow-merge into the existing block, or append. Public wrapper over the
   * internal stream upsert so the renderer shares one ordered transcript. */
  upsertBlock(block: Block): void {
    this.#upsert(block);
  }

  /** Clear the transcript and all per-turn accumulators (the `/new` reset). */
  reset(): void {
    this.blocks.length = 0;
    this.#text.clear();
    this.#reasoning.clear();
    this.#tools.clear();
    this.#childToolCallIds.clear();
  }

  /** Fold one stream event into the transcript. */
  apply(event: AgentTUIStreamEvent): void {
    switch (event.type) {
      case "step-start":
      case "step-finish":
      case "finish":
        // Status-line / usage only — no transcript block.
        return;

      case "assistant-delta": {
        const body = stripTerminalControls((this.#text.get(event.id) ?? "") + event.delta);
        this.#text.set(event.id, body);
        this.#upsertText(event.id, "assistant", body, true);
        return;
      }
      case "assistant-complete": {
        const prev = this.#text.get(event.id) ?? "";
        // `text` is only present on the delta-less channel; otherwise the
        // accumulated deltas are authoritative.
        const body = event.text != null && prev === "" ? stripTerminalControls(event.text) : prev;
        this.#text.set(event.id, body);
        this.#upsertText(event.id, "assistant", body, false);
        return;
      }

      case "reasoning-delta": {
        if (this.#modes.reasoning === "hidden") return;
        const body = stripTerminalControls((this.#reasoning.get(event.id) ?? "") + event.delta);
        this.#reasoning.set(event.id, body);
        this.#upsertReasoning(event.id, body, true);
        return;
      }
      case "reasoning-complete": {
        if (this.#modes.reasoning === "hidden") return;
        const body = this.#reasoning.get(event.id) ?? "";
        this.#upsertReasoning(event.id, body, false);
        return;
      }

      case "tool-call": {
        if (this.#childToolCallIds.has(event.toolCallId)) return;
        const state: ToolState = {
          toolCallId: event.toolCallId,
          toolName: stripTerminalControls(event.toolName),
          input: event.input,
          status: "running",
        };
        this.#tools.set(event.toolCallId, state);
        this.#upsert(toolBlock(state));
        return;
      }
      case "tool-approval-request": {
        const state = this.#tools.get(event.toolCallId);
        if (!state) return;
        state.status = "approval";
        this.#upsert(toolBlock(state));
        return;
      }
      case "tool-result": {
        const state = this.#tools.get(event.toolCallId);
        if (!state) return;
        state.status = "done";
        state.output = event.output;
        this.#upsert(toolBlock(state));
        return;
      }
      case "tool-error": {
        const state = this.#tools.get(event.toolCallId);
        if (!state) return;
        state.status = "error";
        state.errorText = event.errorText;
        this.#upsert(toolBlock(state));
        return;
      }

      case "error": {
        this.blocks.push({
          kind: "error",
          title: "Error",
          body: stripTerminalControls(event.errorText),
          detail: event.detail ? stripTerminalControls(event.detail) : undefined,
          live: false,
        });
        return;
      }
    }
  }

  /** Empty-content skip: an all-whitespace assistant body creates no block. The
   * accumulator (`#text`/`#reasoning`) keeps the raw text so deltas concatenate;
   * only the stored block body is trimmed, as the terminal renderer does. */
  #upsertText(id: string, kind: "assistant", body: string, live: boolean): void {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    this.#upsert({ kind, id, body: trimmed, live });
  }

  #upsertReasoning(id: string, body: string, live: boolean): void {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    this.#upsert({
      kind: "reasoning",
      id,
      body: trimmed,
      collapsed: collapseReasoning(this.#modes.reasoning, live),
      live,
    });
  }

  /**
   * Mark a tool call as a subagent's child: suppress its parent-level block.
   * Mirrors `markChildToolCallId` — also removes any block already pushed for it,
   * since the announcement can arrive before the mark.
   */
  markChildToolCall(toolCallId: string): void {
    this.#childToolCallIds.add(toolCallId);
    const id = `tool:${toolCallId}`;
    const index = this.blocks.findIndex((b) => b.id === id);
    if (index >= 0) this.blocks.splice(index, 1);
  }

  /**
   * Settle a tool block denied out-of-band by the approval flow. The stream
   * itself never emits a result/error for a denial, so a denied call would stay
   * `live` forever without this (mirrors `#markToolDenied`).
   */
  denyTool(toolCallId: string): void {
    const state = this.#tools.get(toolCallId);
    if (!state) return;
    state.status = "denied";
    this.#upsert(toolBlock(state));
  }

  /**
   * End-of-stream pass: flip `live` off on every block except those still
   * awaiting an out-of-band decision/result (`approval`/`running`). Mirrors
   * `#finalizeAllBlocks`.
   */
  finalize(): void {
    for (const block of this.blocks) {
      if (block.status === "approval" || block.status === "running") continue;
      block.live = false;
    }
  }
}
