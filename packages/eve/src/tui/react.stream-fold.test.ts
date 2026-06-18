import { describe, expect, it } from "vitest";

import type { AgentTUIStreamEvent } from "../cli/dev/tui/runner.js";
import { StreamFold } from "./stream-fold.js";

function feed(fold: StreamFold, events: AgentTUIStreamEvent[]): void {
  for (const event of events) fold.apply(event);
}

describe("StreamFold — assistant text", () => {
  it("accumulates deltas into one block (full body each time), trimmed", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "assistant-delta", id: "a", delta: "Hel" },
      { type: "assistant-delta", id: "a", delta: "lo " },
    ]);
    expect(fold.blocks).toHaveLength(1);
    expect(fold.blocks[0]).toMatchObject({ kind: "assistant", id: "a", body: "Hello", live: true });
  });

  it("settles live=false on assistant-complete", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "assistant-delta", id: "a", delta: "hi" },
      { type: "assistant-complete", id: "a" },
    ]);
    expect(fold.blocks[0]).toMatchObject({ body: "hi", live: false });
  });

  it("uses complete.text on the delta-less channel (no prior deltas)", () => {
    const fold = new StreamFold();
    feed(fold, [{ type: "assistant-complete", id: "a", text: "whole message" }]);
    expect(fold.blocks[0]).toMatchObject({ kind: "assistant", body: "whole message", live: false });
  });

  it("creates no block for all-whitespace content", () => {
    const fold = new StreamFold();
    feed(fold, [{ type: "assistant-delta", id: "a", delta: "   \n " }]);
    expect(fold.blocks).toHaveLength(0);
  });
});

describe("StreamFold — reasoning gating", () => {
  it("drops reasoning entirely when hidden", () => {
    const fold = new StreamFold({ reasoning: "hidden" });
    feed(fold, [
      { type: "reasoning-delta", id: "r", delta: "thinking" },
      { type: "reasoning-complete", id: "r" },
    ]);
    expect(fold.blocks).toHaveLength(0);
  });

  it("auto-collapsed keeps a streaming trace expanded, collapses on complete", () => {
    const fold = new StreamFold({ reasoning: "auto-collapsed" });
    fold.apply({ type: "reasoning-delta", id: "r", delta: "step" });
    expect(fold.blocks[0]).toMatchObject({ kind: "reasoning", collapsed: false, live: true });
    fold.apply({ type: "reasoning-complete", id: "r" });
    expect(fold.blocks[0]).toMatchObject({ collapsed: true, live: false });
  });
});

describe("StreamFold — tools", () => {
  it("maps tool-call → running, tool-result → done with summarized result", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
    ]);
    expect(fold.blocks[0]).toMatchObject({
      kind: "tool",
      id: "tool:t1",
      title: "read_file",
      status: "running",
      live: true,
    });
    expect(fold.blocks[0]!.subtitle).toContain("path");

    fold.apply({ type: "tool-result", toolCallId: "t1", output: "ok" });
    expect(fold.blocks).toHaveLength(1); // updated in place, not appended
    expect(fold.blocks[0]).toMatchObject({ status: "done", live: false });
    expect(fold.blocks[0]!.result).toContain("ok");
  });

  it("maps tool-error → error status with stripped text", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "tool-call", toolCallId: "t1", toolName: "run", input: {} },
      { type: "tool-error", toolCallId: "t1", errorText: "boom" },
    ]);
    expect(fold.blocks[0]).toMatchObject({ status: "error", result: "boom", live: false });
  });

  it("no-ops a result whose call was never announced", () => {
    const fold = new StreamFold();
    fold.apply({ type: "tool-result", toolCallId: "ghost", output: "x" });
    expect(fold.blocks).toHaveLength(0);
  });

  it("tool-approval-request flips status to approval (stays live)", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "tool-call", toolCallId: "t1", toolName: "rm", input: {} },
      { type: "tool-approval-request", approvalId: "ap1", toolCallId: "t1" },
    ]);
    expect(fold.blocks[0]).toMatchObject({ status: "approval", live: true });
  });
});

describe("StreamFold — subagent suppression", () => {
  it("suppresses a child tool call announced after the mark", () => {
    const fold = new StreamFold();
    fold.markChildToolCall("c1");
    fold.apply({ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} });
    expect(fold.blocks).toHaveLength(0);
  });

  it("removes a parent tool block already pushed before the mark", () => {
    const fold = new StreamFold();
    fold.apply({ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} });
    expect(fold.blocks).toHaveLength(1);
    fold.markChildToolCall("c1");
    expect(fold.blocks).toHaveLength(0);
  });
});

describe("StreamFold — finalize + deny", () => {
  it("finalize clears live except approval/running", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "assistant-delta", id: "a", delta: "hi" },
      { type: "tool-call", toolCallId: "t1", toolName: "x", input: {} },
      { type: "tool-call", toolCallId: "t2", toolName: "y", input: {} },
      { type: "tool-approval-request", approvalId: "ap", toolCallId: "t2" },
    ]);
    fold.finalize();
    const a = fold.blocks.find((b) => b.id === "a");
    const t1 = fold.blocks.find((b) => b.id === "tool:t1");
    const t2 = fold.blocks.find((b) => b.id === "tool:t2");
    expect(a!.live).toBe(false);
    expect(t1!.live).toBe(true); // still running — awaits a result
    expect(t2!.live).toBe(true); // still awaiting approval
  });

  it("denyTool settles a denied call so it is not left live", () => {
    const fold = new StreamFold();
    feed(fold, [
      { type: "tool-call", toolCallId: "t1", toolName: "rm", input: {} },
      { type: "tool-approval-request", approvalId: "ap", toolCallId: "t1" },
    ]);
    fold.denyTool("t1");
    expect(fold.blocks[0]).toMatchObject({ status: "denied", live: false });
  });

  it("error event appends an error block with title + body", () => {
    const fold = new StreamFold();
    fold.apply({ type: "error", errorText: "it broke", detail: "stack" });
    expect(fold.blocks[0]).toMatchObject({
      kind: "error",
      title: "Error",
      body: "it broke",
      detail: "stack",
    });
  });
});
