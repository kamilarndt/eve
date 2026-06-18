import { describe, expect, it } from "vitest";

import { nextCommandIndex } from "@ui/components/command-menu";

describe("nextCommandIndex", () => {
  it("moves in both directions and wraps", () => {
    expect(nextCommandIndex(0, 4, "ArrowDown")).toBe(1);
    expect(nextCommandIndex(3, 4, "ArrowDown")).toBe(0);
    expect(nextCommandIndex(0, 4, "ArrowUp")).toBe(3);
  });
});
