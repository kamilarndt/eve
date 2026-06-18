import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import { RunTimeline } from "@ui/panels/runs/run-timeline";
import { TimelineRow } from "@ui/panels/runs/timeline-row";

describe("RunTimeline", () => {
  it("shows an immediate loading row while creating the first session", () => {
    const scenario = createPrototypeScenario("empty");
    const controller = createTestController({
      events: [],
      isSendingMessage: true,
      scenario,
      selectedRunId: undefined,
    });

    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(RunTimeline),
        controller,
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Starting run");
    expect(html).toContain("Creating the session and waiting for runtime events…");
  });

  it("labels an absent duration without rendering a bare hyphen", () => {
    const html = renderToStaticMarkup(
      createElement(TimelineRow, {
        event: {
          coordinates: { revision: "rev-1", session: "session-1" },
          id: "event-1",
          kind: "user",
          label: "User Message",
          raw: {},
          sessionId: "session-1",
          status: "completed",
          summary: "Hello",
          time: "22:14:24",
        },
        onSelect() {},
        selected: false,
      }),
    );

    expect(html).toContain('aria-label="No duration"');
    expect(html).toContain("—");
    expect(html).toContain("22:14:24");
  });
});
