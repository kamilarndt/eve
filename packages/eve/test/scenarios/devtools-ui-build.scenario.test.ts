import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DEVTOOLS_UI_ROOT = fileURLToPath(new URL("../../dist/devtools-ui", import.meta.url));

describe("DevTools UI package assets", () => {
  it("emits one self-contained hashed frontend bundle", async () => {
    const manifest = JSON.parse(
      await readFile(join(DEVTOOLS_UI_ROOT, ".vite", "manifest.json"), "utf8"),
    ) as Record<
      string,
      {
        readonly assets?: readonly string[];
        readonly css?: readonly string[];
        readonly file: string;
        readonly isEntry?: boolean;
      }
    >;
    const entry = manifest["index.html"];

    expect(entry).toMatchObject({ isEntry: true });
    expect(entry?.file).toMatch(/^assets\/index-[A-Za-z0-9_-]+\.js$/u);
    expect(entry?.css).toHaveLength(1);
    expect(entry?.assets).toHaveLength(2);

    const emittedAssets = (await readdir(join(DEVTOOLS_UI_ROOT, "assets"))).sort();
    const manifestAssets = [entry?.file, ...(entry?.css ?? []), ...(entry?.assets ?? [])]
      .filter((path): path is string => path !== undefined)
      .map((path) => path.replace(/^assets\//u, ""))
      .sort();

    expect(emittedAssets).toEqual(manifestAssets);
  });
});
