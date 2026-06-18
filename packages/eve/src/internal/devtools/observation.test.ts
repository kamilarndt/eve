import { describe, expect, it, vi } from "vitest";

import { createDevObservationSink } from "./observation.js";

describe("createDevObservationSink", () => {
  it("does not construct records when disabled", () => {
    const createData = vi.fn(() => ({ ok: true }));
    const sink = createDevObservationSink({
      enabled: false,
      runtimeInstanceId: "runtime-1",
      writeLine: vi.fn(),
    });

    expect(sink.emit("test.record", createData)).toBe(false);
    expect(createData).not.toHaveBeenCalled();
  });

  it("drops overflow records and emits one dropped summary after capacity returns", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const lines: string[] = [];
    const writeLine = vi.fn(async (line: string) => {
      lines.push(line);
      if (lines.length === 1) {
        await blocked;
      }
    });
    const sink = createDevObservationSink({
      capacity: 1,
      enabled: true,
      runtimeInstanceId: "runtime-1",
      writeLine,
    });

    expect(sink.emit("first", () => ({ value: 1 }))).toBe(true);
    expect(sink.emit("second", () => ({ value: 2 }))).toBe(false);
    expect(sink.emit("third", () => ({ value: 3 }))).toBe(false);

    unblock();
    await vi.waitFor(() => {
      expect(lines.length).toBe(2);
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      data: { value: 1 },
      runtimeInstanceId: "runtime-1",
      schemaVersion: 1,
      type: "first",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      data: { dropped: 2 },
      runtimeInstanceId: "runtime-1",
      schemaVersion: 1,
      type: "observation.dropped",
    });
  });

  it("swallows writer failures after a once-per-process warning", async () => {
    const warn = vi.fn();
    const sink = createDevObservationSink({
      enabled: true,
      runtimeInstanceId: "runtime-1",
      warn,
      writeLine: vi.fn(async () => {
        throw new Error("pipe closed");
      }),
    });

    expect(sink.emit("first", () => ({ value: 1 }))).toBe(true);
    expect(sink.emit("second", () => ({ value: 2 }))).toBe(true);

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
