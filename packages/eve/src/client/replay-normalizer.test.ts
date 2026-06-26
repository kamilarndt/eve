import { describe, expect, it } from "vitest";

import { ReplayNormalizer } from "#client/replay-normalizer.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

describe("ReplayNormalizer", () => {
  it("suppresses only repeated event IDs", () => {
    const normalizer = new ReplayNormalizer();
    const first = event("turn.started", "step_1:0", 0, "turn_0");
    const second = event("turn.completed", "step_1:1", 0, "turn_0");

    expect(
      [first, first, second, second].filter((value) => normalizer.shouldExpose(value)),
    ).toEqual([first, second]);
  });

  it("exposes every new ID regardless of turn coordinates", () => {
    const normalizer = new ReplayNormalizer();
    const events = [
      event("turn.started", "step_1:0", 4, "turn_4"),
      event("subagent.called", "step_2:0", 0, "workflow-dispatch"),
      event("action.result", "step_3:0", 2, "turn_2"),
      event("session.waiting", "step_4:0", 1, "turn_1"),
    ];

    expect(events.filter((value) => normalizer.shouldExpose(value))).toEqual(events);
  });

  it("preserves equal payloads with distinct event IDs", () => {
    const normalizer = new ReplayNormalizer();
    const first = event("message.appended", "step_1:0", 0, "turn_0");
    const second = event("message.appended", "step_1:1", 0, "turn_0");

    expect(normalizer.shouldExpose(first)).toBe(true);
    expect(normalizer.shouldExpose(second)).toBe(true);
  });

  it("restores seen event IDs across reconnects", () => {
    const first = new ReplayNormalizer();
    const started = event("turn.started", "step_1:0", 0, "turn_0");
    const message = event("message.appended", "step_1:1", 0, "turn_0");
    first.shouldExpose(started);
    first.shouldExpose(message);

    const restored = new ReplayNormalizer(first.seenEventIds);

    expect(restored.shouldExpose(started)).toBe(false);
    expect(restored.shouldExpose(message)).toBe(false);
    expect(restored.shouldExpose(event("turn.completed", "step_1:2", 0, "turn_0"))).toBe(true);
  });

  it("uses the first observation when one ID carries conflicting data", () => {
    const normalizer = new ReplayNormalizer();
    const first = event("turn.started", "step_1:0", 0, "turn_0");
    const conflict = event("action.result", "step_1:0", 9, "other-turn");

    expect(normalizer.shouldExpose(first)).toBe(true);
    expect(normalizer.shouldExpose(conflict)).toBe(false);
  });

  it("always exposes events without an ID", () => {
    const normalizer = new ReplayNormalizer();
    const legacy = { data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" } as const;

    expect(normalizer.shouldExpose(legacy)).toBe(true);
    expect(normalizer.shouldExpose(legacy)).toBe(true);
  });
});

function event(
  type: HandleMessageStreamEvent["type"],
  eventId: string,
  sequence: number,
  turnId: string,
): HandleMessageStreamEvent {
  const data =
    type === "session.waiting"
      ? { sequence, turnId, wait: "next-user-message" as const }
      : { sequence, turnId };
  return {
    data,
    meta: { at: "2026-06-26T00:00:00.000Z", eventId },
    type,
  } as HandleMessageStreamEvent;
}
