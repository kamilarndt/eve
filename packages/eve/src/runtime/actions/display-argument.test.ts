import { describe, expect, it } from "vitest";

import {
  formatCommandDisplayArgument,
  formatPathDisplayArgument,
  formatTextDisplayArgument,
  formatUrlDisplayArgument,
} from "#runtime/actions/display-argument.js";

describe("action display arguments", () => {
  it("uses the first non-empty text line", () => {
    expect(formatTextDisplayArgument("\n  pnpm test  \npnpm lint")).toBe("pnpm test");
    expect(formatTextDisplayArgument(" \n ")).toBeUndefined();
  });

  it("suppresses commands containing credential markers", () => {
    expect(formatCommandDisplayArgument("sh -c script/foo.sh")).toBe("sh -c script/foo.sh");
    expect(formatCommandDisplayArgument("export API_KEY=sk-secret")).toBeUndefined();
    expect(
      formatCommandDisplayArgument('curl -H "Authorization: Bearer token" https://example.com'),
    ).toBeUndefined();
  });

  it("keeps the useful tail of file paths", () => {
    expect(
      formatPathDisplayArgument(
        "/workspace/eve/packages/eve/src/runtime/actions/executor-registry.ts",
      ),
    ).toBe("actions/executor-registry.ts");
  });

  it("removes credentials and request data from URLs", () => {
    expect(
      formatUrlDisplayArgument("https://alice:secret@example.com/data?token=hidden#fragment"),
    ).toBe("example.com");
  });
});
