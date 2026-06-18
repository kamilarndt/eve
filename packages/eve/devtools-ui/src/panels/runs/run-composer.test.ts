import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import type { RunSession } from "@ui/model/devtools-model";
import { RunComposer, shouldSubmitMessage } from "@ui/panels/runs/run-composer";

describe("RunComposer", () => {
  it("accepts a first message before a session is selected", () => {
    const html = renderComposer({ selectedRunId: undefined });

    expect(html).toContain('aria-label="Message your agent"');
    expect(html).toContain('placeholder="Message your agent..."');
    expect(html).not.toContain('<textarea aria-label="Message your agent" disabled');
  });

  it("shows progress while a selected session is reaching an input boundary", () => {
    const html = renderComposer({ selectedRunId: "session-1", selectedRunStatus: "running" });

    expect(html).toContain(
      'placeholder="Agent is running. Waiting for the next input boundary..."',
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Running…");
    expect(html).toContain("disabled");
  });

  it("uses paused-state vocabulary in the disabled composer", () => {
    const html = renderComposer({ runtimeStatus: "paused", selectedRunId: "session-1" });

    expect(html).toContain('placeholder="Paused — resume to send a message."');
    expect(html).toContain("lucide-circle-pause");
    expect(html).not.toContain("composer-loading-icon");
    expect(html).toContain(">Paused</span>");
    expect(html).toContain("disabled");
  });

  it("submits with Enter while preserving Shift+Enter and IME composition", () => {
    expect(shouldSubmitMessage({ isComposing: false, key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitMessage({ isComposing: false, key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitMessage({ isComposing: true, key: "Enter", shiftKey: false })).toBe(false);
  });
});

function renderComposer(input: {
  readonly selectedRunId: string | undefined;
  readonly selectedRunStatus?: "running" | "waiting";
  readonly runtimeStatus?: "paused" | "ready";
}): string {
  const runs: readonly RunSession[] =
    input.selectedRunId === undefined
      ? []
      : [
          {
            activity: "Now",
            id: input.selectedRunId,
            label: "Session",
            revision: "rev-1",
            status: input.selectedRunStatus ?? "waiting",
            trigger: "message" as const,
          },
        ];
  const baseScenario = createPrototypeScenario("empty");
  const controller = createTestController({
    draft: "",
    isSendingMessage: false,
    scenario: {
      ...baseScenario,
      runs,
      runtime: { ...baseScenario.runtime, status: input.runtimeStatus ?? "ready" },
    },
    selectedRunId: input.selectedRunId,
    sendMessage: vi.fn(),
    setDraft: vi.fn(),
  });

  return renderToStaticMarkup(
    createElement(DevToolsControllerProvider, {
      children: createElement(RunComposer),
      controller,
    }),
  );
}
