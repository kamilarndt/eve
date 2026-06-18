import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBar } from "./components/status-bar.js";
import { createInput, type InputStream } from "./input.js";
import { shared } from "./store.js";
import { mountForTest } from "./testing.js";

// A stdin-like stream backed by a plain EventEmitter (no raw mode / TTY).
function fakeStream(): InputStream & EventEmitter {
  return new EventEmitter() as InputStream & EventEmitter;
}

describe("input -> onKey", () => {
  it("decodes a control key and a character", () => {
    const stream = fakeStream();
    const input = createInput(stream);
    const onCtrlL = vi.fn();
    const onChar = vi.fn();
    input.onKey("ctrl-l", onCtrlL);
    input.onKey("character", onChar);

    stream.emit("data", Buffer.from([0x0c])); // Ctrl+L
    stream.emit("data", "x");

    expect(onCtrlL).toHaveBeenCalledTimes(1);
    expect(onChar).toHaveBeenCalledWith({ type: "character", value: "x" });
    input.dispose();
  });
});

describe("input -> store -> StatusBar (the full P1 loop)", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  it("a keystroke mutates the store and re-renders the bar", () => {
    shared.setState(() => ({ mode: "prompt", blocks: [], model: "before" }));
    const handle = mountForTest(h("eve-box", null, h(StatusBar, { width: 80 })), {
      width: 80,
      height: 2,
    });
    expect(handle.captureCharFrame()).toContain("before");

    const stream = fakeStream();
    const input = createInput(stream);
    input.onKey("ctrl-l", () => {
      shared.setState((state) => ({ ...state, model: "after" }));
    });

    stream.emit("data", Buffer.from([0x0c])); // Ctrl+L -> writer -> setState
    handle.flush();

    const frame = handle.captureCharFrame();
    expect(frame).toContain("after");
    expect(frame).not.toContain("before");

    input.dispose();
    handle.unmount();
  });
});
