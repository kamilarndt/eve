import { describe, expect, it } from "vitest";

import { deriveSessionTitle } from "@ui/controllers/fixture/session-title";

describe("deriveSessionTitle", () => {
  it("uses a normalized first message as the session title", () => {
    expect(deriveSessionTitle("  Find the weather\nfor Berlin  ")).toBe(
      "Find the weather for Berlin",
    );
  });

  it("truncates long messages without exceeding the title limit", () => {
    const title = deriveSessionTitle(
      "Compare the weather across Berlin, Paris, Amsterdam, Copenhagen, and Vienna",
    );

    expect(title).toHaveLength(48);
    expect(title.endsWith("…")).toBe(true);
  });
});
