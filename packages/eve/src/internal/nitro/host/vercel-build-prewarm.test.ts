import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";

interface PrewarmInput {
  readonly shouldPrewarmBackend?: (backend: SandboxBackend) => boolean;
}

const mocks = vi.hoisted(() => ({
  prewarmAppSandboxes: vi.fn(async (_input: PrewarmInput) => undefined),
}));

vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmAppSandboxes: mocks.prewarmAppSandboxes,
}));

import { runBuildSandboxPrewarm } from "./vercel-build-prewarm.js";

describe("runBuildSandboxPrewarm", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("selects opted-in non-Vercel backends on ordinary builds", async () => {
    await runBuildSandboxPrewarm({ appRoot: "/tmp/app" });

    const predicate = mocks.prewarmAppSandboxes.mock.calls[0]?.[0].shouldPrewarmBackend;
    expect(
      predicate?.({
        name: "aws-lambda-microvms",
        provisioning: { prewarmAtBuild: true, requiresTemplate: true },
      } as never),
    ).toBe(true);
    expect(predicate?.({ name: "docker" } as never)).toBe(false);
  });

  it("requires a deployment id before selecting Vercel", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test");

    await runBuildSandboxPrewarm({ appRoot: "/tmp/app" });

    const predicate = mocks.prewarmAppSandboxes.mock.calls[0]?.[0].shouldPrewarmBackend;
    expect(
      predicate?.({
        name: "vercel",
        provisioning: { prewarmAtBuild: true, requiresTemplate: false },
      } as never),
    ).toBe(true);
  });
});
