import { describe, expect, it, vi } from "vitest";

import { createDevToolsEventHub } from "./event-hub.js";

describe("createDevToolsEventHub", () => {
  it("bounds replay and reports stale cursors", () => {
    const hub = createDevToolsEventHub({ replayLimit: 2 });
    hub.publish("one", () => ({ value: 1 }));
    hub.publish("two", () => ({ value: 2 }));
    hub.publish("three", () => ({ value: 3 }));

    expect(hub.replayAfter("1")).toEqual({
      events: [
        { data: { value: 2 }, event: "two", id: "2" },
        { data: { value: 3 }, event: "three", id: "3" },
      ],
      stale: false,
    });
    expect(hub.replayAfter("0").stale).toBe(false);

    hub.publish("four", () => ({ value: 4 }));
    expect(hub.replayAfter("1").stale).toBe(true);
    expect(hub.replayAfter("99").stale).toBe(true);
  });

  it("removes a subscriber that applies backpressure", () => {
    const hub = createDevToolsEventHub({ replayLimit: 2 });
    const subscriber = vi.fn(() => false);
    hub.subscribe(subscriber);

    hub.publish("one", () => ({}));
    hub.publish("two", () => ({}));

    expect(subscriber).toHaveBeenCalledTimes(1);
  });
});
