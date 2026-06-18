/**
 * `ReactRenderer implements AgentTUIRenderer` — the P3 adapter that lets the
 * declarative React TUI satisfy the runner's imperative renderer contract
 * (`cli/dev/tui/runner.ts`). It translates the runner's calls into writes on the
 * `shared` store and drives frames through the cell runtime; the components
 * (`<Main>`) read the store and render. It is selected behind `EVE_TUI=react` in
 * the runner's `createRenderer` factory; the default stays `TerminalRenderer`.
 *
 * Two responsibilities the React layer doesn't own on its own:
 *  - **Frames.** Store writes don't auto-commit in this runtime (the same reason
 *    tests call `flush()`); every store mutation here is followed by `#render()`,
 *    which re-runs the container so `useShared` picks up the new slice.
 *  - **Keys.** The runtime only writes; it never reads input. This adapter owns
 *    the input loop (raw mode + `nextKey` decode via {@link createInput}) and a
 *    single `#consumeKey` rendezvous — the interactive reads install a closure on
 *    it and the resolving key clears it, mirroring `TerminalRenderer`'s pattern.
 *
 * Scope: the core turn loop (prompt → stream → tool → approval/question → result)
 * plus header, status model, notices, reset, and shutdown. The optional contract
 * members not yet ported (subagent/connection-auth out-of-band updates, log
 * display capture, setup flow) are intentionally omitted — they are `?` on the
 * interface, so the runner's optional-chained calls skip them until a later phase.
 */
import { createElement } from "react";

import type { Block } from "../cli/dev/tui/blocks.js";
import type { ChannelSetupChoice, ChannelSetupChoiceOptions } from "#setup/cli/index.js";

import { interruptedError } from "../cli/dev/tui/errors.js";
import type { LogDisplayMode } from "../cli/dev/tui/log-display-mode.js";
import type {
  SetupEditableSelectResult,
  SetupFlowRenderer,
  SetupSelectRequest,
} from "../cli/dev/tui/setup-flow.js";
import {
  applyLineEditorKey,
  EMPTY_LINE,
  type LineState,
  lineOf,
} from "../cli/dev/tui/line-editor.js";
import type {
  AgentTUIAgentHeader,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIRenderer,
  AgentTUISessionOptions,
  AgentTUIStreamEvent,
  AgentTUIStreamResult,
  AgentTUIStreamUsage,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
  ConnectionAuthUpdate,
  SubagentStepUpdate,
  SubagentToolUpdate,
} from "../cli/dev/tui/runner.js";
import { formatTokenFlow } from "../cli/dev/tui/stream-format.js";
import { stripTerminalControls } from "../cli/dev/tui/terminal-text.js";
import type { TerminalInput, TerminalOutput } from "../cli/dev/tui/terminal-io.js";
import type { TerminalKey } from "../cli/dev/tui/stream-format.js";
import { summarizeToolArgs, summarizeToolResult } from "../cli/dev/tui/tool-format.js";
import type { TerminalPartDisplayMode } from "../cli/dev/tui/types.js";
import type { VercelStatusSnapshot } from "../cli/dev/tui/vercel-status.js";

import { Main } from "./components/main.js";
import { glyph } from "./components/primitives.js";
import type { SetupFlowQuestion, SetupFlowState } from "./store.js";
import { createInput, type Input, type InputStream } from "./input.js";
import { render, type RenderHandle } from "./runtime.js";
import { shared } from "./store.js";
import { StreamFold } from "./stream-fold.js";

export interface ReactRendererOptions {
  tools?: TerminalPartDisplayMode;
  reasoning?: TerminalPartDisplayMode;
  subagents?: TerminalPartDisplayMode;
  connectionAuth?: TerminalPartDisplayMode;
  contextSize?: number;
  logs?: LogDisplayMode;
  /** Capture the dev server's stdout/stderr into `log`/`sandbox` blocks (the
   * `#installLogCapture` analogue). Off by default so unit tests don't patch the
   * global streams; the production entry (`tui.ts`) turns it on. */
  captureForeignOutput?: boolean;
  input?: TerminalInput;
  output?: TerminalOutput;
}

/** Extract a renderable sandbox line, dropping non-sandbox and low-value lines
 * (mirrors `parseSandboxLogLine` / `isLowValueSandboxLogLine`). */
function parseSandboxLogLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("Eve: ")) return undefined;
  const message = trimmed.slice("Eve: ".length);
  if (!/\bsandbox\b/i.test(message)) return undefined;
  const lowValue =
    /^initializing (?:\d+ )?sandbox templates?\b/i.test(message) ||
    /^initialized \d+ sandbox\b/i.test(message) ||
    /^reused cached sandbox template\b/i.test(message) ||
    /^sandbox template "[^"]+" \([^)]+\): (checking|reusing|loading microsandbox runtime|microsandbox runtime ready)\b/i.test(
      message,
    );
  return lowValue ? undefined : message;
}

/** Normalize the stream union (`AsyncIterable | ReadableStream`) to a single
 * async iterator, mirroring the runner's `iterateTUIStream`. */
async function* iterate(
  events: AgentTUIStreamResult["events"],
): AsyncGenerator<AgentTUIStreamEvent> {
  if (Symbol.asyncIterator in events) {
    yield* events as AsyncIterable<AgentTUIStreamEvent>;
    return;
  }
  const reader = (events as ReadableStream<AgentTUIStreamEvent>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Cap on the setup-flow evidence ring (mirrors `FLOW_OUTPUT_BUFFER_CAP`). */
const SETUP_OUTPUT_CAP = 40;

/** Build a connection-auth block body — description, challenge fields, reason —
 * each line stripped of control sequences (mirrors `formatConnectionAuthContent`). */
function formatConnectionAuthContent(update: ConnectionAuthUpdate): string {
  const lines: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && value.trim().length > 0) lines.push(stripTerminalControls(value));
  };
  push(update.description);
  if (update.challenge?.url) lines.push(`URL: ${stripTerminalControls(update.challenge.url)}`);
  if (update.challenge?.userCode)
    lines.push(`Code: ${stripTerminalControls(update.challenge.userCode)}`);
  if (update.challenge?.expiresAt)
    lines.push(`Expires: ${stripTerminalControls(update.challenge.expiresAt)}`);
  push(update.challenge?.instructions);
  if (update.reason) lines.push(`Reason: ${stripTerminalControls(update.reason)}`);
  return lines.join("\n");
}

/** Map a subagent tool's lifecycle status onto the shared `ToolStatus` the
 * `<ToolCall>` component renders (mirrors `subagentToolStatus`). */
function subagentToolStatus(status: SubagentToolUpdate["status"]): Block["status"] {
  switch (status) {
    case "approval-requested":
      return "approval";
    case "executing":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "error";
  }
}

export class ReactRenderer implements AgentTUIRenderer {
  readonly #fold: StreamFold;
  readonly #reasoning: TerminalPartDisplayMode;
  readonly #subagents: TerminalPartDisplayMode;
  readonly #connectionAuth: TerminalPartDisplayMode;
  readonly #contextSize: number | undefined;
  readonly #handle: RenderHandle;
  readonly #input: Input;
  #width: number;
  /** The current keyboard consumer; exactly one interactive read owns it. */
  #consumeKey: ((key: TerminalKey) => void) | undefined;
  /** Keys received before a consumer is armed (e.g. fast/piped stdin or a typed
   * line arriving before the runner calls `readPrompt`). Replayed in order the
   * moment a consumer arms, so no input is ever dropped. */
  readonly #keyQueue: TerminalKey[] = [];
  /** Subagent dispatch ids whose header block has been pushed (one per run). */
  readonly #subagentHeaders = new Set<string>();
  /** Last-known token usage, retained across reports like `#applyUsage`. */
  #inputTokens = 0;
  #outputTokens = 0;
  /** Recent subprocess output, pulled in as evidence under a warning/error. */
  readonly #setupOutputBuffer: string[] = [];
  /** The setup-flow surface (`/setup`-family commands). Built once so the
   * runner's `context.renderer.setupFlow` is a stable reference. */
  readonly setupFlow: SetupFlowRenderer;
  /** Saved original `process.stdout.write`, captured before any foreign-output
   * patch. Frames are written through this so they bypass the capture (they are
   * NOT log lines), keeping the same-process dev-server output the only thing
   * captured — the production analogue of the smoke harness's separate output. */
  readonly #origStdoutWrite: typeof process.stdout.write;
  /** Restores `process.stdout`/`stderr.write` when foreign capture is active. */
  #restoreCapture: (() => void) | undefined;
  #stdoutLogBuffer = "";
  #stderrLogBuffer = "";

