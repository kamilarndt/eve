import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import { AgentNavigator } from "@ui/panels/agent/agent-navigator";

describe("AgentNavigator", () => {
  it("renders provenance folders as intermediate tree levels", () => {
    const scenario = createPrototypeScenario("running");
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(AgentNavigator),
        controller: createTestController({ scenario }),
      }),
    );

    expect(html).toContain('data-depth="1"');
    expect(html).toContain('data-depth="2"');
    expect(html).toContain("Authored");
    expect(html).toContain("Framework");
    expect(html).toContain("get_weather");
    expect(html).not.toContain("ask_question");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<h2>Resolved Agent</h2><span>14</span>");
  });
});
