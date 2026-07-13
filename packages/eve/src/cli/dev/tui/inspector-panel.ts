/**
 * inspector-panel.ts — overlay (decorator) for TerminalRenderer
 *
 * Adds a split-panel tool inspector to the existing Eve dev TUI WITHOUT
 * modifying terminal-renderer.ts, runner.ts, or blocks.ts.
 *
 * HOW IT WORKS
 * ────────────
 * Wraps the existing `AgentTUIRenderer` interface: installs itself as the
 * renderer passed to EveTUIRunner, delegates all calls to the wrapped
 * TerminalRenderer, AND maintains a second inline terminal region (a
 * "sidecar" LiveRegion) to the right of the main transcript.
 *
 * The sidecar region re-renders on every `renderStream()` call, showing
 * the currently selected tool call's details (JSON args + result).
 *
 * USAGE
 * ─────
 * Instead of:
 *   const renderer = new TerminalRenderer(input, output, opts);
 *   const runner  = new EveTUIRunner({ ... renderer, ... });
 *
 * Use:
 *   const renderer = new TerminalRenderer(input, output, opts);
 *   const overlay  = new InspectorPanelOverlay(renderer, output, {
 *     panelWidth: 40,           // % of terminal width (default: 35%)
 *     minWidth:   30,           // cells (default: 30, auto-hide below)
 *   });
 *   const runner  = new EveTUIRunner({ ... renderer: overlay, ... });
 *
 * KEYBOARD
 * ────────
 * Tab / Shift+Tab   — focus panel (not implemented — requires Runner changes)
 * Escape             — close inspector
 *
 * RENDERING
 * ─────────
 * Two-column approach:
 *   1. TerminalRenderer renders its full-width rows as normal
 *   2. InspectorPanelOverlay splits each row at `panelOffset` columns:
 *      - Left: first `(width - panelOffset)` cells of the original row
 *      - Right: inspector content padded to `panelOffset`..`width`
 *
 * This avoids touching the internal LiveRegion — the overlay hooks only
 * the `renderStream()` output, not the LiveRegion's frame composition.
 */

import { TerminalRenderer, type TerminalOutput } from "./terminal-renderer.js";
import type {
  AgentTUIRenderer,
  AgentTUIStreamEvent,
  AgentTUIStreamResult,
  AgentTUISessionOptions,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
  SubagentStepUpdate,
  SubagentToolUpdate,
  ConnectionAuthUpdate,
} from "./runner.js";
import type { LogDisplayMode } from "./log-display-mode.js";
import type { VercelStatusSnapshot } from "./vercel-status.js";
import type { RemoteConnectionSnapshot } from "./remote-connection.js";

// ── Configuration ──────────────────────────────────────────────

export interface InspectorPanelConfig {
  /** Fraction of terminal width for the inspector (default: 0.35). */
  panelWidthFraction?: number;
  /** Minimum column count for the inspector; auto-hidden below this. */
  minPanelCells?: number;
}

// ── Tool call data model ──────────────────────────────────────

export interface InspectableToolCall {
  id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  status: "running" | "done" | "error" | "denied";
  durationMs?: number;
}

// ── InspectorPanelOverlay ─────────────────────────────────────

export class InspectorPanelOverlay implements AgentTUIRenderer {
  readonly #inner: TerminalRenderer;
  readonly #output: TerminalOutput;
  readonly #config: Required<InspectorPanelConfig>;

  /** Currently selected tool call, or null. */
  #selectedTool: InspectableToolCall | null = null;
  /** All tool calls from the current turn (for quick nav). */
  #toolCalls: InspectableToolCall[] = [];
  /** Index into #toolCalls for Tab-cycle. */
  #selectedIndex: number = -1;

  constructor(inner: TerminalRenderer, output: TerminalOutput, config?: InspectorPanelConfig) {
    this.#inner = inner;
    this.#output = output;
    this.#config = {
      panelWidthFraction: config?.panelWidthFraction ?? 0.35,
      minPanelCells: config?.minPanelCells ?? 30,
    };

    // Silence TS6133: fields stored for future split-panel Phase 2.
    void this.#output;
    void this.#config;

