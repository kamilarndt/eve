/**
 * The dogfood gate, server-free: drive `ReactRenderer` through the SAME
 * `MockScreen`/`MockUserInput` the `test/tui-client` smoke suite uses, and assert
 * the emulated grid (`snapshot()` / `waitForText()`) reflects our frames. This
 * proves the one integration risk the contract research flagged — that the cell
 * presenter's ANSI (DEC 2026 sync, cursor positioning, SGR) is a subset the mock
 * terminal's parser understands — without spinning up a fixture server.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { AgentTUIStreamEvent } from "../cli/dev/tui/runner.js";
import { MockScreen, MockUserInput } from "../cli/dev/tui/test/mock-terminal.js";
import { ReactRenderer } from "./react-renderer.js";
import { shared } from "./store.js";

async function* streamOf(events: AgentTUIStreamEvent[]): AsyncIterable<AgentTUIStreamEvent> {
  for (const event of events) yield event;
}

describe("ReactRenderer drives the smoke-suite MockScreen", () => {
  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  it("renders a streamed turn into the emulated grid", async () => {
    const screen = new MockScreen({ columns: 60, rows: 20 });
    const input = new MockUserInput();
    const renderer = new ReactRenderer({ input, output: screen });

    await renderer.renderStream({
      events: streamOf([
        { type: "assistant-complete", id: "a", text: "hello from react" },
        { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.ts" } },
        { type: "tool-result", toolCallId: "t1", output: "ok" },
        { type: "finish" },
      ]),
    });

    const snapshot = screen.snapshot();
    expect(snapshot).toContain("hello from react"); // assistant text reached the grid
    expect(snapshot).toContain("read_file"); // tool name
    renderer.shutdown();
  });

  it("reflects a typed prompt the way a smoke test drives it (type + enter)", async () => {
    const screen = new MockScreen({ columns: 60, rows: 20 });
    const input = new MockUserInput();
    const renderer = new ReactRenderer({ input, output: screen });

    const pending = renderer.readPrompt();
    input.type("deploy the app");
    await screen.waitForText("deploy the app"); // the draft is painted as typed
    input.enter();

    expect(await pending).toBe("deploy the app");
    expect(screen.snapshot()).toContain("deploy the app"); // echoed as a user block
    renderer.shutdown();
  });
});
