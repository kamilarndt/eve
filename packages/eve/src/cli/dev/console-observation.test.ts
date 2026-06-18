import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { DevObservationSink } from "#internal/devtools/observation.js";
import { observeConsoleContext } from "./console-observation.js";

describe("observeConsoleContext", () => {
  it("correlates authored console calls with their active session", async () => {
    const emit = vi.fn<DevObservationSink["emit"]>(() => true);
    const log = vi.fn();
    const target = createConsole(log);
    const restore = observeConsoleContext({ emit }, target);
    const ctx = new ContextContainer();
    ctx.setVirtualContext(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn-2", sequence: 2 },
    });

    await contextStorage.run(ctx, async () => {
      target.log("dynamic echo", 42);
    });

    expect(log).toHaveBeenCalledWith("dynamic echo", 42);
    expect(emit).toHaveBeenCalledWith("runtime.console.context", expect.any(Function));
    expect(emit.mock.calls[0]?.[1]()).toEqual({
      coordinates: { session: "session-1", turn: "turn-2" },
      fingerprint: '[["string","dynamic echo"],["number","42"]]',
      type: "log",
    });

    restore();
    expect(target.log).toBe(log);
  });
});

function createConsole(
  log: (...args: unknown[]) => void,
): Pick<Console, "debug" | "error" | "info" | "log" | "trace" | "warn"> {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log,
    trace: vi.fn(),
    warn: vi.fn(),
  };
}
