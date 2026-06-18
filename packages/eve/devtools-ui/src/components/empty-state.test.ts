import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState } from "@ui/components/empty-state";

describe("EmptyState", () => {
  it("renders a compact title, description, and action", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        action: createElement("button", null, "Start"),
        description: "Send a message to begin.",
        title: "No Sessions",
      }),
    );

    expect(html).toBe(
      '<div class="empty-state"><h2>No Sessions</h2><p>Send a message to begin.</p><button>Start</button></div>',
    );
  });
});