  constructor(options: ReactRendererOptions = {}) {
    this.#reasoning = options.reasoning ?? "auto-collapsed";
    this.#subagents = options.subagents ?? "auto-collapsed";
    this.#connectionAuth = options.connectionAuth ?? "auto-collapsed";
    this.#contextSize = options.contextSize;
    this.#fold = new StreamFold({ reasoning: this.#reasoning });

    // Seed the log display mode so the transcript filter has a value to read.
    shared.setState((s) => ({ ...s, logs: options.logs ?? "all" }));

    // Capture the real stdout writer up front, then (optionally) patch stdout/
    // stderr for foreign-output capture. Frames go to an explicit `output` when
    // one is injected (tests), else to a sink backed by the saved writer so they
    // never re-enter the capture path.
    this.#origStdoutWrite = process.stdout.write.bind(process.stdout);
    if (options.captureForeignOutput) this.#installLogCapture();

    const frameSink: TerminalOutput = options.output ?? this.#stdoutFrameSink();
    this.#width = frameSink.columns ?? 80;
    this.#handle = render(createElement(Main, { width: this.#width }), { stdout: frameSink });

    const stream: InputStream = options.input ?? (process.stdin as unknown as InputStream);
    this.#input = createInput(stream);
    this.#input.onAnyKey((key) => this.#routeKey(key));

    this.setupFlow = this.#createSetupFlow();
  }

