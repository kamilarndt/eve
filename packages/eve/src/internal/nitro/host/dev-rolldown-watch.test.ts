import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createDevelopmentRolldownWatchExclusions } from "#internal/nitro/host/dev-rolldown-watch.js";

describe("createDevelopmentRolldownWatchExclusions", () => {
  it("matches each coordinated path and its descendants without matching siblings", () => {
    const appRoot = resolve("/repo/apps/notes");
    const extensionRoot = resolve("/repo/packages/notes-extension");
    const exclusions = createDevelopmentRolldownWatchExclusions(
      [appRoot, extensionRoot, appRoot],
      appRoot,
    );

    const isExcluded = (path: string) => exclusions.some((pattern) => pattern.test(path));

    expect(exclusions).toHaveLength(3);
    expect(isExcluded(appRoot)).toBe(true);
    expect(isExcluded(`${appRoot}/agent/tools/tell_joke.ts`)).toBe(true);
    expect(isExcluded(`${extensionRoot}/src/tools/search.ts`)).toBe(true);
    expect(isExcluded("../../packages/notes-extension/src/tools/search.ts")).toBe(true);
    expect(isExcluded(`${appRoot}-copy/agent/tools/tell_joke.ts`)).toBe(false);
    expect(isExcluded("/repo/packages/unrelated/src/index.ts")).toBe(false);
  });

  it("matches app-relative generated module ids emitted by Rolldown", () => {
    const appRoot = resolve("/repo/apps/notes");
    const exclusions = createDevelopmentRolldownWatchExclusions(
      [resolve(appRoot, ".eve/host"), resolve(appRoot, ".eve/nitro/workflow")],
      appRoot,
    );

    expect(exclusions.some((pattern) => pattern.test(".eve/host/bootstrap.mjs"))).toBe(true);
    expect(exclusions.some((pattern) => pattern.test("./.eve/nitro/workflow/steps.mjs"))).toBe(
      true,
    );
  });

  it("escapes regular-expression characters in filesystem paths", () => {
    const path = resolve("/repo/apps/notes [local]");
    const [exclusion] = createDevelopmentRolldownWatchExclusions([path]);

    expect(exclusion?.test(`${path}/agent.ts`)).toBe(true);
    expect(exclusion?.test(resolve("/repo/apps/notes l/agent.ts"))).toBe(false);
  });
});
