import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "./cells/style.js";
import { wrapStyledChars } from "./cells/wrap.js";
import { mountForTest } from "./testing.js";

const text = (chars: { ch: string }[]) => chars.map((c) => c.ch).join("");

describe("wrapStyledChars", () => {
  it("word-wraps at the width, breaking on spaces", () => {
    const lines = wrapStyledChars(parseAnsi("the quick brown fox"), 9);
    expect(lines.map(text)).toEqual(["the quick", "brown fox"]);
  });

  it("hard-breaks a word longer than the width", () => {
    const lines = wrapStyledChars(parseAnsi("abcdefgh"), 5);
    expect(lines.map(text)).toEqual(["abcde", "fgh"]);
  });

  it("breaks on explicit newlines", () => {
    const lines = wrapStyledChars(parseAnsi("a\nb"), 80);
    expect(lines.map(text)).toEqual(["a", "b"]);
  });

  it("preserves per-character style across a wrap", () => {
    // red "hello world" wrapped at 5 -> the 'w' of "world" is still red
    const lines = wrapStyledChars(parseAnsi("\x1b[31mhello world\x1b[39m"), 5);
    expect(lines.map(text)).toEqual(["hello", "world"]);
    expect(lines[1]![0]!.style).toContain("\x1b[31m");
  });

  it("an empty string is one empty line", () => {
    expect(wrapStyledChars(parseAnsi(""), 10).map(text)).toEqual([""]);
  });
});

describe("renderer wraps prose to the box width", () => {
  it("wraps a paragraph across rows at the container width", () => {
    const handle = mountForTest(
      h(
        "eve-box",
        { flexDirection: "column", width: 10 },
        h("eve-text", null, "the quick brown fox jumps"),
      ),
      { width: 12, height: 6 },
    );
    // width 10 -> "the quick" (9) | "brown fox" (9) | "jumps" (5)
    expect(handle.captureCharFrame()).toBe("the quick\nbrown fox\njumps");
    handle.unmount();
  });
});
