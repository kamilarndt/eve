/**
 * The `shared` store — eve's single source of UI truth, read declaratively by
 * components (the "family 2" pattern). A minimal external store (getState /
 * setState / subscribe), bridged into React via `useShared(selector)` on
 * `useSyncExternalStore` with an `Object.is` bailout, so a component re-renders
 * only when *its* slice changes. Writers call `shared.setState(...)`; nobody
 * pushes setters at components.
 */
import { useSyncExternalStore } from "react";

import type { Block } from "../cli/dev/tui/blocks.js";
import type { LogDisplayMode } from "../cli/dev/tui/log-display-mode.js";
import type {
  AgentTUIAgentHeader,
  AgentTUIInputQuestion,
  AgentTUIInputQuestionResponse,
  AgentTUIToolApprovalRequest,
  AgentTUIToolApprovalResponse,
} from "../cli/dev/tui/runner.js";
import type { VercelStatusSnapshot } from "../cli/dev/tui/vercel-status.js";

/** Which interactive surface currently owns the keyboard. Exactly one at a time;
 * the input router (P3) reads this single slice to decide who consumes a key. */
export type TuiMode = "prompt" | "streaming" | "approval" | "question";

/** One progress line in the setup-flow panel (the `FlowPanelLine` port). */
export interface SetupFlowLine {
  text: string;
  tone: "info" | "success" | "warning" | "error";
  /** Subprocess output a warning/error pulled in as its evidence; survives the
   * panel close alongside the diagnostic it explains. */
  evidence?: boolean;
}

/**
 * The open interactive question inside a setup flow. The renderer's `setupFlow`
 * read methods set this and drive its cursor/text via the keyboard rendezvous;
 * `<FlowPanel>` renders it. A discriminated union over the read kind.
 */
export type SetupFlowQuestion =
  | {
      kind: "select";
      message: string;
      options: ReadonlyArray<{ label: string; value: string; disabled?: boolean }>;
      cursor: number;
      multi: boolean;
      selected: readonly string[];
    }
  | {
      kind: "text";
      message: string;
      text: string;
      cursor: number;
      mask: boolean;
      placeholder?: string;
      error?: string;
    }
  | { kind: "acknowledge"; message: string; lines: readonly string[] }
  | {
      kind: "choice";
      status: string;
      context: string;
      actions: ReadonlyArray<{ label: string; value: string }>;
      cursor: number;
    };

/** The live setup-flow panel (`begin`→`end`); undefined when no flow runs. */
export interface SetupFlowState {
  title: string;
  lines: SetupFlowLine[];
  status?: string;
  /** Latest subprocess line, shown transiently beneath the status. */
  preview?: string;
  /** The open interactive read, when one is awaiting input. */
  question?: SetupFlowQuestion;
}

/**
 * A pending tool-approval the UI renders and resolves. `request` is the raw
 * runner payload (the modal owns presentation, as `<Transcript>` owns `Block`);
 * `resolve` settles the promise the renderer is awaiting in `readToolApproval`.
 * `cursor` is the highlighted choice (0 = approve, 1 = deny).
 */
export interface PendingApproval {
  request: AgentTUIToolApprovalRequest;
  cursor: number;
  resolve: (response: AgentTUIToolApprovalResponse) => void;
}

/**
 * A pending input question. `request` is the raw payload; `text`/`cursor` back
 * the freeform editor, `optionCursor` indexes `request.options` for select.
 * `resolve(undefined)` is the cancel path (matches `readInputQuestion`'s type).
 */
export interface PendingQuestion {
  request: AgentTUIInputQuestion;
  text: string;
  cursor: number;
  optionCursor: number;
  resolve: (response: AgentTUIInputQuestionResponse | undefined) => void;
}

/** The TUI state slice, grown across phases. P3 adds the transcript, header,
 * interactive mode, and the pending approval/question rendezvous. */
export interface TuiState {
  /** Which surface owns input. Defaults to "prompt". */
  mode: TuiMode;
  /** Startup/agent header, pushed via `renderAgentHeader`. */
  header?: AgentTUIAgentHeader;
  /** The whole conversation, in order. `<Transcript>` renders it verbatim. */
  blocks: Block[];
  /** Resolved model slug, e.g. "anthropic/claude-sonnet-4-6". */
  model?: string;
  /** Preformatted token-flow segment (e.g. from formatTokenFlow). */
  tokens?: string;
  /** Workspace-scoped Vercel link identity + pending-deploy flag. */
  vercel?: VercelStatusSnapshot;
  /** Live prompt input: the logical line text and the caret's index within it. */
  input?: { text: string; cursor: number };
  /** Set iff `mode === "approval"`. */
  approval?: PendingApproval;
  /** Set iff `mode === "question"`. */
  question?: PendingQuestion;
  /** Count of connections awaiting OAuth callback; > 0 overrides the status
   * line with a "waiting for connection authorization" hint. */
  connectionAuthPending?: number;
  /** The clearable setup attention line (`⚠ … · /login`), shown above the
   * prompt; cleared via `clearSetupWarning` when its issue resolves. */
  setupWarning?: string;
  /** Which captured log sources the transcript shows (the `/loglevel` mode). */
  logs?: LogDisplayMode;
  /** The live setup-flow panel; set between `setupFlow.begin` and `end`. */
  setupFlow?: SetupFlowState;
}

export interface Store<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state);
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The process-wide UI store. */
export const shared: Store<TuiState> = createStore<TuiState>({ mode: "prompt", blocks: [] });

/** Subscribe to a slice of the shared store; re-renders only when the selected
 * value changes (`Object.is`). */
export function useShared<S>(selector: (state: TuiState) => S): S {
  const snapshot = () => selector(shared.getState());
  return useSyncExternalStore(shared.subscribe, snapshot, snapshot);
}

/** Component-local state. Alias of React's useState, named to match the
 * authoring vocabulary (`shared` for global, `useLocal` for local). */
export { useState as useLocal } from "react";
