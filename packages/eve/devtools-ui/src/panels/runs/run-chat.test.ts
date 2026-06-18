import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import { createOptimisticChatMessage } from "@ui/controllers/live/use-live-controller";
import { RunChat } from "@ui/panels/runs/run-chat";

describe("RunChat", () => {
  it("shows a new-session user message before the server assigns a session", () => {
    const controller = createTestController({
      chatMessages: [createOptimisticChatMessage("Hello immediately", "submission-1", "draft")],
      isSendingMessage: true,
      selectedRunId: undefined,
    });
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(RunChat),
        controller,
      }),
    );

    expect(html).toContain('data-optimistic="true"');
    expect(html).toContain("Hello immediately");
    expect(html).toContain("Thinking…");
  });
});
