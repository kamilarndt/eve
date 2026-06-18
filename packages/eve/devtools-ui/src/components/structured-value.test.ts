import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StructuredValue } from "@ui/components/structured-value";

describe("StructuredValue", () => {
  it("renders an accessible JSON copy action", () => {
    const html = renderToStaticMarkup(
      createElement(StructuredValue, { value: { city: "Berlin" } }),
    );

    expect(html).toContain('aria-label="Copy JSON"');
    expect(html).toContain("&quot;city&quot;: &quot;Berlin&quot;");
  });
});
