import { createElement as h } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { StatusBar } from "./components/status-bar.js";
import { CellBuffer } from "./cells/buffer.js";
import { present } from "./cells/present.js";
import { shared } from "./store.js";
import { mountForTest } from "./testing.js";

describe("style-aware cells", () => {
  it("rasterizes ANSI into styled cells and emits SGR on present", () => {
    const buffer = new CellBuffer(10, 1);
    buffer.writeAnsi(0, 0, "\x1b[31mhi\x1b[39m"); // red "hi", reset fg
    expect(buffer.toString()).toBe("hi"); // plain projection strips style
    const ansi = present(null, buffer);
    expect(ansi).toContain("\x1b[31m"); // the color is emitted
    expect(ansi).toContain("hi");
    expect(ansi.endsWith("\x1b[?2026l")).toBe(true);
    // a clean-up reset is emitted because the last run was styled
    expect(ansi).toContain("\x1b[0m");
  });
});

describe("StatusBar reads the shared store", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  const mount = () =>
    mountForTest(h("eve-box", null, h(StatusBar, { width: 80 })), { width: 80, height: 2 });

  it("renders model + tokens from the store", () => {
    shared.setState(() => ({
      mode: "prompt",
      blocks: [],
      model: "anthropic/claude-sonnet-4-6",
      tokens: "up 100 down 50",
    }));
    const handle = mount();
    const frame = handle.captureCharFrame();
    expect(frame).toContain("anthropic/claude-sonnet-4-6");
    expect(frame).toContain("up 100 down 50");
    handle.unmount();
  });

  it("re-renders when the store changes — no setters pushed", () => {
    shared.setState(() => ({ mode: "prompt", blocks: [], model: "model-a" }));
    const handle = mount();
    expect(handle.captureCharFrame()).toContain("model-a");

    shared.setState((state) => ({ ...state, model: "model-b" }));
    handle.flush();

    const frame = handle.captureCharFrame();
    expect(frame).toContain("model-b");
    expect(frame).not.toContain("model-a");
    handle.unmount();
  });

  it("degrades at narrow widths: drops project then model, keeps tokens", () => {
    shared.setState(() => ({
      mode: "prompt",
      blocks: [],
      model: "anthropic/claude-sonnet-4-6",
      tokens: "up 100 down 50",
      vercel: { identity: { projectName: "weather", teamName: "acme" }, pendingDeploy: false },
    }));
    // The full row (model · tokens · project) cannot fit in 24 columns, so
    // project drops first, then model, leaving the token flow.
    const handle = mountForTest(h("eve-box", null, h(StatusBar, { width: 24 })), {
      width: 24,
      height: 2,
    });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("up 100 down 50"); // tokens survive
    expect(frame).not.toContain("weather"); // project dropped first
    expect(frame).not.toContain("claude-sonnet"); // model dropped next
    handle.unmount();
  });
});
