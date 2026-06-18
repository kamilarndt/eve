/**
 * Foreign-output capture, validated against the real `MockScreen`: the dev
 * server's stdout/stderr (here, direct `process.stdout.write` calls) is captured
 * into `log`/`sandbox` blocks, our own frames still reach the injected output
 * (they bypass the patch via the saved writer), and `shutdown` restores the
 * global streams. This exercises the exact production-shaped path — frame sink
 * separate from the captured stream — without a real TTY.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockScreen, MockUserInput } from "../cli/dev/tui/test/mock-terminal.js";
import { ReactRenderer } from "./react-renderer.js";
import { shared } from "./store.js";

describe("ReactRenderer foreign log capture", () => {
  let renderer: ReactRenderer | undefined;

  beforeEach(() => {
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  afterEach(() => {
    renderer?.shutdown(); // always restore process.stdout/stderr even on failure
    renderer = undefined;
  });

  it("captures stdout/stderr into blocks; frames reach the grid; shutdown restores", () => {
    const screen = new MockScreen({ columns: 80, rows: 24 });
    renderer = new ReactRenderer({
      input: new MockUserInput(),
      output: screen,
      captureForeignOutput: true,
    });

    // Foreign writes, as the in-process dev server would emit them.
    process.stdout.write("server listening on :3000\n");
    process.stdout.write("Eve: sandbox booted for run\n"); // matches parseSandboxLogLine
    process.stderr.write("a deprecation warning\n");

    const blocks = shared.getState().blocks;
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "log", title: "stdout", body: "server listening on :3000" }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "sandbox", body: "sandbox booted for run" }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "log", title: "stderr", body: "a deprecation warning" }),
    );

    // Frames bypass the capture and still reach the injected MockScreen.
    expect(screen.snapshot()).toContain("server listening on :3000");

    renderer.shutdown();
    renderer = undefined;

    // After shutdown the patch is removed: a write creates no further block.
    process.stdout.write("AFTER_RESTORE_MARKER_q1\n");
    expect(
      shared.getState().blocks.find((b) => b.body?.includes("AFTER_RESTORE_MARKER_q1")),
    ).toBeUndefined();
  });

  it("buffers a partial line until its newline arrives", () => {
    renderer = new ReactRenderer({
      input: new MockUserInput(),
      output: new MockScreen({ columns: 80, rows: 24 }),
      captureForeignOutput: true,
    });
    process.stdout.write("half a "); // no newline yet → buffered, no block
    expect(shared.getState().blocks.filter((b) => b.kind === "log")).toHaveLength(0);
    process.stdout.write("line\n"); // completes it
    expect(shared.getState().blocks).toContainEqual(
      expect.objectContaining({ kind: "log", title: "stdout", body: "half a line" }),
    );
  });
});