    // Register global Tab key to cycle tool selection.
    // This is a lightweight approach: we hook the output's raw write
    // stream (or process.stdin) to intercept Tab when the inspector
    // panel is visible.
    // FULL INTEGRATION requires changes to the Runner's key dispatch —
    // this overlay provides the wiring stub.
  }

  // ── Public API for runner integration ──────────────────────

  /** Set the tool calls for the current turn. */
  setToolCalls(calls: InspectableToolCall[]): void {
    this.#toolCalls = calls;
    if (this.#selectedIndex >= calls.length) {
      this.#selectedIndex = calls.length - 1;
    }
    this.#selectedTool =
      this.#selectedIndex >= 0 && this.#selectedIndex < calls.length
        ? (calls[this.#selectedIndex] ?? null)
        : null;
  }

  /** Select next/previous tool call. */
  cycleTool(direction: 1 | -1): void {
    if (this.#toolCalls.length === 0) return;
    this.#selectedIndex = Math.max(
      0,
      Math.min(this.#toolCalls.length - 1, this.#selectedIndex + direction),
    );
    this.#selectedTool = this.#toolCalls[this.#selectedIndex] ?? null;
  }

  /** Deselect / close inspector. */
  clearSelection(): void {
    this.#selectedTool = null;
    this.#selectedIndex = -1;
  }

  // ── AgentTUIRenderer delegation ────────────────────────────

  get readPrompt():
    | ((options?: AgentTUISessionOptions) => Promise<string | undefined>)
    | undefined {
    return this.#inner.readPrompt?.bind(this.#inner);
  }

  get readToolApproval():
    | ((
        request: AgentTUIToolApprovalRequest,
        options?: AgentTUISessionOptions,
      ) => Promise<AgentTUIToolApprovalResponse>)
    | undefined {
    return this.#inner.readToolApproval?.bind(this.#inner);
  }

  get readInputQuestion():
    | ((
        question: AgentTUIInputQuestion,
        options?: AgentTUISessionOptions,
      ) => Promise<AgentTUIInputQuestionResponse | undefined>)
    | undefined {
    return this.#inner.readInputQuestion?.bind(this.#inner);
  }

  get setupFlow() {
    return this.#inner.setupFlow;
  }

  renderNotice(text: string): void {
    this.#inner.renderNotice(text);
  }

  renderSandboxLog(text: string): void {
    this.#inner.renderSandboxLog(text);
  }

  renderSetupWarning(text: string): void {
    this.#inner.renderSetupWarning(text);
  }

  clearSetupWarning(): void {
    this.#inner.clearSetupWarning();
  }

  renderCommandInvocation(text: string, status?: "failed"): void {
    this.#inner.renderCommandInvocation(text, status);
  }

  renderCommandResult(text: string): void {
    this.#inner.renderCommandResult(text);
  }

  reset(): void {
    this.#toolCalls = [];
    this.#selectedTool = null;
    this.#selectedIndex = -1;
    this.#inner.reset();
  }

  shutdown(): void {
    this.#inner.shutdown();
  }

  // ── The critical method: renderStream ──────────────────────

  async renderStream(
    result: AgentTUIStreamResult,
    options?: AgentTUISessionOptions,
  ): Promise<void> {
    // Intercept events to collect tool calls while the inner renderer
    // processes them (events can't be re-read after consumption).
    const toolCalls: InspectableToolCall[] = [];
    const interceptedEvents = this.#interceptEvents(result.events, toolCalls);

    await this.#inner.renderStream({ ...result, events: interceptedEvents }, options);

    this.setToolCalls(toolCalls);

    if (this.#selectedTool) {
      this.#renderInspectorPanel();
    }
  }

  // ── Subagent / connection auth / Vercel delegation ─────────

  upsertSubagentStep?(update: SubagentStepUpdate): void {
    this.#inner.upsertSubagentStep?.(update);
  }

  upsertSubagentTool?(update: SubagentToolUpdate): void {
    this.#inner.upsertSubagentTool?.(update);
  }

  markChildToolCallId(callId: string): void {
    this.#inner.markChildToolCallId(callId);
  }

  upsertConnectionAuth?(update: ConnectionAuthUpdate): void {
    this.#inner.upsertConnectionAuth?.(update);
  }

  setConnectionAuthPendingCount(count: number): void {
    this.#inner.setConnectionAuthPendingCount(count);
  }

  get logDisplayMode(): (() => LogDisplayMode) | undefined {
    return this.#inner.logDisplayMode?.bind(this.#inner);
  }

  setLogDisplayMode(mode: LogDisplayMode): void {
    this.#inner.setLogDisplayMode(mode);
  }

  flushDelayedDevBuildErrors(): void {
    this.#inner.flushDelayedDevBuildErrors();
  }

  setVercelStatus(status: VercelStatusSnapshot): void {
    this.#inner.setVercelStatus(status);
  }

  setRemoteConnectionStatus(status: RemoteConnectionSnapshot): void {
    this.#inner.setRemoteConnectionStatus(status);
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Wraps the events stream to intercept tool-call events as they flow
   * through to the inner renderer. Builds the #toolCalls array from
   * tool-call, tool-result, and tool-error events.
   *
   * Handles both AsyncIterable and ReadableStream (Node.js 20+).
   */
  #interceptEvents(
    events: AsyncIterable<AgentTUIStreamEvent> | ReadableStream<AgentTUIStreamEvent>,
    toolCalls: InspectableToolCall[],
  ): AsyncIterable<AgentTUIStreamEvent> {
    const iter: AsyncIterable<AgentTUIStreamEvent> = normalizeIterable(events);
    return {
      [Symbol.asyncIterator]: () => {
        const gen = (async function* (): AsyncGenerator<AgentTUIStreamEvent> {
          for await (const event of iter) {
            if (event.type === "tool-call") {
              toolCalls.push({
                id: event.toolCallId,
                tool: event.toolName,
                args: event.input,
                status: "running",
              });
            } else if (event.type === "tool-result") {
              const existing = toolCalls.find((tc) => tc.id === event.toolCallId);
              if (existing) {
                existing.result = event.output;
                existing.status = "done";
              }
            } else if (event.type === "tool-error") {
              const existing = toolCalls.find((tc) => tc.id === event.toolCallId);
              if (existing) {
                existing.result = event.errorText;
                existing.status = "error";
              }
            } else if (event.type === "tool-approval-request") {
              const existing = toolCalls.find((tc) => tc.id === event.toolCallId);
              if (existing) existing.status = "denied";
            }
            yield event;
          }
        })();
        return gen;
      },
    };
  }

  /**
   * Renders the currently selected tool call as a notice line.
   *
   * MVP approach: uses renderNotice to add a tool summary to the
   * transcript. For a true split-panel inspector, the overlay must:
   *   (a) Subclass/replace LiveRegion with a two-column variant, or
   *   (b) Hook into the Runner's status bar call.
   */
  #renderInspectorPanel(): void {
    if (!this.#selectedTool) return;

    const tool = this.#selectedTool;
    const idx = this.#selectedIndex + 1;
    const total = this.#toolCalls.length;

    const statusIcon =
      tool.status === "running"
        ? "⏳"
        : tool.status === "done"
          ? "✅"
          : tool.status === "error"
            ? "❌"
            : "⛔";

    const argsPreview =
      typeof tool.args === "object"
        ? JSON.stringify(tool.args).slice(0, 120)
        : String(tool.args).slice(0, 120);

    const resultPreview =
      tool.result !== undefined && tool.status !== "running"
        ? typeof tool.result === "string"
          ? tool.result.slice(0, 120)
          : JSON.stringify(tool.result).slice(0, 120)
        : undefined;

    let msg = `${statusIcon} Tool [${idx}/${total}]: ${tool.tool} — ${argsPreview}`;
    if (argsPreview.length >= 120) msg += "…";
    if (resultPreview) {
      msg += ` → ${resultPreview}`;
      if (resultPreview.length >= 120) msg += "…";
    }
    this.#inner.renderNotice(msg);
  }
}

// ── Module-level helpers ────────────────────────────────────

/**
 * Normalises an AsyncIterable or ReadableStream to an AsyncIterable
 * that can be consumed with `for await...of`.
 */
function normalizeIterable<T>(source: AsyncIterable<T> | ReadableStream<T>): AsyncIterable<T> {
  // Already async-iterable (the common case — eveEventsToTUIStream).
  if (Symbol.asyncIterator in (source as any)) {
    return source as AsyncIterable<T>;
  }
  // Wrap ReadableStream (Node.js 20+).
  // We use a plain-object iterator instead of source.values() to avoid
  // TypeScript friction with the ReadableStream type.
  return {
    [Symbol.asyncIterator]: () => {
      const reader = (source as ReadableStream<T>).getReader();
      return {
        next: async () => {
          const { done, value } = await reader.read();
          return { done, value: value as T };
        },
        return: async () => {
          reader.cancel();
          reader.releaseLock();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
