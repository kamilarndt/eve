import { describe, expect, it } from "vitest";

import { downloadFile } from "./defaults.js";

describe("default tools", () => {
  it("keeps download_file model output free of inline file data", async () => {
    const output = {
      filename: "report.txt",
      mediaType: "text/plain",
      size: 5,
      type: "file" as const,
      url: "data:text/plain;base64,aGVsbG8=",
    };

    expect(downloadFile.toModelOutput).toBeTypeOf("function");
    expect(await downloadFile.toModelOutput?.(output)).toEqual({
      type: "text",
      value: "Made report.txt (5 bytes) available for download.",
    });
  });
});
