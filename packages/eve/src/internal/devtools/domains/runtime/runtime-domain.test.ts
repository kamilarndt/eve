import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevToolsEventHub } from "#internal/devtools/event-hub.js";
import type { DevToolsRuntimeState } from "#internal/devtools/host/types.js";
import { createDevToolsRuntimeDomain } from "./runtime-domain.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("#client/index.js", () => ({
  Client: class {
    fetch = mocks.fetch;
  },
}));

describe("createDevToolsRuntimeDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes a safe public state and preserves the last agent snapshot while paused", async () => {
    let state: DevToolsRuntimeState = {
      inspectorUrl: "ws://127.0.0.1:9229/session",
      runtimeInstanceId: "runtime-1",
      runtimeUrl: "http://127.0.0.1:3000/",
      status: "ready",
    };
    mocks.fetch.mockResolvedValueOnce(Response.json({ name: "Weather" }));
    const domain = createDevToolsRuntimeDomain({
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    await expect(domain.getAgentSnapshot()).resolves.toEqual({ agent: { name: "Weather" } });
    expect(domain.getPublicState()).not.toHaveProperty("inspectorUrl");
    expect(domain.assertInteractive()).toBe("http://127.0.0.1:3000/");

    state = { ...state, status: "paused" };
    await expect(domain.getAgentSnapshot()).resolves.toEqual({
      agent: { name: "Weather" },
      diagnostics: [{ message: "Runtime is paused; showing the last agent snapshot." }],
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(() => domain.assertInteractive()).toThrow(/while paused/u);
  });

  it("publishes revision changes and ignores unavailable revision responses", async () => {
    let state: DevToolsRuntimeState = {
      revision: "rev-1",
      runtimeInstanceId: "runtime-1",
      runtimeUrl: "http://127.0.0.1:3000/",
      status: "ready",
    };
    const eventHub = createDevToolsEventHub({ replayLimit: 10 });
    mocks.fetch
      .mockResolvedValueOnce(Response.json({ revision: "rev-2" }))
      .mockRejectedValueOnce(new Error("runtime rebuilding"));
    const domain = createDevToolsRuntimeDomain({
      eventHub,
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });

    await domain.refreshRevision();
    expect(state.revision).toBe("rev-2");
    expect(eventHub.replayAfter("0").events).toMatchObject([
      { data: { runtime: { revision: "rev-2" } }, event: "runtime.state" },
    ]);

    await expect(domain.refreshRevision()).resolves.toBeUndefined();
    expect(state.revision).toBe("rev-2");
  });
});
