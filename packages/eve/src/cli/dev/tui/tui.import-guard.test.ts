import { describe, expect, it } from "vitest";

import { translateRendererImportError } from "./tui.js";

/**
 * Renderer import guard (review finding #1).
 *
 * The optional peers (react / react-reconciler / yoga-layout) may be absent in a
 * published install; the lazy `import("#tui/react-renderer.js")` then rejects
 * with ERR_MODULE_NOT_FOUND (verified separately: a transitive missing static
 * import rejects the dynamic import() promise with that code). This guard must
 * translate that into actionable install guidance and pass everything else
 * through untouched.
 */
describe("translateRendererImportError (finding #1)", () => {
  it("turns a missing optional peer into actionable install guidance", () => {
    const cause = Object.assign(new Error("Cannot find package 'react'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const result = translateRendererImportError(cause);
    expect(result.message).toMatch(/react-reconciler/);
    expect(result.message).toMatch(/yoga-layout/);
    expect(result.message).toMatch(/npm install/);
    expect(result.cause).toBe(cause);
  });

  it("passes unrelated errors through unchanged", () => {
    const other = new Error("boom");
    expect(translateRendererImportError(other)).toBe(other);
  });

  it("wraps non-Error throwables", () => {
    expect(translateRendererImportError("nope")).toBeInstanceOf(Error);
  });
});
