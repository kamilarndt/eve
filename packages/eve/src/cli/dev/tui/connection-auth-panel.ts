import type { Theme } from "./theme.js";
import { stripTerminalControls, wrapVisibleLine } from "./terminal-text.js";
import { renderFlowPanelStatus, type FlowPanelIndicator } from "./setup-panel.js";

export interface ConnectionAuthPanelState {
  name: string;
  url?: string;
  userCode?: string;
  expiresAt?: string;
  instructions?: string;
  cancelFocused: boolean;
  cancelling: boolean;
  indicator: FlowPanelIndicator;
  now: number;
}

function remainingSeconds(expiresAt: string | undefined, now: number): number | undefined {
  if (expiresAt === undefined) return undefined;
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) return undefined;
  return Math.max(0, Math.ceil((expiration - now) / 1_000));
}

function indentedRows(
  text: string,
  indent: string,
  width: number,
  style: (line: string) => string,
): string[] {
  return wrapVisibleLine(stripTerminalControls(text), Math.max(1, width - indent.length)).map(
    (line) => `${indent}${style(line)}`,
  );
}

export function renderConnectionAuthPanel(
  state: ConnectionAuthPanelState,
  theme: Theme,
  width: number,
): string[] {
  const c = theme.colors;
  const name = stripTerminalControls(state.name);
  const remaining = remainingSeconds(state.expiresAt, state.now);
  const countdown = remaining === undefined ? "" : ` ${remaining}s`;
  const status = renderFlowPanelStatus(
    {
      kind: "external-action",
      text: `Waiting for authorization in the browser${theme.glyph.ellipsis}${countdown}`,
      emphasis: "browser",
      indicator: state.indicator,
    },
    theme,
  );
  const rows = [
    c.dim(theme.glyph.hrule.repeat(Math.max(1, width))),
    `   Authorization required for ${c.bold(name)}`,
    "",
    `   ${status}`,
  ];

  if (state.url !== undefined) {
    const url = stripTerminalControls(state.url).replace(/[\t\n]/gu, "");
    rows.push(`     ${c.dim(url)}`);
  }
  if (state.userCode !== undefined) {
    rows.push("", `     Code: ${c.bold(stripTerminalControls(state.userCode))}`);
  }
  if (state.instructions !== undefined) {
    rows.push("", ...indentedRows(state.instructions, "     ", width, c.dim));
  }

  const marker = state.cancelFocused ? c.cyan(theme.glyph.pointer) : c.dim(theme.glyph.option);
  const cancelLabel = state.cancelling ? "Cancelling…" : "Cancel";
  const label = state.cancelFocused ? c.cyan(cancelLabel) : cancelLabel;
  rows.push("", `   ${marker} ${label}`);
  return rows;
}
