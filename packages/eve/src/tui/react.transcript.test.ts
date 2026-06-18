import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import type { Block } from "../cli/dev/tui/blocks.js";
import { Transcript } from "./components/transcript.js";
import { mountForTest } from "./testing.js";

describe("Transcript dispatches the Block model to components", () => {
  it("renders user, assistant (markdown), and a tool call", () => {
    const blocks: Block[] = [
      { kind: "user", body: "hello there" },
      { kind: "assistant", body: "# Answer\nhere you **go**" },
      { kind: "tool", title: "read_file", subtitle: "path=a.ts", status: "done", result: "ok" },
    ];
    const handle = mountForTest(h(Transcript, { blocks }), { width: 50, height: 16 });
    const frame = handle.captureCharFrame();

    expect(frame).toContain("hello there"); // user body
    expect(frame).toContain("Answer"); // assistant heading (markdown)
    expect(frame).toContain("here you go"); // bold rendered, markers stripped in plain projection
    expect(frame).toContain("read_file"); // tool name
    expect(frame).toContain("path=a.ts"); // tool args
    expect(frame).toContain("ok"); // tool result
    handle.unmount();
  });

  it("hanging-indents a wrapped user message under the gutter", () => {
    const blocks: Block[] = [{ kind: "user", body: "one two three four five six seven" }];
    // content column width = 12 - 2 (gutter) = 10
    const handle = mountForTest(h(Transcript, { blocks }), { width: 12, height: 6 });
    const rows = handle
      .captureCharFrame()
      .split("\n")
      .filter((row) => row.trim().length > 0);
    expect(rows.length).toBeGreaterThan(1); // it wrapped
    for (const row of rows) {
      // gutter is 2 cells: a glyph (or blank) at col 0, always blank at col 1;
      // body content begins at col 2 (hanging indent under the gutter)
      expect(row[1]).toBe(" ");
      expect(/\S/.test(row.slice(2))).toBe(true);
    }
    handle.unmount();
  });

  it("renders an error block with its title and body", () => {
    const blocks: Block[] = [{ kind: "error", title: "Boom", body: "it broke" }];
    const handle = mountForTest(h(Transcript, { blocks }), { width: 40, height: 6 });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("Boom");
    expect(frame).toContain("it broke");
    handle.unmount();
  });

  it("renders a log block with its source label and body", () => {
    const blocks: Block[] = [{ kind: "log", title: "stdout", body: "server listening on :3000" }];
    const handle = mountForTest(h(Transcript, { blocks }), { width: 50, height: 6 });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("stdout"); // source label
    expect(frame).toContain("server listening on :3000"); // captured line
    handle.unmount();
  });

  it("renders a command echo with its body", () => {
    const blocks: Block[] = [{ kind: "command", body: "/model opus" }];
    const handle = mountForTest(h(Transcript, { blocks }), { width: 40, height: 6 });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("/model opus");
    handle.unmount();
  });

  it("renders a nested subagent header behind the orange rule", () => {
    const blocks: Block[] = [{ kind: "subagent", title: "researcher", depth: 1 }];
    const handle = mountForTest(h(Transcript, { blocks }), { width: 40, height: 6 });
    const rows = handle
      .captureCharFrame()
      .split("\n")
      .filter((row) => row.trim().length > 0);
    const headerRow = rows.find((row) => row.includes("researcher"));
    expect(headerRow).toBeDefined();
    expect(headerRow).toContain("subagent"); // trailing label
    // depth 1 prepends a 2-cell nesting rule, so the header glyph/name sit after it
    expect(headerRow!.indexOf("researcher")).toBeGreaterThanOrEqual(4);
    handle.unmount();
  });
});
