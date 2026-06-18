import { createElement as h } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { Main } from "./components/main.js";
import { shared } from "./store.js";
import { StreamFold } from "./stream-fold.js";
import { mountForTest } from "./testing.js";

describe("Main composes the whole TUI from the shared store", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  const mount = (width = 60) => mountForTest(h(Main, { width }), { width, height: 20 });

  it("renders header, a folded transcript turn, and the status line", () => {
    const fold = new StreamFold();
    fold.apply({ type: "assistant-delta", id: "a", delta: "Here you **go**" });
    fold.apply({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "read_file",
      input: { path: "a.ts" },
    });
    fold.apply({ type: "tool-result", toolCallId: "t1", output: "ok" });
    fold.finalize();

    shared.setState((s) => ({
      ...s,
      header: { name: "weather-agent", serverUrl: "http://localhost:3000" },
      model: "anthropic/claude-sonnet-4-6",
      blocks: [{ kind: "user", body: "hi" }, ...fold.blocks.map((b) => ({ ...b }))],
    }));

    const handle = mount();
    const frame = handle.captureCharFrame();
    expect(frame).toContain("weather-agent"); // header
    expect(frame).toContain("hi"); // user block
    expect(frame).toContain("go"); // assistant (markdown bold, markers stripped)
    expect(frame).toContain("read_file"); // tool name
    expect(frame).toContain("ok"); // tool result
    expect(frame).toContain("anthropic/claude-sonnet-4-6"); // status line
    handle.unmount();
  });

  it("swaps the prompt editor for the approval modal when mode is approval", () => {
    shared.setState((s) => ({
      ...s,
      mode: "approval",
      approval: {
        request: { approvalId: "ap", toolCallId: "t1", toolName: "rm", input: {} },
        cursor: 0,
        resolve: () => {},
      },
    }));
    const handle = mount();
    const frame = handle.captureCharFrame();
    expect(frame).toContain("Approve rm?");
    expect(frame).toContain("approve");
    expect(frame).toContain("deny");
    handle.unmount();
  });

  it("renders a select question modal with its options", () => {
    shared.setState((s) => ({
      ...s,
      mode: "question",
      question: {
        request: {
          requestId: "q1",
          prompt: "Pick one",
          display: "select",
          options: [
            { id: "a", label: "Option A" },
            { id: "b", label: "Option B" },
          ],
        },
        text: "",
        cursor: 0,
        optionCursor: 1,
        resolve: () => {},
      },
    }));
    const handle = mount();
    const frame = handle.captureCharFrame();
    expect(frame).toContain("Pick one");
    expect(frame).toContain("Option A");
    expect(frame).toContain("Option B");
    handle.unmount();
  });
});
