import { describe, expect, it } from "vitest";

import type { SourceFile } from "@ui/model/devtools-model";
import { buildSourceTree } from "@ui/panels/sources/source-tree";

describe("buildSourceTree", () => {
  it("groups sources into sorted folders before files", () => {
    expect(
      buildSourceTree([
        source("agent/tools/weather.ts"),
        source("package.json"),
        source("agent/instructions.md"),
        source("agent/hooks/audit.ts"),
      ]),
    ).toMatchObject([
      {
        children: [
          {
            children: [{ kind: "file", name: "audit.ts" }],
            kind: "folder",
            name: "hooks",
            path: "agent/hooks",
          },
          {
            children: [{ kind: "file", name: "weather.ts" }],
            kind: "folder",
            name: "tools",
            path: "agent/tools",
          },
          { kind: "file", name: "instructions.md" },
        ],
        kind: "folder",
        name: "agent",
        path: "agent",
      },
      { kind: "file", name: "package.json" },
    ]);
  });
});

function source(path: string): SourceFile {
  return {
    breakpointLines: [],
    content: "",
    id: path,
    language: "TypeScript",
    loaded: false,
    path,
    revision: "test",
  };
}
