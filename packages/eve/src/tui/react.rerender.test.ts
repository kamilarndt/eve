import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import { mountForTest } from "./testing.js";

/**
 * Layout must stay put across re-renders: changing one cell's text should not
 * move the rows around it. (Reproduces a shift observed in the live example.)
 */
describe("re-render layout stability", () => {
  const Box = "eve-box";
  const Text = "eve-text";

  it("keeps a 3-row column stable when the middle text changes", () => {
    const App = ({ t }: { t: string }) =>
      h(
        Box,
        { flexDirection: "column" },
        h(Text, null, "head"),
        h(Text, null, t),
        h(Text, null, "foot"),
      );
    const handle = mountForTest(h(App, { t: "one" }), { width: 12, height: 6 });
    expect(handle.captureCharFrame()).toBe("head\none\nfoot");
    handle.update(h(App, { t: "two" }));
    expect(handle.captureCharFrame()).toBe("head\ntwo\nfoot");
    handle.unmount();
  });

  it("keeps a column with a blank row stable across updates", () => {
    const App = ({ t }: { t: string }) =>
      h(
        Box,
        { flexDirection: "column" },
        h(Text, null, "head"),
        h(Text, null, ""),
        h(Text, null, t),
      );
    const handle = mountForTest(h(App, { t: "x" }), { width: 12, height: 6 });
    expect(handle.captureCharFrame()).toBe("head\n\nx");
    handle.update(h(App, { t: "y" }));
    expect(handle.captureCharFrame()).toBe("head\n\ny");
    handle.unmount();
  });
});
