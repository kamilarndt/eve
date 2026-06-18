import { beforeEach, describe, expect, it } from "vitest";

import type { TerminalInput, TerminalOutput } from "../cli/dev/tui/terminal-io.js";
import { ReactRenderer } from "./react-renderer.js";
import { shared } from "./store.js";

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
    resume: () => self,
    pause: () => self,
    setRawMode: () => self,
    emit(data: string) {
      listener?.(Buffer.from(data, "utf8"));
    },
  };
  return self as unknown as TerminalInput & { emit(data: string): void };
}

function fakeOutput(): TerminalOutput {
  const self = {
    isTTY: true,
    columns: 60,
    rows: 20,
    write: () => true,
    on: () => self,
    off: () => self,
  };
  return self as unknown as TerminalOutput;
}

describe("ReactRenderer.setupFlow drives the panel + interactive reads", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  it("begin/renderOutput/renderLine/end: a warning pulls in buffered evidence and commits", () => {
    const renderer = new ReactRenderer({ input: fakeInput(), output: fakeOutput() });
    renderer.setupFlow.begin("/deploy");
    expect(shared.getState().setupFlow?.title).toBe("/deploy");

    renderer.setupFlow.renderOutput("npm build line"); // buffered as evidence
    renderer.setupFlow.renderLine("build failed", "error"); // flushes evidence before the error
    const lines = shared.getState().setupFlow!.lines;
    expect(lines).toEqual([
      { text: "npm build line", tone: "info", evidence: true },
      { text: "build failed", tone: "error" },
    ]);

    renderer.setupFlow.end();
    expect(shared.getState().setupFlow).toBeUndefined();
    const blocks = shared.getState().blocks;
    // Diagnostics committed: the evidence info block + the error flow block.
    expect(blocks.map((b) => ({ kind: b.kind, title: b.title }))).toEqual([
      { kind: "flow", title: "info" },
      { kind: "flow", title: "error" },
    ]);
    renderer.shutdown();
  });

  it("readSelect resolves the highlighted value (down + enter)", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });
    renderer.setupFlow.begin("/channels");
    const pending = renderer.setupFlow.readSelect({
      kind: "single",
      message: "Pick a channel",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
    });
    expect(shared.getState().setupFlow?.question?.kind).toBe("select");
    input.emit("\x1b[B"); // down -> Beta
    input.emit("\r"); // enter
    expect(await pending).toEqual(["b"]);
    expect(shared.getState().setupFlow?.question).toBeUndefined(); // settled
    renderer.shutdown();
  });

  it("readText re-prompts on a validation error, then resolves", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });
    renderer.setupFlow.begin("/setup");
    const pending = renderer.setupFlow.readText({
      message: "Name",
      validate: (value) => (value.length < 2 ? "too short" : undefined),
    });
    input.emit("a");
    input.emit("\r"); // "a" fails validation
    const question = shared.getState().setupFlow?.question;
    expect(question).toMatchObject({ kind: "text", error: "too short" });
    input.emit("b");
    input.emit("\r"); // "ab" passes
    expect(await pending).toBe("ab");
    renderer.shutdown();
  });

  it("readAcknowledge resolves on enter; waitForInterrupt resolves on ctrl-c", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });
    renderer.setupFlow.begin("/setup");

    const ack = renderer.setupFlow.readAcknowledge({ message: "Heads up", lines: ["a", "b"] });
    input.emit("\r");
    await ack; // resolves void

    const { promise, dispose } = renderer.setupFlow.waitForInterrupt();
    input.emit("\x03"); // ctrl-c
    await promise; // resolves
    dispose();
    renderer.shutdown();
  });

  it("readEditableSelect: a preset resolves selected; editing the editable row resolves edited", async () => {
    const request = {
      message: "Pick or name",
      options: [
        { value: "preset", label: "Preset" },
        { value: "__edit__", label: "Custom…" },
      ],
      editable: { value: "__edit__", defaultValue: "my-app", formatHint: (v: string) => v },
    };

    // Preset path: enter on row 0.
    const inputA = fakeInput();
    const rendererA = new ReactRenderer({ input: inputA, output: fakeOutput() });
    rendererA.setupFlow.begin("/setup");
    const presetPending = rendererA.setupFlow.readEditableSelect(request);
    inputA.emit("\r");
    expect(await presetPending).toEqual({ kind: "selected", value: "preset" });
    rendererA.shutdown();

    // Edit path: move to the editable row, enter the field, type, submit.
    const inputB = fakeInput();
    const rendererB = new ReactRenderer({ input: inputB, output: fakeOutput() });
    rendererB.setupFlow.begin("/setup");
    const editPending = rendererB.setupFlow.readEditableSelect(request);
    inputB.emit("\x1b[B"); // down -> editable row
    inputB.emit("\r"); // enter -> edit phase (seeded "my-app")
    inputB.emit("-2"); // edits the seeded default -> "my-app-2"
    inputB.emit("\r"); // submit
    expect(await editPending).toEqual({ kind: "edited", value: "__edit__", text: "my-app-2" });
    rendererB.shutdown();
  });

  it("readChoice resolves the selected action and close() cancels idempotently", async () => {
    const input = fakeInput();
    const renderer = new ReactRenderer({ input, output: fakeOutput() });
    renderer.setupFlow.begin("/channels");
    const handle = renderer.setupFlow.readChoice({
      status: "Installing…",
      context: "Waiting for Slack",
      actions: [
        { label: "Try again", value: "retry" },
        { label: "Cancel", value: "cancel" },
      ],
    });
    input.emit("\r"); // enter on first action -> "retry"
    expect(await handle.choice).toBe("retry");
    handle.close(); // idempotent no-op after settle
    renderer.shutdown();
  });
});
