import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import { ConsoleRecord } from "@ui/panels/console/console-record";

describe("ConsoleRecord", () => {
  it("renders a navigable session title with a session indicator", () => {
    const scenario = createPrototypeScenario("running");
    const sessionId = scenario.selectedRunId;
    if (sessionId === undefined) throw new Error("Expected the fixture to select a session.");
    const controller = createTestController({ scenario });
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(ConsoleRecord, {
          record: {
            coordinates: {
              revision: "rev-1",
              session: sessionId,
            },
            id: "log-1",
            level: "info",
            message: "Hello",
            stream: "console",
            timestamp: "10:00:00",
          },
        }),
        controller,
      }),
    );

    expect(html).toContain("lucide-message-square");
    expect(html).toContain("Berlin weather");
    expect(html).not.toContain(sessionId);
  });
});
