import { Client } from "eve/client";

import { ReactRenderer } from "../../dist/src/tui/react-renderer.js";
import { EveTUIRunner, MockScreen, MockUserInput, type EveTUIRunnerOptions } from "./lib/tui.ts";

/**
 * End-to-end smoke for the React/cell renderer, run from the built `dist`
 * artifact against the same `MockScreen`/`MockUserInput` harness the terminal
 * smokes use. Proves the renderer mounts, paints the prompt, captures foreign
 * (dev-server) output into the grid, accepts typed input, and shuts down
 * cleanly on Ctrl-C — all without an agent server or model credentials.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49217";
const LOG_MARK = "REACT_SMOKE_LOG_MARK_7c3";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const renderer = new ReactRenderer({
    input,
    output: screen,
    captureForeignOutput: true,
    logs: "all",
  });
  const options: EveTUIRunnerOptions = { session: client.session(), client, renderer };
  const runner = new EveTUIRunner(options);

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") return;
    throw error;
  });

  try {
    // The prompt mark paints once the renderer is interactive.
    await screen.waitForText("❯", 5_000);

    // Foreign output is captured and reaches the grid (logs=all).
    process.stdout.write(`${LOG_MARK}\n`);
    await screen.waitForText(LOG_MARK, 5_000);

    // Typed input is echoed into the draft line.
    input.type("hello from the react renderer");
    await screen.waitForText("hello from the react renderer", 5_000);

    // Ctrl-C unwinds the prompt read and ends the run loop.
    input.ctrlC();
    await runPromise;

    // stdout is restored after shutdown, so this prints to the real terminal.
    process.stdout.write("[tui-react-renderer] mount + capture + input + exit verified\n");
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(`\n[tui] tui-react-renderer smoke test failed: ${String(error)}\n`);
  }
})();
