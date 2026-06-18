import { afterEach, describe, expect, it } from "vitest";

import { InputBlock } from "./components/input-block.js";
import { glyph } from "./components/primitives.js";
import { shared } from "./store.js";
import { mountForTest } from "./testing.js";

/**
 * <InputBlock> reads the live prompt slice from `shared` and renders the prompt
 * glyph + draft text + caret. captureCharFrame strips styling, so the caret
 * glyph appears as a plain character between the before/after text.
 */
describe("InputBlock", () => {
  afterEach(() => {
    // The store is process-wide; reset so tests don't leak input into each other.
    shared.setState(() => ({ mode: "prompt", blocks: [] }));
  });

  it("renders just the prompt glyph + caret when there is no input", () => {
    const handle = mountForTest(<InputBlock width={40} />, { width: 40, height: 2 });
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} ${glyph.caret}`);
    handle.unmount();
  });

  it("renders the prompt glyph and the draft text", () => {
    shared.setState(() => ({ mode: "prompt", blocks: [], input: { text: "hello", cursor: 5 } }));
    const handle = mountForTest(<InputBlock width={40} />, { width: 40, height: 2 });
    // cursor at end: caret follows the full text.
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} hello${glyph.caret}`);
    handle.unmount();
  });

  it("places the caret between the text on either side of the cursor", () => {
    shared.setState(() => ({ mode: "prompt", blocks: [], input: { text: "hello", cursor: 2 } }));
    const handle = mountForTest(<InputBlock width={40} />, { width: 40, height: 2 });
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} he${glyph.caret}llo`);
    handle.unmount();
  });

  it("re-renders when the store input slice changes (flush after setState)", () => {
    const handle = mountForTest(<InputBlock width={40} />, { width: 40, height: 2 });
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} ${glyph.caret}`);

    shared.setState(() => ({ mode: "prompt", blocks: [], input: { text: "abc", cursor: 3 } }));
    handle.flush();
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} abc${glyph.caret}`);

    shared.setState(() => ({ mode: "prompt", blocks: [], input: { text: "abcd", cursor: 4 } }));
    handle.flush();
    expect(handle.captureCharFrame()).toBe(`${glyph.prompt} abcd${glyph.caret}`);
    handle.unmount();
  });
});
