import { describe, expect, it } from "vitest";

import {
  createOptimisticChatMessage,
  hasConfirmedChatMessage,
  isBreakpointPause,
} from "@ui/controllers/live/use-live-controller";

describe("isBreakpointPause", () => {
  it("recognizes explicit and CDP breakpoint pauses", () => {
    expect(isBreakpointPause({ reason: "breakpoint" })).toBe(true);
    expect(isBreakpointPause({ hitBreakpoints: ["breakpoint-1"], reason: "other" })).toBe(true);
  });

  it("does not treat stepping or manual pauses as breakpoint hits", () => {
    expect(isBreakpointPause({ hitBreakpoints: [], reason: "step" })).toBe(false);
    expect(isBreakpointPause({ reason: "other" })).toBe(false);
  });
});

describe("createOptimisticChatMessage", () => {
  it("creates a visible pending user message before server confirmation", () => {
    expect(createOptimisticChatMessage("Hello agent", "submission-1", "session-1")).toEqual({
      id: "optimistic:submission-1:user",
      optimistic: true,
      parts: [{ state: "done", text: "Hello agent", type: "text" }],
      role: "user",
      sessionId: "session-1",
      status: "streaming",
    });
  });
});

describe("hasConfirmedChatMessage", () => {
  it("ignores an older matching message and accepts the authoritative newer event", () => {
    const messages = [
      {
        id: "turn-1:user",
        parts: [
          { eventId: "event-4", state: "done" as const, text: "Again", type: "text" as const },
        ],
        role: "user" as const,
        sessionId: "session-1",
        status: "complete" as const,
      },
      {
        id: "turn-2:user",
        parts: [
          { eventId: "event-8", state: "done" as const, text: "Again", type: "text" as const },
        ],
        role: "user" as const,
        sessionId: "session-1",
        status: "complete" as const,
      },
    ];

    expect(hasConfirmedChatMessage(messages.slice(0, 1), "Again", 6)).toBe(false);
    expect(hasConfirmedChatMessage(messages, "Again", 6)).toBe(true);
  });
});
