import { Client } from "eve/client";

import { ReactRenderer } from "../../dist/src/tui/react-renderer.js";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

/**
 * React-renderer variant of `tui-transport-error`: a turn-dispatch failure
 * against an unreachable server must render as an inline `Error` block where the
 * assistant response would have appeared, and the runner must return to the
 * prompt rather than throw out of `run()`. Serverless (the failure is the point).
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49213";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ host: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const renderer = new ReactRenderer({ input, output: screen, captureForeignOutput: true });
  const runner = new EveTUIRunner({ session: client.session(), client, renderer });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") return;
    throw error;
  });

  try {
    await screen.waitForText("❯", 5_000);
    input.type("Trigger a transport failure.");
    input.enter();
    await screen.waitForText("Error", 10_000);
    await screen.waitForText("❯", 5_000); // returned to the prompt, not torn down
    input.ctrlC();
    await runPromise;
    renderer.shutdown();
    process.stdout.write("[tui-react-transport-error] error region + return-to-prompt verified\n");
  } catch (error) {
    renderer.shutdown();
    process.stdout.write(`\n[tui] tui-react-transport-error smoke test failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
})();
