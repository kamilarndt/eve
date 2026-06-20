import type {
  AssistantResponseStatsMode,
  LogDisplayMode,
  TerminalPartDisplayMode,
  TuiDisplayOptions,
} from "./types.js";

interface TuiCliOptions {
  readonly assistantResponseStats?: AssistantResponseStatsMode;
  readonly connectionAuth?: TerminalPartDisplayMode;
  readonly contextSize?: number;
  readonly logs?: LogDisplayMode;
  readonly reasoning?: TerminalPartDisplayMode;
  readonly subagents?: TerminalPartDisplayMode;
  readonly tools?: TerminalPartDisplayMode;
}

/** Resolves TUI display flags and their CLI defaults. */
export function resolveTuiDisplayOptions(options: TuiCliOptions): TuiDisplayOptions {
  const display: TuiDisplayOptions = {
    logs: options.logs ?? "stderr",
    reasoning: options.reasoning ?? "full",
    tools: options.tools ?? "auto-collapsed",
  };

  if (options.subagents !== undefined) display.subagents = options.subagents;
  if (options.connectionAuth !== undefined) display.connectionAuth = options.connectionAuth;
  if (options.assistantResponseStats !== undefined) {
    display.assistantResponseStats = options.assistantResponseStats;
  }
  if (options.contextSize !== undefined) display.contextSize = options.contextSize;
  return display;
}
