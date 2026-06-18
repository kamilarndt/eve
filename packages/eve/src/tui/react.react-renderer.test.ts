import { beforeEach, describe, expect, it } from "vitest";

import type { AgentTUIStreamEvent } from "../cli/dev/tui/runner.js";
import type { TerminalInput, TerminalOutput } from "../cli/dev/tui/terminal-io.js";
import { ReactRenderer } from "./react-renderer.js";
import { shared } from "./store.js";

/** A fake stdin: capture the data listener so the test can emit raw bytes. */
function fakeInput(): TerminalInput & { emit(data: string): void } {
  let listener: ((chunk: Buffer) => void) | undefined;
  const self = {
    isTTY: true,
    on(_event: "data", l: (chunk: Buffer) => void) {
      listener = l;
      return self;
    },
    off() {
      listener = undefined;
      return self;
    },
    resume() {
      return self;
    },
    pause() {
      return self;
    },
    setRawMode() {
      return self;
    },
    emit(data: string) {
      listener?.(Buffer.from(data, "utf8"));
    },
  };
  return self as unknown as TerminalInput & { emit(data: string): void };
}

/** A fake stdout: collect every written chunk. */
function fakeOutput(): TerminalOutput & { text(): string } {
  let buffer = "";
  const self = {
    isTTY: true,
    columns: 60,
    rows: 20,
    write(chunk: string | Uint8Array) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    on() {
      return self;
    },
    off() {
      return self;
    },
    text() {
      return buffer;
    },
  };
  return self as unknown as TerminalOutput & { text(): string };
}

async function* streamOf(events: AgentTUIStreamEvent[]): AsyncIterable<AgentTUIStreamEvent> {
  for (const event of events) yield event;
}

