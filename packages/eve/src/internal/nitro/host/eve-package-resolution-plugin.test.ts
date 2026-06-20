import { describe, expect, it } from "vitest";

import { resolvePackageDependencyPath } from "#internal/application/package.js";
import { createEvePackageResolutionPlugin } from "./eve-package-resolution-plugin.js";

describe("createEvePackageResolutionPlugin", () => {
  it("binds authored eve imports to the executing framework installation", () => {
    const plugin = createEvePackageResolutionPlugin();

    expect(plugin.resolveId("eve/channels/auth")).toEqual({
      external: false,
      id: resolvePackageDependencyPath("eve/channels/auth"),
    });
  });

  it("leaves non-eve imports to the remaining resolvers", () => {
    const plugin = createEvePackageResolutionPlugin();

    expect(plugin.resolveId("@example/package")).toBeNull();
    expect(plugin.resolveId("whatever")).toBeNull();
  });
});
