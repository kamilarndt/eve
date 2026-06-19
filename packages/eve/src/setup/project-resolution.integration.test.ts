import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readProjectLink, writeProjectLink } from "./project-resolution.js";

describe("writeProjectLink", () => {
  it("writes and rereads an idempotent Vercel project link", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-project-link-"));
    const link = {
      projectId: "prj_demo",
      orgId: "team_demo",
      projectName: "demo-agent",
    };

    try {
      await writeFile(join(projectRoot, ".gitignore"), "node_modules\n", "utf8");
      await writeProjectLink({ projectRoot, link });
      await writeProjectLink({ projectRoot, link });

      await expect(readProjectLink(projectRoot)).resolves.toEqual(link);
      await expect(readFile(join(projectRoot, ".vercel", "project.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(link, null, 2)}\n`,
      );
      await expect(readFile(join(projectRoot, ".gitignore"), "utf8")).resolves.toBe(
        "node_modules\n.vercel\n",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps using a legacy .now link instead of creating a conflicting .vercel directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-project-link-legacy-"));
    const link = {
      projectId: "prj_legacy",
      orgId: "team_legacy",
      projectName: "legacy-agent",
    };

    try {
      await mkdir(join(projectRoot, ".now"));
      await writeProjectLink({ projectRoot, link });

      await expect(readProjectLink(projectRoot)).resolves.toEqual(link);
      await expect(readFile(join(projectRoot, ".now", "project.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(link, null, 2)}\n`,
      );
      await expect(readdir(projectRoot)).resolves.not.toContain(".vercel");
      await expect(readFile(join(projectRoot, ".gitignore"), "utf8")).resolves.toBe(".now\n");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects conflicting current and legacy link directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-project-link-conflict-"));
    const link = {
      projectId: "prj_demo",
      orgId: "team_demo",
      projectName: "demo-agent",
    };

    try {
      await Promise.all([mkdir(join(projectRoot, ".vercel")), mkdir(join(projectRoot, ".now"))]);

      await expect(writeProjectLink({ projectRoot, link })).rejects.toThrow(
        "Both .vercel and legacy .now",
      );
      await expect(readProjectLink(projectRoot)).resolves.toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves the previous link when interrupted before the atomic rename", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "eve-project-link-abort-"));
    const original = {
      projectId: "prj_original",
      orgId: "team_demo",
      projectName: "original-agent",
    };
    const replacement = { ...original, projectId: "prj_replacement" };

    try {
      await writeProjectLink({ projectRoot, link: original });
      const signal = new AbortController().signal;
      let checks = 0;
      Object.defineProperty(signal, "throwIfAborted", {
        value() {
          checks += 1;
          if (checks === 4) throw new DOMException("This operation was aborted", "AbortError");
        },
      });

      await expect(writeProjectLink({ projectRoot, link: replacement, signal })).rejects.toThrow(
        "This operation was aborted",
      );
      await expect(readProjectLink(projectRoot)).resolves.toEqual(original);
      await expect(readdir(join(projectRoot, ".vercel"))).resolves.toEqual(["project.json"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
