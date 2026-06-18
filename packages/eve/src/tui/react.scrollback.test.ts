import { describe, expect, it } from "vitest";

import type { Cell } from "./cells/buffer.js";
import { createScrollbackPresenter, lineToAnsi } from "./cells/scrollback.js";

/** A row of unstyled cells from a string. */
function row(text: string): Cell[] {
  return [...text].map((char) => ({ char, style: "" }));
}

describe("lineToAnsi", () => {
  it("trims trailing blanks (the live-region erase covers the rest)", () => {
    expect(lineToAnsi(row("hi   "))).toBe("hi");
    expect(lineToAnsi(row(""))).toBe("");
  });
});

describe("scrollback presenter", () => {
  it("first paint hides the cursor and does not clear the screen", () => {
    const presenter = createScrollbackPresenter();
    const frame = presenter.present([row("alpha"), row("> _")], 1);
    expect(frame).toContain("\x1b[?25l"); // hide cursor
    expect(frame).not.toContain("\x1b[2J"); // never wipes scrollback
    expect(frame).toContain("alpha");
    expect(frame).toContain("> _");
  });

  it("commits settled lines once, then repaints only the live tail", () => {
    const presenter = createScrollbackPresenter();
    presenter.present([row("alpha"), row("beta"), row("> _")], 2);

    // Only the footer changes; the two settled lines are already in scrollback
    // and must NOT be reprinted — only the live region is erased and redrawn.
    const frame = presenter.present([row("alpha"), row("beta"), row("> hi")], 2);
    expect(frame).not.toContain("alpha");
    expect(frame).not.toContain("beta");
    expect(frame).toContain("\x1b[0J"); // erase the live region
    expect(frame).toContain("> hi");
  });

  it("commits a line as it settles out of the live region", () => {
    const presenter = createScrollbackPresenter();
    presenter.present([row("a"), row("live")], 1); // live region = ["live"]
    // "live" settles into the transcript and a new footer appears below it.
    const frame = presenter.present([row("a"), row("live"), row("foot")], 2);
    expect(frame).toContain("live"); // newly committed this frame
    expect(frame).toContain("foot");
    expect(frame).not.toContain("a\n"); // "a" was already committed
  });

  it("replays (full clear) when committed content changes retroactively", () => {
    const presenter = createScrollbackPresenter();
    presenter.present([row("x"), row("foot")], 1);
    const frame = presenter.present([row("y"), row("foot")], 1); // committed x -> y
    expect(frame).toContain("\x1b[2J"); // can't rewrite scrollback -> replay
    expect(frame).toContain("y");
  });

  it("emits nothing meaningful on an idle repaint with no live region", () => {
    const presenter = createScrollbackPresenter();
    const first = presenter.present([row("only")], 1); // all committed, no live tail
    expect(first).toContain("only");
  });
});
