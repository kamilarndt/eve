import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import { activateRunsView, RunsPanel } from "@ui/panels/runs/runs-panel";

describe("RunsPanel", () => {
  it("keeps the toolbar context limited to the selected run title", () => {
    const scenario = createPrototypeScenario("running");
    const controller = createTestController({
      scenario,
      selectedRunId: scenario.selectedRunId,
    });
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(RunsPanel),
        controller,
      }),
    );
    const toolbarContext = html.match(/<div class="toolbar-context">.*?<\/div>/u)?.[0];

    expect(toolbarContext).toBe(
      '<div class="toolbar-context"><span>Runs</span><span class="toolbar-separator">/</span><strong>Berlin weather</strong></div>',
    );
  });

  it("defaults to chat and keeps the timeline available as a tab", () => {
    const scenario = createPrototypeScenario("running");
    const controller = createTestController({
      scenario,
      selectedRunId: scenario.selectedRunId,
    });
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(RunsPanel),
        controller,
      }),
    );

    expect(html).toContain('aria-selected="true" data-active="true" id="run-chat-tab"');
    expect(html).toContain('aria-selected="false" id="run-timeline-tab"');
    expect(html).toContain('aria-label="Run chat"');
    expect(html).toContain("get_weather");
    expect(html).not.toContain('aria-label="Run timeline"');
  });

  it("focuses an available composer and positions the timeline at its latest event", () => {
    const focus = vi.fn();
    const timeline = { scrollHeight: 420, scrollTop: 0 };

    expect(activateRunsView({ disabled: false, focus }, timeline)).toBe(true);
    expect(timeline.scrollTop).toBe(420);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("defers focus while the composer is disabled", () => {
    const focus = vi.fn();

    expect(activateRunsView({ disabled: true, focus }, null)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
