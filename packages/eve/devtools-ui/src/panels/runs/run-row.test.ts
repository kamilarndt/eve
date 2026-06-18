import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RunSession } from "@ui/model/devtools-model";
import { RunRow } from "@ui/panels/runs/run-row";

describe("RunRow", () => {
  it("shows progress only while the agent is working", () => {
    const running = renderRow({ status: "running" });
    const idle = renderRow({ status: "waiting" });

    expect(running).toContain("session-loading-icon");
    expect(running).toContain("Agent is working");
    expect(idle).not.toContain("session-state");
    expect(idle).not.toContain("status-dot");
  });

  it("represents pending input and breakpoint pauses without a spinner", () => {
    const waiting = renderRow({
      pendingAction: { kind: "question", name: "ask_question" },
      status: "waiting",
    });
    const paused = renderRow({ paused: true, status: "running" });

    expect(waiting).toContain("lucide-circle-question-mark");
    expect(waiting).toContain("Waiting for a response: ask_question");
    expect(waiting).not.toContain("session-loading-icon");
    expect(paused).toContain("lucide-circle-pause");
    expect(paused).not.toContain("session-loading-icon");
  });
});

function renderRow(
  input: Pick<RunSession, "status"> &
    Partial<Pick<RunSession, "pendingAction">> & { readonly paused?: boolean },
): string {
  return renderToStaticMarkup(
    createElement(RunRow, {
      onSelect: vi.fn(),
      paused: input.paused,
      run: {
        activity: "Now",
        id: "session-1",
        label: "Weather",
        pendingAction: input.pendingAction,
        revision: "rev-1",
        status: input.status,
        trigger: "message",
      },
      selected: true,
    }),
  );
}