  /** A frame sink over the real terminal that writes through the saved
   * `process.stdout.write`, so painting bypasses any foreign-output capture. */
  #stdoutFrameSink(): TerminalOutput {
    const write = this.#origStdoutWrite;
    return {
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      write: (chunk: string | Uint8Array) => write(chunk as never),
      on: () => this.#stdoutFrameSink(),
      off: () => this.#stdoutFrameSink(),
    } as unknown as TerminalOutput;
  }

  /** Re-run the container so `useShared` reads the latest store slices. */
  #render(): void {
    this.#handle.update(createElement(Main, { width: this.#width }));
  }

  /** Route a decoded key: deliver to the current consumer, or buffer it until one
   * arms (so input typed before `readPrompt`/a modal is never lost). */
  #routeKey(key: TerminalKey): void {
    if (this.#consumeKey) this.#consumeKey(key);
    else this.#keyQueue.push(key);
  }

  /** Install the keyboard consumer and immediately drain any buffered keys into
   * it, in arrival order. The consumer may clear itself mid-drain (e.g. `enter`
   * resolves a read), so the loop re-checks `#consumeKey` each step. */
  #armConsumer(consumer: (key: TerminalKey) => void): void {
    this.#consumeKey = consumer;
    while (this.#keyQueue.length > 0 && this.#consumeKey) {
      this.#consumeKey(this.#keyQueue.shift()!);
    }
  }

  /** Copy the fold's transcript into the store and paint a frame. */
  #commitBlocks(): void {
    const blocks = [...this.#fold.blocks];
    shared.setState((s) => ({ ...s, blocks }));
    this.#render();
  }

  #setInput(line: LineState): void {
    shared.setState((s) => ({ ...s, input: { text: line.text, cursor: line.cursor } }));
    this.#render();
  }

  // --- stream ---

  /** Fold a usage report into the status-line token segment, retaining the
   * last-known value per side (mirrors `#applyUsage`). */
  #applyUsage(usage: AgentTUIStreamUsage | undefined): void {
    if (!usage) return;
    this.#inputTokens = usage.inputTokens ?? this.#inputTokens;
    this.#outputTokens = usage.outputTokens ?? this.#outputTokens;
    if (this.#inputTokens === 0 && this.#outputTokens === 0) return;
    const tokens = formatTokenFlow(
      {
        inputTokens: this.#inputTokens,
        outputTokens: this.#outputTokens,
        ...(this.#contextSize !== undefined ? { contextSize: this.#contextSize } : {}),
      },
      glyph,
    );
    shared.setState((s) => ({ ...s, tokens }));
  }

  async renderStream(result: AgentTUIStreamResult): Promise<void> {
    shared.setState((s) => ({ ...s, mode: "streaming", input: undefined }));
    this.#render();
    try {
      for await (const event of iterate(result.events)) {
        if (event.type === "step-finish" || event.type === "finish") {
          this.#applyUsage(event.usage);
        }
        this.#fold.apply(event);
        this.#commitBlocks();
      }
    } finally {
      this.#fold.finalize();
      this.#commitBlocks();
    }
  }

  // --- interactive reads (promise rendezvous via #consumeKey) ---

  readPrompt(options?: AgentTUISessionOptions): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      let line = lineOf(options?.initialDraft ?? "");
      shared.setState((s) => ({ ...s, mode: "prompt" }));
      this.#setInput(line);

      this.#armConsumer((key) => {
        if (key.type === "enter") {
          const text = line.text;
          if (text.trim().length === 0) return; // ignore empty submit
          this.#consumeKey = undefined;
          this.#fold.append({ kind: "user", body: text });
          shared.setState((s) => ({ ...s, mode: "streaming", input: undefined }));
          this.#commitBlocks();
          resolve(text);
          return;
        }
        if (key.type === "ctrl-c" || (key.type === "ctrl-d" && line.text.length === 0)) {
          this.#consumeKey = undefined;
          reject(interruptedError());
          return;
        }
        const next = applyLineEditorKey(line, key);
        if (next) {
          line = next;
          this.#setInput(line);
        }
      });
    });
  }

  readToolApproval(request: AgentTUIToolApprovalRequest): Promise<AgentTUIToolApprovalResponse> {
    return new Promise<AgentTUIToolApprovalResponse>((resolve, reject) => {
      let cursor = 0;
      const open = (): void => {
        shared.setState((s) => ({
          ...s,
          mode: "approval",
          approval: { request, cursor, resolve: () => {} },
        }));
        this.#render();
      };
      const settle = (response: AgentTUIToolApprovalResponse): void => {
        this.#consumeKey = undefined;
        if (!response.approved) this.#fold.denyTool(request.toolCallId);
        shared.setState((s) => ({ ...s, mode: "streaming", approval: undefined }));
        this.#commitBlocks();
        resolve(response);
      };
      open();
      this.#armConsumer((key) => {
        if (key.type === "character" && key.value === "y") return settle({ approved: true });
        if (key.type === "character" && key.value === "n")
          return settle({ approved: false, reason: "Denied by user." });
        if (key.type === "left" || key.type === "right") {
          cursor = cursor === 0 ? 1 : 0;
          open();
          return;
        }
        if (key.type === "enter")
          return settle(
            cursor === 0 ? { approved: true } : { approved: false, reason: "Denied by user." },
          );
        if (key.type === "ctrl-c") {
          this.#consumeKey = undefined;
          reject(interruptedError());
        }
      });
    });
  }

  readInputQuestion(
    question: AgentTUIInputQuestion,
  ): Promise<AgentTUIInputQuestionResponse | undefined> {
    return new Promise<AgentTUIInputQuestionResponse | undefined>((resolve, reject) => {
      const options = question.options ?? [];
      let optionCursor = 0;
      let line = EMPTY_LINE;
      const open = (): void => {
        shared.setState((s) => ({
          ...s,
          mode: "question",
          question: {
            request: question,
            text: line.text,
            cursor: line.cursor,
            optionCursor,
            resolve: () => {},
          },
        }));
        this.#render();
      };
      const settle = (response: AgentTUIInputQuestionResponse | undefined): void => {
        this.#consumeKey = undefined;
        shared.setState((s) => ({ ...s, mode: "streaming", question: undefined }));
        this.#render();
        resolve(response);
      };
      open();
      this.#armConsumer((key) => {
        if (key.type === "ctrl-c") {
          this.#consumeKey = undefined;
          reject(interruptedError());
          return;
        }
        if (key.type === "escape") return settle(undefined);
        if (question.display === "select") {
          if (key.type === "up") {
            optionCursor = (optionCursor - 1 + options.length) % options.length;
            open();
          } else if (key.type === "down") {
            optionCursor = (optionCursor + 1) % options.length;
            open();
          } else if (key.type === "enter") {
            settle({ optionId: options[optionCursor]?.id });
          }
          return;
        }
        // text mode
        if (key.type === "enter") return settle({ text: line.text });
        const next = applyLineEditorKey(line, key);
        if (next) {
          line = next;
          open();
        }
      });
    });
  }

  // --- out-of-band store writes ---

  renderAgentHeader(header: AgentTUIAgentHeader): void {
    const model = header.info?.agent.model.id;
    shared.setState((s) => ({ ...s, header, model: model ?? s.model }));
    this.#render();
  }

  renderNotice(text: string): void {
    this.#fold.append({ kind: "notice", body: text });
    this.#commitBlocks();
  }

  renderCommandResult(text: string): void {
    // A slash-command outcome reads as a `⎿`-elbow result line under the echo,
    // mirroring `TerminalRenderer.renderCommandResult` (not a plain notice).
    this.#fold.append({ kind: "result", body: text });
    this.#commitBlocks();
  }

  renderSandboxLog(text: string): void {
    const message = parseSandboxLogLine(text);
    if (message === undefined) return; // non-sandbox / low-value line, dropped
    this.#fold.append({ kind: "sandbox", body: message });
    this.#commitBlocks();
  }

  logDisplayMode(): LogDisplayMode {
    return shared.getState().logs ?? "all";
  }

  setLogDisplayMode(mode: LogDisplayMode): void {
    // Captured log/sandbox blocks stay in the transcript; the filter is applied
    // at read time (see log-filter.ts), so a mode switch is retroactive.
    shared.setState((s) => ({ ...s, logs: mode }));
    this.#render();
  }

  markChildToolCallId(callId: string): void {
    this.#fold.markChildToolCall(callId);
    this.#commitBlocks();
  }

  // --- subagent out-of-band updates ---

  /** Push the `◆ <name> subagent` header once per dispatch (one per callId),
   * mirroring `#ensureSubagentHeader`. */
  #ensureSubagentHeader(callId: string, name: string): void {
    if (this.#subagentHeaders.has(callId)) return;
    this.#subagentHeaders.add(callId);
    this.#fold.append({
      kind: "subagent",
      id: `subagent:${callId}:header`,
      title: stripTerminalControls(name),
      live: false,
    });
  }

  upsertSubagentStep(update: SubagentStepUpdate): void {
    if (this.#subagents === "hidden") return;
    const reasoning = stripTerminalControls(update.reasoning).trim();
    const message = stripTerminalControls(update.message).trim();
    if (reasoning.length === 0 && message.length === 0) return;
    this.#ensureSubagentHeader(update.callId, update.subagentName);
    if (this.#subagents === "collapsed") return this.#render();
    this.#fold.upsertBlock({
      kind: "subagent-step",
      id: `subagent:${update.callId}:step:${update.sectionKey}`,
      depth: 1,
      reasoning,
      body: message,
      live: !update.finalized,
    });
    this.#commitBlocks();
  }

  upsertSubagentTool(update: SubagentToolUpdate): void {
    if (this.#subagents === "hidden") return;
    this.#ensureSubagentHeader(update.callId, update.subagentName);
    if (this.#subagents === "collapsed") return this.#render();
    const status = subagentToolStatus(update.status);
    const block: Block = {
      kind: "subagent-tool",
      id: `subagent:${update.callId}:tool:${update.childCallId}`,
      depth: 1,
      title: stripTerminalControls(update.toolName),
      subtitle: summarizeToolArgs(update.input),
      status,
      live: status === "running" || status === "approval",
      expanded: this.#subagents === "full",
      toolInput: update.input,
    };
    if (update.output !== undefined) {
      block.result = summarizeToolResult(update.output);
      block.toolOutput = update.output;
    } else if (update.errorText !== undefined) {
      block.result = stripTerminalControls(update.errorText);
    }
    this.#fold.upsertBlock(block);
    this.#commitBlocks();
  }

  // --- connection authorization ---

  upsertConnectionAuth(update: ConnectionAuthUpdate): void {
    if (this.#connectionAuth === "hidden") return;
    const terminal =
      update.state === "authorized" ||
      update.state === "declined" ||
      update.state === "failed" ||
      update.state === "timed-out";
    this.#fold.upsertBlock({
      kind: "connection-auth",
      id: `connection-auth:${update.name}`,
      title: `${stripTerminalControls(update.name)} · authorization · ${update.state}`,
      body: formatConnectionAuthContent(update),
      preformatted: true,
      live: !terminal,
    });
    this.#commitBlocks();
  }

  setConnectionAuthPendingCount(count: number): void {
    const pending = Math.max(0, count);
    shared.setState((s) => ({ ...s, connectionAuthPending: pending }));
    this.#render();
  }

  // --- setup attention line ---

  renderSetupWarning(text: string): void {
    const content = stripTerminalControls(text);
    if (content.trim().length === 0) return this.clearSetupWarning();
    shared.setState((s) => ({ ...s, setupWarning: content }));
    this.#render();
  }

  clearSetupWarning(): void {
    shared.setState((s) => (s.setupWarning === undefined ? s : { ...s, setupWarning: undefined }));
    this.#render();
  }

  setVercelStatus(status: VercelStatusSnapshot): void {
    shared.setState((s) => ({ ...s, vercel: status }));
    this.#render();
  }

  reset(): void {
    this.#fold.reset();
    this.#subagentHeaders.clear();
    this.#inputTokens = 0;
    this.#outputTokens = 0;
    this.#setupOutputBuffer.length = 0;
    shared.setState((s) => ({
      ...s,
      blocks: [],
      mode: "prompt",
      approval: undefined,
      question: undefined,
      input: undefined,
      connectionAuthPending: 0,
      setupWarning: undefined,
      setupFlow: undefined,
      tokens: undefined,
    }));
    this.#render();
  }

  // --- setup flow (the `/setup`-family panel + interactive reads) ---

  /** Patch the open flow panel, if any, and paint. */
  #flowPatch(patch: (flow: SetupFlowState) => SetupFlowState): void {
    shared.setState((s) => (s.setupFlow ? { ...s, setupFlow: patch(s.setupFlow) } : s));
    this.#render();
  }

  /** Set the open question slice (or clear it) and paint. */
  #flowSetQuestion(question: SetupFlowQuestion | undefined): void {
    this.#flowPatch((flow) => ({ ...flow, question }));
  }

  /** Clear the rendezvous + the open question after a read settles. */
  #flowSettle(): void {
    this.#consumeKey = undefined;
    this.#flowSetQuestion(undefined);
  }

  #createSetupFlow(): SetupFlowRenderer {
    return {
      begin: (title) => {
        this.#setupOutputBuffer.length = 0;
        shared.setState((s) => ({ ...s, setupFlow: { title, lines: [] } }));
        this.#render();
      },
      end: (options) => {
        const flow = shared.getState().setupFlow;
        shared.setState((s) => ({ ...s, setupFlow: undefined }));
        if (flow && (options?.preserveDiagnostics ?? true)) {
          // Commit only diagnostics: each warning/error line, preceded by the
          // evidence run it explains. Plain progress lines were transient.
          let evidence: string[] = [];
          for (const line of flow.lines) {
            if (line.evidence) {
              evidence.push(line.text);
              continue;
            }
            if (line.tone === "warning" || line.tone === "error") {
              if (evidence.length > 0)
                this.#fold.append({ kind: "flow", title: "info", body: evidence.join("\n") });
              this.#fold.append({ kind: "flow", title: line.tone, body: line.text });
            }
            evidence = [];
          }
        }
        this.#commitBlocks();
      },
      renderLine: (text, tone) => {
        const content = stripTerminalControls(text);
        if (!shared.getState().setupFlow) {
          this.#fold.append({ kind: "flow", title: tone, body: content });
          this.#commitBlocks();
          return;
        }
        this.#flowPatch((flow) => {
          const lines = [...flow.lines];
          if (tone === "warning" || tone === "error") {
            for (const buffered of this.#setupOutputBuffer)
              lines.push({ text: buffered, tone: "info", evidence: true });
            this.#setupOutputBuffer.length = 0;
          }
          lines.push({ text: content, tone });
          return { ...flow, lines, preview: undefined };
        });
      },
      renderOutput: (text) => {
        const content = stripTerminalControls(text);
        if (!shared.getState().setupFlow) return this.setupFlow.renderLine(content, "info");
        this.#setupOutputBuffer.push(content);
        if (this.#setupOutputBuffer.length > SETUP_OUTPUT_CAP) this.#setupOutputBuffer.shift();
        this.#flowPatch((flow) => ({ ...flow, preview: content }));
      },
      setStatus: (text) => {
        const status = text === undefined ? undefined : stripTerminalControls(text);
        this.#flowPatch((flow) => ({
          ...flow,
          status,
          ...(status === undefined ? { preview: undefined } : {}),
        }));
      },
      readSelect: (request) => this.#flowReadSelect(request),
      readText: (request) => this.#flowReadText(request),
      readAcknowledge: (request) => this.#flowReadAcknowledge(request),
      readEditableSelect: (request) => this.#flowReadEditableSelect(request),
      readChoice: (options) => this.#flowReadChoice(options),
      waitForInterrupt: () => this.#flowWaitForInterrupt(),
    };
  }

  #flowReadSelect(request: SetupSelectRequest): Promise<readonly string[] | undefined> {
    const multi = request.kind === "multi" || request.kind === "searchable-multi";
    const options = request.options.map((option) => ({
      label: option.label,
      value: option.value,
      disabled: option.disabled,
    }));
    return new Promise<readonly string[] | undefined>((resolve, reject) => {
      let cursor = 0;
      let selected: string[] =
        request.kind === "multi" || request.kind === "searchable-multi"
          ? [...(request.initialValues ?? [])]
          : [];
      const open = (): void =>
        this.#flowSetQuestion({
          kind: "select",
          message: request.message,
          options,
          cursor,
          multi,
          selected,
        });
      open();
      this.#consumeKey = (key) => {
        if (key.type === "ctrl-c") {
          this.#flowSettle();
          return reject(interruptedError());
        }
        if (key.type === "escape") {
          this.#flowSettle();
          return resolve(undefined);
        }
        if (key.type === "up") {
          cursor = (cursor - 1 + options.length) % options.length;
          open();
        } else if (key.type === "down") {
          cursor = (cursor + 1) % options.length;
          open();
        } else if (multi && key.type === "character" && key.value === " ") {
          const value = options[cursor]?.value;
          if (value !== undefined)
            selected = selected.includes(value)
              ? selected.filter((v) => v !== value)
              : [...selected, value];
          open();
        } else if (key.type === "enter") {
          const value = options[cursor]?.value;
          this.#flowSettle();
          resolve(multi ? selected : value !== undefined ? [value] : []);
        }
      };
    });
  }

  /**
   * Port of `readEditableSelect`. The terminal renderer makes one row a live
   * inline-edit field; the cell select model has no per-row editor, so this
   * keeps the *result* grammar exact (preset → `selected`; the editable row's
   * default → `selected`; an edited value → `edited`) via a two-phase flow:
   * select the row, and if it's the editable one, switch to a text editor. The
   * only difference is one extra keystroke to enter the field.
   */
  #flowReadEditableSelect(request: {
    message: string;
    options: ReadonlyArray<{ label: string; value: string; disabled?: boolean }>;
    initialValue?: string;
    editable: {
      value: string;
      defaultValue: string;
      formatHint: (value: string) => string;
      validate?: (value: string) => string | undefined;
    };
  }): Promise<SetupEditableSelectResult | undefined> {
    const options = request.options.map((option) => ({
      label: option.label,
      value: option.value,
      disabled: option.disabled,
    }));
    return new Promise<SetupEditableSelectResult | undefined>((resolve, reject) => {
      let cursor = Math.max(
        0,
        options.findIndex((option) => option.value === request.initialValue),
      );
      const openSelect = (): void =>
        this.#flowSetQuestion({
          kind: "select",
          message: request.message,
          options,
          cursor,
          multi: false,
          selected: [],
        });
      const enterEditPhase = (value: string): void => {
        let line = lineOf(request.editable.defaultValue);
        const openEdit = (error?: string): void =>
          this.#flowSetQuestion({
            kind: "text",
            message: request.message,
            text: line.text,
            cursor: line.cursor,
            mask: false,
            ...(error !== undefined ? { error } : {}),
          });
        openEdit();
        this.#consumeKey = (key) => {
          if (key.type === "ctrl-c") {
            this.#flowSettle();
            return reject(interruptedError());
          }
          if (key.type === "escape") return installSelect(); // back to the list
          if (key.type === "enter") {
            const text = (line.text || request.editable.defaultValue).trim();
            const invalid = request.editable.validate?.(text);
            if (invalid !== undefined) return openEdit(invalid);
            this.#flowSettle();
            return resolve(
              text === request.editable.defaultValue
                ? { kind: "selected", value }
                : { kind: "edited", value, text },
            );
          }
          const next = applyLineEditorKey(line, key);
          if (next) {
            line = next;
            openEdit();
          }
        };
      };
      const installSelect = (): void => {
        openSelect();
        this.#consumeKey = (key) => {
          if (key.type === "ctrl-c") {
            this.#flowSettle();
            return reject(interruptedError());
          }
          if (key.type === "escape") {
            this.#flowSettle();
            return resolve(undefined);
          }
          if (key.type === "up") {
            cursor = (cursor - 1 + options.length) % options.length;
            openSelect();
          } else if (key.type === "down") {
            cursor = (cursor + 1) % options.length;
            openSelect();
          } else if (key.type === "enter") {
            const value = options[cursor]?.value;
            if (value === undefined) return;
            if (value !== request.editable.value) {
              this.#flowSettle();
              return resolve({ kind: "selected", value });
            }
            enterEditPhase(value); // the editable row → text editor
          }
        };
      };
      installSelect();
    });
  }

  #flowReadText(request: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    mask?: boolean;
    validate?: (value: string) => string | undefined;
  }): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve, reject) => {
      let line = lineOf(request.defaultValue ?? "");
      const open = (error?: string): void =>
        this.#flowSetQuestion({
          kind: "text",
          message: request.message,
          text: line.text,
          cursor: line.cursor,
          mask: request.mask ?? false,
          ...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      open();
      this.#consumeKey = (key) => {
        if (key.type === "ctrl-c") {
          this.#flowSettle();
          return reject(interruptedError());
        }
        if (key.type === "escape") {
          this.#flowSettle();
          return resolve(undefined);
        }
        if (key.type === "enter") {
          const error = request.validate?.(line.text);
          if (error !== undefined) return open(error);
          this.#flowSettle();
          return resolve(line.text);
        }
        const next = applyLineEditorKey(line, key);
        if (next) {
          line = next;
          open();
        }
      };
    });
  }

  #flowReadAcknowledge(request: { message: string; lines: readonly string[] }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#flowSetQuestion({
        kind: "acknowledge",
        message: request.message,
        lines: request.lines,
      });
      this.#consumeKey = (key) => {
        if (key.type === "ctrl-c") {
          this.#flowSettle();
          return reject(interruptedError());
        }
        if (key.type === "enter" || key.type === "escape") {
          this.#flowSettle();
          resolve();
        }
      };
    });
  }

  #flowReadChoice(options: ChannelSetupChoiceOptions): ChannelSetupChoice {
    const actions = options.actions.map((action) => ({ label: action.label, value: action.value }));
    let cursor = 0;
    let settled = false;
    let resolveChoice!: (value: string | undefined) => void;
    const choice = new Promise<string | undefined>((resolve) => {
      resolveChoice = resolve;
    });
    const settle = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      this.#flowSettle();
      resolveChoice(value);
    };
    const open = (): void =>
      this.#flowSetQuestion({
        kind: "choice",
        status: options.status,
        context: options.context,
        actions,
        cursor,
      });
    open();
    this.#consumeKey = (key) => {
      if (key.type === "up") {
        cursor = (cursor - 1 + actions.length) % actions.length;
        open();
      } else if (key.type === "down") {
        cursor = (cursor + 1) % actions.length;
        open();
      } else if (key.type === "enter") {
        settle(actions[cursor]?.value);
      }
    };
    return { choice, close: () => settle(undefined) };
  }

  #flowWaitForInterrupt(): { promise: Promise<void>; dispose(): void } {
    let armed = true;
    const promise = new Promise<void>((resolve) => {
      this.#consumeKey = (key) => {
        if (!armed) return;
        if (key.type === "ctrl-c" || key.type === "escape") {
          this.#consumeKey = undefined;
          resolve();
        }
      };
    });
    return {
      promise,
      dispose: () => {
        armed = false;
        this.#consumeKey = undefined;
      },
    };
  }

  // --- foreign log capture (dev-server stdout/stderr → log/sandbox blocks) ---

  /** Patch `process.stdout`/`stderr.write` to route foreign writes into the
   * transcript. Frames bypass this (they go through `#origStdoutWrite`), so only
   * the dev server's own output is captured. Mirrors `#installLogCapture`. */
  #installLogCapture(): void {
    if (this.#restoreCapture !== undefined) return;
    const patch = (stream: NodeJS.WriteStream, source: "stdout" | "stderr"): (() => void) => {
      const original = stream.write.bind(stream);
      stream.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        const text =
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8");
        this.#handleForeignOutput(source, text);
        done?.();
        return true;
      }) as typeof stream.write;
      return () => {
        stream.write = original;
      };
    };
    const restoreOut = patch(process.stdout, "stdout");
    const restoreErr = patch(process.stderr, "stderr");
    this.#restoreCapture = () => {
      restoreOut();
      restoreErr();
    };
  }

  #removeLogCapture(): void {
    const restore = this.#restoreCapture;
    if (restore === undefined) return;
    this.#restoreCapture = undefined;
    restore();
  }

  /** Line-buffer a foreign write and commit each completed line as its own
   * finalized block (mirrors `#handleForeignOutput`). The trailing partial line
   * is retained until its newline arrives. */
  #handleForeignOutput(source: "stdout" | "stderr", text: string): void {
    const combined = (source === "stdout" ? this.#stdoutLogBuffer : this.#stderrLogBuffer) + text;
    const lastNewline = combined.lastIndexOf("\n");
    const remainder = lastNewline === -1 ? combined : combined.slice(lastNewline + 1);
    if (source === "stdout") this.#stdoutLogBuffer = remainder;
    else this.#stderrLogBuffer = remainder;
    if (lastNewline === -1) return;

    let committed = false;
    for (const raw of combined.slice(0, lastNewline).split("\n")) {
      const content = stripTerminalControls(raw).replace(/\s+$/u, "");
      if (content.trim().length === 0) continue;
      if (source === "stdout") {
        const sandbox = parseSandboxLogLine(content);
        this.#fold.append(
          sandbox !== undefined
            ? { kind: "sandbox", body: sandbox }
            : { kind: "log", title: "stdout", body: content },
        );
      } else {
        this.#fold.append({ kind: "log", title: "stderr", body: content });
      }
      committed = true;
    }
    if (committed) this.#commitBlocks();
  }

  shutdown(): void {
    this.#consumeKey = undefined;
    this.#removeLogCapture();
    this.#input.dispose();
    this.#handle.unmount();
  }
}
