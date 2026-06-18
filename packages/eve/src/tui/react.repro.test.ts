import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import { mountForTest } from "./testing.js";

// Mirrors the live example exactly: header, blank, two nested row-boxes (one
// per dynamic value), blank, footer. Reproduces the row shift seen on update.
describe("example structure re-render", () => {
  const Box = "eve-box";
  const Text = "eve-text";
  const App = ({ tick, time }: { tick: number; time: string }) =>
    h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "header line"),
      h(Text, null, ""),
      h(Box, { flexDirection: "row" }, h(Text, null, "time:  "), h(Text, null, time)),
      h(Box, { flexDirection: "row" }, h(Text, null, "ticks: "), h(Text, null, String(tick))),
      h(Text, null, ""),
      h(Text, null, "press Ctrl+C to exit"),
    );

  it("keeps nested row-boxes laid out as rows across updates", () => {
    const handle = mountForTest(h(App, { tick: 0, time: "6:42:03 PM" }), { width: 40, height: 12 });
    expect(handle.captureCharFrame()).toBe(
      "header line\n\ntime:  6:42:03 PM\nticks: 0\n\npress Ctrl+C to exit",
    );
    handle.update(h(App, { tick: 1, time: "6:42:04 PM" }));
    expect(handle.captureCharFrame()).toBe(
      "header line\n\ntime:  6:42:04 PM\nticks: 1\n\npress Ctrl+C to exit",
    );
    handle.unmount();
  });
});
