import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { atomicWriteFiles } from "#internal/application/atomic-write.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("atomicWriteFiles", () => {
  it("keeps every stable target intact and cleans staged files when staging fails", async () => {
    const root = await createScratchDirectory("eve-atomic-write-");
    const firstPath = join(root, "first.mjs");
    const secondPath = join(root, "second.mjs");
    await Promise.all([writeFile(firstPath, "first-old\n"), writeFile(secondPath, "second-old\n")]);

    await expect(
      atomicWriteFiles([
        { contents: "first-new\n", path: firstPath },
        { contents: "cannot-stage\n", path: join(root, "missing", "second.mjs") },
      ]),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(readFile(firstPath, "utf8")).resolves.toBe("first-old\n");
    await expect(readFile(secondPath, "utf8")).resolves.toBe("second-old\n");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces a complete staged file set", async () => {
    const root = await createScratchDirectory("eve-atomic-write-success-");
    const firstPath = join(root, "first.mjs");
    const secondPath = join(root, "second.mjs");
    await mkdir(root, { recursive: true });

    await atomicWriteFiles([
      { contents: "first\n", path: firstPath },
      { contents: "second\n", path: secondPath },
    ]);

    await expect(readFile(firstPath, "utf8")).resolves.toBe("first\n");
    await expect(readFile(secondPath, "utf8")).resolves.toBe("second\n");
  });
});
