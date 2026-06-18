/**
 * A live, runnable example of the React terminal renderer.
 *
 *   pnpm --filter eve run tui:example
 *
 * Renders a small column UI and re-renders once a second, so you can watch the
 * clock and tick counter update in place (only the changed cells are written).
 * Ctrl+C exits and restores the cursor. Authored as JSX over our host elements.
 */
import { render } from "./runtime.js";

function App({ tick }: { tick: number }) {
  const now = new Date().toLocaleTimeString();
  return (
    <eve-box flexDirection="column">
      <eve-text>eve tui — react renderer (P1)</eve-text>
      <eve-text>{""}</eve-text>
      <eve-box flexDirection="row">
        <eve-text>time: </eve-text>
        <eve-text>{now}</eve-text>
      </eve-box>
      <eve-box flexDirection="row">
        <eve-text>ticks: </eve-text>
        <eve-text>{String(tick)}</eve-text>
      </eve-box>
      <eve-text>{""}</eve-text>
      <eve-text>press Ctrl+C to exit</eve-text>
    </eve-box>
  );
}

let tick = 0;
const handle = render(<App tick={tick} />);

const timer = setInterval(() => {
  tick += 1;
  handle.update(<App tick={tick} />);
}, 1000);

const stop = (): void => {
  clearInterval(timer);
  handle.unmount();
  process.stdout.write("\n");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const exitAfterMs = Number(process.env.EVE_TUI_EXAMPLE_MS ?? 0);
if (exitAfterMs > 0) setTimeout(stop, exitAfterMs);
