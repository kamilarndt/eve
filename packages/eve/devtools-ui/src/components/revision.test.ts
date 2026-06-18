import { describe, expect, it } from "vitest";

import { formatRevision } from "@ui/components/revision";

describe("formatRevision", () => {
  it("extracts the compact token from a runtime snapshot path", () => {
    expect(
      formatRevision(
        "/workspace/.eve/dev-runtime/snapshots/mqmt7zyz-d77eabd5/source/apps/weather-agent",
      ),
    ).toBe("mqmt7zyz");
  });

  it("keeps already compact revisions and stably shortens other paths", () => {
    expect(formatRevision("a81f2c9")).toBe("a81f2c9");
    expect(formatRevision("/workspace/weather-agent")).toBe(
      formatRevision("/workspace/weather-agent"),
    );
    expect(formatRevision("/workspace/weather-agent")).toHaveLength(7);
  });
});
