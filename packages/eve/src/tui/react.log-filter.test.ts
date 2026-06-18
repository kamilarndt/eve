import { describe, expect, it } from "vitest";

import type { Block } from "../cli/dev/tui/blocks.js";
import { isLogHidden, visibleBlocks } from "./log-filter.js";

const stdout: Block = { kind: "log", title: "stdout", body: "listening" };
const stderr: Block = { kind: "log", title: "stderr", body: "warn" };
const sandbox: Block = { kind: "sandbox", body: "sandbox ready" };
const assistant: Block = { kind: "assistant", body: "hi" };

describe("isLogHidden mirrors #shouldRenderLog", () => {
  it("'all' shows everything", () => {
    for (const b of [stdout, stderr, sandbox, assistant]) expect(isLogHidden(b, "all")).toBe(false);
  });
  it("'none' hides log + sandbox, keeps prose", () => {
    expect(isLogHidden(stdout, "none")).toBe(true);
    expect(isLogHidden(stderr, "none")).toBe(true);
    expect(isLogHidden(sandbox, "none")).toBe(true);
    expect(isLogHidden(assistant, "none")).toBe(false);
  });
  it("'stderr' keeps only stderr logs", () => {
    expect(isLogHidden(stdout, "stderr")).toBe(true);
    expect(isLogHidden(stderr, "stderr")).toBe(false);
    expect(isLogHidden(sandbox, "stderr")).toBe(true);
  });
  it("'sandbox' keeps only sandbox", () => {
    expect(isLogHidden(stdout, "sandbox")).toBe(true);
    expect(isLogHidden(stderr, "sandbox")).toBe(true);
    expect(isLogHidden(sandbox, "sandbox")).toBe(false);
  });
});

describe("visibleBlocks", () => {
  it("filters by mode but never drops non-log blocks", () => {
    const all = [assistant, stdout, stderr, sandbox];
    expect(visibleBlocks(all, "none")).toEqual([assistant]);
    expect(visibleBlocks(all, "stderr")).toEqual([assistant, stderr]);
    expect(visibleBlocks(all, "all")).toEqual(all);
    expect(visibleBlocks(all)).toEqual(all); // default "all"
  });
});
