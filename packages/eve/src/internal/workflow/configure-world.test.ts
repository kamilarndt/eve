import { beforeEach, describe, expect, it, vi } from "vitest";

import { installConfiguredWorkflowWorld } from "#internal/workflow/configure-world.js";

const mocks = vi.hoisted(() => ({
  setWorld: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  setWorld: mocks.setWorld,
}));

describe("installConfiguredWorkflowWorld", () => {
  beforeEach(() => {
    mocks.setWorld.mockClear();
  });

  it("installs and starts a world from the module default export", async () => {
    const world = createMockWorld();
    const createWorld = vi.fn(() => world);

    await expect(
      installConfiguredWorkflowWorld({
        module: { default: createWorld },
      }),
    ).resolves.toBe(world);

    expect(createWorld).toHaveBeenCalledOnce();
    expect(mocks.setWorld).toHaveBeenCalledWith(world);
    expect(world.start).toHaveBeenCalledOnce();
  });

  it("falls back to a createWorld export when no export name is configured", async () => {
    const world = createMockWorld();

    await installConfiguredWorkflowWorld({
      module: { createWorld: () => world },
    });

    expect(mocks.setWorld).toHaveBeenCalledWith(world);
  });

  it("rejects modules without a default or createWorld factory", async () => {
    await expect(
      installConfiguredWorkflowWorld({
        module: {},
      }),
    ).rejects.toThrow(
      'Configured Workflow world module must export a default function or "createWorld" function.',
    );

    expect(mocks.setWorld).not.toHaveBeenCalled();
  });

  it("rejects factories that do not return a Workflow World", async () => {
    await expect(
      installConfiguredWorkflowWorld({
        module: { default: () => ({}) },
      }),
    ).rejects.toThrow("Configured Workflow world factory did not return a valid World.");

    expect(mocks.setWorld).not.toHaveBeenCalled();
  });

  it("skips the compatibility check when no packageName is provided", async () => {
    const world = createMockWorld();

    // No packageName — should install without attempting to resolve any package.json.
    await expect(
      installConfiguredWorkflowWorld({
        module: { default: () => world },
      }),
    ).resolves.toBe(world);
  });

  it("skips the compatibility check when BUNDLED_WORKFLOW_WORLD_MAJOR is unstamped", async () => {
    // In unit tests the token is never stamped, so the check must be a no-op.
    const world = createMockWorld();

    await expect(
      installConfiguredWorkflowWorld({
        module: { default: () => world },
        packageName: "@workflow/world-postgres",
      }),
    ).resolves.toBe(world);
  });
});

function createMockWorld() {
  return {
    createQueueHandler: vi.fn(),
    events: {},
    start: vi.fn(),
  };
}
