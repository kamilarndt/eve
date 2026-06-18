import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import { Markdown, lineSegments, parseInline } from "./components/markdown.js";
import { toneStyle } from "./components/primitives.js";
import { mountForTest } from "./testing.js";

describe("parseInline", () => {
  it("splits bold from surrounding text", () => {
    const segments = parseInline("a **b** c");
    expect(segments.map((s) => s.text)).toEqual(["a ", "b", " c"]);
    expect(segments[1]!.style).toBe(toneStyle("bold"));
    expect(segments[0]!.style).toBe("");
  });

  it("styles inline code", () => {
    const segments = parseInline("run `eve dev` now");
    expect(segments.map((s) => s.text)).toEqual(["run ", "eve dev", " now"]);
    expect(segments[1]!.style).toBe(toneStyle("cyan"));
  });

  it("styles italic", () => {
    const segments = parseInline("_x_");
    expect(segments).toEqual([{ text: "x", style: toneStyle("italic") }]);
  });

  it("combines a base style with inline emphasis", () => {
    const base = toneStyle("dim");
    const segments = parseInline("hi **bold**", base);
    expect(segments[0]!.style).toBe(base);
    expect(segments[1]!.style).toBe(base + toneStyle("bold"));
  });
});

describe("lineSegments", () => {
  it("prefixes headings with their glyph", () => {
    expect(lineSegments("# Title")[0]).toEqual({ text: "█ ", style: toneStyle("bold") });
  });
  it("prefixes list items with a bullet", () => {
    expect(lineSegments("- item")[0]).toEqual({ text: "• ", style: "" });
  });
});

describe("parseInline URL shielding", () => {
  it("keeps a URL with underscores intact (no italics)", () => {
    const segments = parseInline("see https://example.com/sca_live_token_x for details");
    const url = segments.find((s) => s.text.includes("example.com"));
    expect(url).toBeDefined();
    expect(url!.text).toBe("https://example.com/sca_live_token_x");
    // The URL run carries the base (default) style — no italic from the `_`s.
    expect(url!.style).toBe("");
    // Reassembled text preserves every underscore.
    expect(segments.map((s) => s.text).join("")).toBe(
      "see https://example.com/sca_live_token_x for details",
    );
  });

  it("still applies emphasis to text outside a URL", () => {
    const segments = parseInline("**bold** https://x.com/a_b _italic_");
    const bold = segments.find((s) => s.text === "bold");
    const italic = segments.find((s) => s.text === "italic");
    expect(bold!.style).toBe(toneStyle("bold"));
    expect(italic!.style).toBe(toneStyle("italic"));
    expect(segments.find((s) => s.text === "https://x.com/a_b")!.style).toBe("");
  });
});

describe("Markdown renders GFM tables", () => {
  it("aligns columns (left header, right-aligned numbers) with a separator row", () => {
    const source = ["| Name | Age |", "| --- | ---: |", "| Bob | 3 |"].join("\n");
    const handle = mountForTest(h(Markdown, { source }), { width: 40, height: 6 });
    expect(handle.captureCharFrame()).toBe(["Name  Age", "────  ───", "Bob     3"].join("\n"));
    handle.unmount();
  });

  it("center-aligns a column", () => {
    const source = ["| A | B |", "| :---: | --- |", "| x | y |"].join("\n");
    const handle = mountForTest(h(Markdown, { source }), { width: 40, height: 6 });
    // Column A width is 3 (min); "x" centered in 3 -> " x".
    expect(handle.captureCharFrame()).toBe([" A   B", "───  ───", " x   y"].join("\n"));
    handle.unmount();
  });
});

describe("Markdown component renders a block tree", () => {
  it("renders headings, lists, and inline emphasis as visible text", () => {
    const handle = mountForTest(h(Markdown, { source: "# Title\n- item\n**bold** text" }), {
      width: 40,
      height: 6,
    });
    expect(handle.captureCharFrame()).toBe("█ Title\n• item\nbold text");
    handle.unmount();
  });

  it("wraps a long paragraph at the available width", () => {
    const handle = mountForTest(
      h(
        "eve-box",
        { flexDirection: "column", width: 10 },
        h(Markdown, { source: "the quick brown fox" }),
      ),
      { width: 12, height: 6 },
    );
    expect(handle.captureCharFrame()).toBe("the quick\nbrown fox");
    handle.unmount();
  });
});
