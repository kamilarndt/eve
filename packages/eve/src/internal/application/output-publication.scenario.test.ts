import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  publishApplicationBuildArtifacts,
  resolveOutputPublicationLockPath,
} from "#internal/application/output-publication.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

async function writePublicationFixture(input: {
  readonly outputDir: string;
  readonly outputMarker: string;
  readonly summaryMarker: string;
  readonly summaryPath: string;
}): Promise<void> {
  await mkdir(input.outputDir, { recursive: true });
  await mkdir(join(input.summaryPath, ".."), { recursive: true });
  await writeFile(join(input.outputDir, "marker.txt"), `${input.outputMarker}\n`);
  await writeFile(input.summaryPath, `${input.summaryMarker}\n`);
}

describe("build output publication", () => {
  it("publishes staged output and its matching summary together", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const stagedOutputDir = join(appRoot, ".eve", "builds", "one", "output");
    const stagedSummaryPath = join(appRoot, ".eve", "builds", "one", "summary.json");
    await writePublicationFixture({
      outputDir: finalOutputDir,
      outputMarker: "old-output",
      summaryMarker: "old-summary",
      summaryPath: finalSummaryPath,
    });
    await writePublicationFixture({
      outputDir: stagedOutputDir,
      outputMarker: "new-output",
      summaryMarker: "new-summary",
      summaryPath: stagedSummaryPath,
    });

    await publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir,
      stagedSummaryPath,
    });

    await expect(readFile(join(finalOutputDir, "marker.txt"), "utf8")).resolves.toBe(
      "new-output\n",
    );
    await expect(readFile(finalSummaryPath, "utf8")).resolves.toBe("new-summary\n");
  });

  it("restores the complete previous publication when promotion fails", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-rollback-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const stagedOutputDir = join(appRoot, ".eve", "builds", "failed", "output");
    const stagedSummaryPath = join(appRoot, ".eve", "builds", "failed", "summary.json");
    await writePublicationFixture({
      outputDir: finalOutputDir,
      outputMarker: "last-good-output",
      summaryMarker: "last-good-summary",
      summaryPath: finalSummaryPath,
    });
    await writePublicationFixture({
      outputDir: stagedOutputDir,
      outputMarker: "failed-output",
      summaryMarker: "failed-summary",
      summaryPath: stagedSummaryPath,
    });

    await expect(
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir,
        stagedSummaryPath,
        onAfterOutputInstall() {
          throw new Error("injected publication failure");
        },
      }),
    ).rejects.toThrow("injected publication failure");

    await expect(readFile(join(finalOutputDir, "marker.txt"), "utf8")).resolves.toBe(
      "last-good-output\n",
    );
    await expect(readFile(finalSummaryPath, "utf8")).resolves.toBe("last-good-summary\n");
    await expect(readFile(join(stagedOutputDir, "marker.txt"), "utf8")).resolves.toBe(
      "failed-output\n",
    );
  });

  it("serializes only the publication window for concurrent completed builds", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-concurrent-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const firstOutputDir = join(appRoot, ".eve", "builds", "first", "output");
    const firstSummaryPath = join(appRoot, ".eve", "builds", "first", "summary.json");
    const secondOutputDir = join(appRoot, ".eve", "builds", "second", "output");
    const secondSummaryPath = join(appRoot, ".eve", "builds", "second", "summary.json");
    await writePublicationFixture({
      outputDir: firstOutputDir,
      outputMarker: "first",
      summaryMarker: "first",
      summaryPath: firstSummaryPath,
    });
    await writePublicationFixture({
      outputDir: secondOutputDir,
      outputMarker: "second",
      summaryMarker: "second",
      summaryPath: secondSummaryPath,
    });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondHook = vi.fn();
    const first = publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: firstOutputDir,
      stagedSummaryPath: firstSummaryPath,
      async onAfterBackup() {
        firstEntered.resolve();
        await releaseFirst.promise;
      },
    });
    await firstEntered.promise;
    const second = publishApplicationBuildArtifacts({
      appRoot,
      finalOutputDir,
      finalSummaryPath,
      stagedOutputDir: secondOutputDir,
      stagedSummaryPath: secondSummaryPath,
      onAfterBackup: secondHook,
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(secondHook).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(secondHook).toHaveBeenCalledOnce();
    await expect(readFile(join(finalOutputDir, "marker.txt"), "utf8")).resolves.toBe("second\n");
    await expect(readFile(finalSummaryPath, "utf8")).resolves.toBe("second\n");
  });

  it("recovers an interrupted publication before allowing the next publisher", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-recovery-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const staleOutputDir = join(appRoot, ".eve", "builds", "stale", "output");
    const staleSummaryPath = join(appRoot, ".eve", "builds", "stale", "summary.json");
    const nextOutputDir = join(appRoot, ".eve", "builds", "next", "output");
    const nextSummaryPath = join(appRoot, ".eve", "builds", "next", "summary.json");
    const staleToken = "stale-token";
    const outputBackupPath = `${finalOutputDir}.eve-backup-${staleToken}`;
    const summaryBackupPath = `${finalSummaryPath}.eve-backup-${staleToken}`;
    await writePublicationFixture({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublicationFixture({
      outputDir: staleOutputDir,
      outputMarker: "interrupted",
      summaryMarker: "interrupted",
      summaryPath: staleSummaryPath,
    });
    await writePublicationFixture({
      outputDir: nextOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: nextSummaryPath,
    });
    await Promise.all([
      rename(finalOutputDir, outputBackupPath),
      rename(finalSummaryPath, summaryBackupPath),
    ]);
    const lockPath = resolveOutputPublicationLockPath(appRoot);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        finalOutputDir,
        finalSummaryPath,
        hadOutput: true,
        hadSummary: true,
        outputBackupPath,
        phase: "backed-up",
        pid: 2_147_483_647,
        stagedOutputDir: staleOutputDir,
        stagedSummaryPath: staleSummaryPath,
        startedAt: new Date(0).toISOString(),
        summaryBackupPath,
        token: staleToken,
      })}\n`,
    );

    await expect(
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir: nextOutputDir,
        stagedSummaryPath: nextSummaryPath,
        onAfterBackup() {
          throw new Error("stop after stale recovery");
        },
      }),
    ).rejects.toThrow("stop after stale recovery");

    await expect(readFile(join(finalOutputDir, "marker.txt"), "utf8")).resolves.toBe("last-good\n");
    await expect(readFile(finalSummaryPath, "utf8")).resolves.toBe("last-good\n");
  });

  it("reclaims recovery when the recovery owner also crashed", async () => {
    const appRoot = await createScratchDirectory("eve-output-publication-recovery-owner-");
    const finalOutputDir = join(appRoot, ".output");
    const finalSummaryPath = join(appRoot, ".eve", "agent-summary.json");
    const staleOutputDir = join(appRoot, ".eve", "builds", "stale", "output");
    const staleSummaryPath = join(appRoot, ".eve", "builds", "stale", "summary.json");
    const nextOutputDir = join(appRoot, ".eve", "builds", "next", "output");
    const nextSummaryPath = join(appRoot, ".eve", "builds", "next", "summary.json");
    const staleToken = "stale-recovery-token";
    const outputBackupPath = `${finalOutputDir}.eve-backup-${staleToken}`;
    const summaryBackupPath = `${finalSummaryPath}.eve-backup-${staleToken}`;
    await writePublicationFixture({
      outputDir: finalOutputDir,
      outputMarker: "last-good",
      summaryMarker: "last-good",
      summaryPath: finalSummaryPath,
    });
    await writePublicationFixture({
      outputDir: staleOutputDir,
      outputMarker: "interrupted",
      summaryMarker: "interrupted",
      summaryPath: staleSummaryPath,
    });
    await writePublicationFixture({
      outputDir: nextOutputDir,
      outputMarker: "next",
      summaryMarker: "next",
      summaryPath: nextSummaryPath,
    });
    await Promise.all([
      rename(finalOutputDir, outputBackupPath),
      rename(finalSummaryPath, summaryBackupPath),
    ]);

    const recoveryPath = `${resolveOutputPublicationLockPath(appRoot)}.recovery`;
    const recoveringOwnerPath = join(recoveryPath, "owner-crashed");
    const recoveryLeasePath = join(recoveryPath, "lease");
    await Promise.all([
      mkdir(recoveringOwnerPath, { recursive: true }),
      mkdir(recoveryLeasePath, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(recoveringOwnerPath, "owner.json"),
        `${JSON.stringify({
          finalOutputDir,
          finalSummaryPath,
          hadOutput: true,
          hadSummary: true,
          outputBackupPath,
          phase: "backed-up",
          pid: 2_147_483_647,
          stagedOutputDir: staleOutputDir,
          stagedSummaryPath: staleSummaryPath,
          startedAt: new Date(0).toISOString(),
          summaryBackupPath,
          token: staleToken,
        })}\n`,
      ),
      writeFile(
        join(recoveryLeasePath, "owner.json"),
        `${JSON.stringify({
          pid: 2_147_483_647,
          startedAt: new Date(0).toISOString(),
          token: "crashed-recoverer",
        })}\n`,
      ),
    ]);

    await expect(
      publishApplicationBuildArtifacts({
        appRoot,
        finalOutputDir,
        finalSummaryPath,
        stagedOutputDir: nextOutputDir,
        stagedSummaryPath: nextSummaryPath,
        onAfterBackup() {
          throw new Error("stop after nested recovery");
        },
      }),
    ).rejects.toThrow("stop after nested recovery");

    await expect(readFile(join(finalOutputDir, "marker.txt"), "utf8")).resolves.toBe("last-good\n");
    await expect(readFile(finalSummaryPath, "utf8")).resolves.toBe("last-good\n");
  });
});