describe("ReactRenderer adapts the runner contract to the store", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  it("readPrompt resolves the typed line and echoes a user block", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });

    const pending = renderer.readPrompt();
    input.emit("hi\r"); // h, i, enter
    const prompt = await pending;

    expect(prompt).toBe("hi");
    const blocks = shared.getState().blocks;
    expect(blocks.at(-1)).toMatchObject({ kind: "user", body: "hi" });
    expect(shared.getState().mode).toBe("streaming");
    renderer.shutdown();
  });

  it("renderStream folds events into the transcript and paints", async () => {
    const output = fakeOutput();
    const renderer = new ReactRenderer({ input: fakeInput(), output });

    await renderer.renderStream({
      events: streamOf([
        { type: "assistant-delta", id: "a", delta: "hello world" },
        { type: "assistant-complete", id: "a" },
        { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
        { type: "tool-result", toolCallId: "t1", output: "ok" },
        { type: "finish" },
      ]),
    });

    const blocks = shared.getState().blocks;
    expect(blocks.find((b) => b.kind === "assistant")).toMatchObject({ body: "hello world" });
    expect(blocks.find((b) => b.id === "tool:t1")).toMatchObject({ status: "done", live: false });
    expect(output.text()).toContain("read_file");
    renderer.shutdown();
  });

  it("readToolApproval resolves approved on 'y' and denied on 'n'", async () => {
    const renderer = new ReactRenderer({ input: undefined, output: fakeOutput() });
    // Seed the tool block so a denial has something to settle.
    await renderer.renderStream({
      events: streamOf([{ type: "tool-call", toolCallId: "t1", toolName: "rm", input: {} }]),
    });

    const inputYes = fakeInput();
    const rendererYes = new ReactRenderer({ input: inputYes, output: fakeOutput() });
    const yes = rendererYes.readToolApproval({
      approvalId: "ap",
      toolCallId: "t1",
      toolName: "rm",
      input: {},
    });
    expect(shared.getState().mode).toBe("approval");
    inputYes.emit("y");
    expect(await yes).toEqual({ approved: true });
    expect(shared.getState().mode).toBe("streaming");
    rendererYes.shutdown();

    const inputNo = fakeInput();
    const rendererNo = new ReactRenderer({ input: inputNo, output: fakeOutput() });
    const no = rendererNo.readToolApproval({
      approvalId: "ap2",
      toolCallId: "t1",
      toolName: "rm",
      input: {},
    });
    inputNo.emit("n");
    expect(await no).toEqual({ approved: false, reason: "Denied by user." });
    rendererNo.shutdown();
    renderer.shutdown();
  });

  it("readInputQuestion (select) resolves the highlighted option", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });
    const pending = renderer.readInputQuestion({
      requestId: "q1",
      prompt: "Pick",
      display: "select",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    input.emit("\x1b[B"); // down -> option index 1
    input.emit("\r"); // enter
    expect(await pending).toEqual({ optionId: "b" });
    renderer.shutdown();
  });

  it("folds token usage into the status-line tokens segment", async () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    await renderer.renderStream({
      events: streamOf([
        { type: "assistant-complete", id: "a", text: "hi" },
        { type: "finish", usage: { inputTokens: 1200, outputTokens: 340 } },
      ]),
    });
    const tokens = shared.getState().tokens;
    expect(tokens).toContain("1.2K"); // ↑ input
    expect(tokens).toContain("340"); // ↓ output
    renderer.shutdown();
  });

  it("renders a subagent dispatch as header + step + tool (one header per run)", () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    renderer.upsertSubagentStep({
      callId: "c1",
      subagentName: "researcher",
      sectionKey: 0,
      reasoning: "",
      message: "looking into it",
      finalized: false,
    });
    renderer.upsertSubagentTool({
      callId: "c1",
      subagentName: "researcher",
      childCallId: "t1",
      toolName: "grep",
      input: { pattern: "x" },
      status: "executing",
    });
    const blocks = shared.getState().blocks;
    expect(blocks.filter((b) => b.kind === "subagent")).toHaveLength(1); // header once
    expect(blocks.find((b) => b.id === "subagent:c1:step:0")).toMatchObject({
      kind: "subagent-step",
      depth: 1,
      body: "looking into it",
    });
    expect(blocks.find((b) => b.id === "subagent:c1:tool:t1")).toMatchObject({
      kind: "subagent-tool",
      depth: 1,
      title: "grep",
      status: "running",
    });
    renderer.shutdown();
  });

  it("renders connection-auth lifecycle and the pending-count status hint", () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    renderer.upsertConnectionAuth({
      name: "linear",
      description: "Linear MCP",
      state: "required",
      challenge: { url: "https://auth.example/x" },
    });
    let block = shared.getState().blocks.find((b) => b.id === "connection-auth:linear");
    expect(block).toMatchObject({ kind: "connection-auth", live: true });
    expect(block!.title).toContain("required");
    expect(block!.body).toContain("https://auth.example/x");

    renderer.setConnectionAuthPendingCount(1);
    expect(shared.getState().connectionAuthPending).toBe(1);

    renderer.upsertConnectionAuth({
      name: "linear",
      description: "Linear MCP",
      state: "authorized",
    });
    block = shared.getState().blocks.find((b) => b.id === "connection-auth:linear");
    expect(block).toMatchObject({ live: false }); // terminal outcome settles it
    expect(block!.title).toContain("authorized");
    renderer.shutdown();
  });

  it("renderSetupWarning sets a clearable attention line; renderCommandResult is a result block", () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    renderer.renderSetupWarning("run /login to connect");
    expect(shared.getState().setupWarning).toBe("run /login to connect");
    renderer.clearSetupWarning();
    expect(shared.getState().setupWarning).toBeUndefined();

    renderer.renderCommandResult("Model set to opus");
    expect(shared.getState().blocks.at(-1)).toMatchObject({
      kind: "result",
      body: "Model set to opus",
    });
    renderer.shutdown();
  });

  it("drops non-sandbox log lines and exposes the /loglevel mode", () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput(), logs: "all" });
    expect(renderer.logDisplayMode()).toBe("all");

    renderer.renderSandboxLog("Eve: sandbox ready on :3000"); // kept (matches \bsandbox\b)
    renderer.renderSandboxLog("some unrelated stdout line"); // dropped (no "Eve: " prefix)
    const sandboxBlocks = shared.getState().blocks.filter((b) => b.kind === "sandbox");
    expect(sandboxBlocks).toHaveLength(1);
    expect(sandboxBlocks[0]!.body).toBe("sandbox ready on :3000");

    renderer.setLogDisplayMode("none");
    expect(renderer.logDisplayMode()).toBe("none");
    expect(shared.getState().logs).toBe("none");
    renderer.shutdown();
  });

  it("reset clears the transcript and returns to prompt mode", async () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    await renderer.renderStream({
      events: streamOf([{ type: "assistant-complete", id: "a", text: "hi" }]),
    });
    expect(shared.getState().blocks.length).toBeGreaterThan(0);
    renderer.reset();
    expect(shared.getState().blocks).toHaveLength(0);
    expect(shared.getState().mode).toBe("prompt");
    renderer.shutdown();
  });
});
