import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PUBLICATION_LOCK_POLL_MS = 50;
const PUBLICATION_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;

type PublicationPhase = "acquired" | "prepared" | "backed-up" | "installed" | "committed";

interface OutputPublicationOwner {
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly outputBackupPath: string;
  pid: number;
  phase: PublicationPhase;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
  readonly startedAt: string;
  readonly summaryBackupPath: string;
  readonly token: string;
  hadOutput: boolean;
  hadSummary: boolean;
}

interface RecoveryLeaseOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

/** Publishes a completed build while preserving the previous output on failure. */
export async function publishApplicationBuildArtifacts(input: {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
  /** Test seam invoked while the publication lock is held, after old artifacts are backed up. */
  readonly onAfterBackup?: () => Promise<void> | void;
  /** Test seam invoked after staged output is installed but before its summary is installed. */
  readonly onAfterOutputInstall?: () => Promise<void> | void;
}): Promise<void> {
  const token = randomUUID();
  const lockPath = resolveOutputPublicationLockPath(input.appRoot);
  const owner: OutputPublicationOwner = {
    finalOutputDir: resolve(input.finalOutputDir),
    finalSummaryPath: resolve(input.finalSummaryPath),
    hadOutput: false,
    hadSummary: false,
    outputBackupPath: `${resolve(input.finalOutputDir)}.eve-backup-${token}`,
    phase: "acquired",
    pid: process.pid,
    stagedOutputDir: resolve(input.stagedOutputDir),
    stagedSummaryPath: resolve(input.stagedSummaryPath),
    startedAt: new Date().toISOString(),
    summaryBackupPath: `${resolve(input.finalSummaryPath)}.eve-backup-${token}`,
    token,
  };
  const release = await acquireOutputPublicationLock(lockPath, owner);
  let committed = false;

  try {
    owner.hadOutput = await pathExists(owner.finalOutputDir);
    owner.hadSummary = await pathExists(owner.finalSummaryPath);
    owner.phase = "prepared";
    await writePublicationOwner(lockPath, owner);

    await mkdir(dirname(owner.finalOutputDir), { recursive: true });
    await mkdir(dirname(owner.finalSummaryPath), { recursive: true });
    if (owner.hadOutput) {
      await rename(owner.finalOutputDir, owner.outputBackupPath);
    }
    if (owner.hadSummary) {
      await rename(owner.finalSummaryPath, owner.summaryBackupPath);
    }
    owner.phase = "backed-up";
    await writePublicationOwner(lockPath, owner);
    await input.onAfterBackup?.();

    await rename(owner.stagedOutputDir, owner.finalOutputDir);
    await input.onAfterOutputInstall?.();
    await rename(owner.stagedSummaryPath, owner.finalSummaryPath);
    owner.phase = "installed";
    await writePublicationOwner(lockPath, owner);

    owner.phase = "committed";
    await writePublicationOwner(lockPath, owner);
    committed = true;
  } catch (error) {
    try {
      await rollbackOutputPublication(owner);
    } catch (rollbackError) {
      owner.pid = 0;
      await writePublicationOwner(lockPath, owner).catch(() => {});
      throw new AggregateError(
        [error, rollbackError],
        "Build output publication failed and could not fully restore the previous output.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (committed || owner.pid !== 0) {
      await release();
    }
  }

  await removePublicationBackups(owner).catch(() => {});
}

/** Stable path for the short-lived final-output publication lock. */
export function resolveOutputPublicationLockPath(appRoot: string): string {
  return join(resolve(appRoot), ".eve", "locks", "output-publication.lock");
}

async function acquireOutputPublicationLock(
  lockPath: string,
  owner: OutputPublicationOwner,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + PUBLICATION_LOCK_TIMEOUT_MS;
  const recoveryPath = `${lockPath}.recovery`;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    if (await pathExists(recoveryPath)) {
      await recoverStalePublication(lockPath, recoveryPath, owner.token);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting ${PUBLICATION_LOCK_TIMEOUT_MS}ms to recover interrupted build output publication.`,
        );
      }
      await delay(PUBLICATION_LOCK_POLL_MS);
      continue;
    }
    try {
      await mkdir(lockPath);
      if (await pathExists(recoveryPath)) {
        await rm(lockPath, { force: true, recursive: true });
        await delay(PUBLICATION_LOCK_POLL_MS);
        continue;
      }
      try {
        await writePublicationOwner(lockPath, owner);
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }
      return async () => {
        const currentOwner = await readPublicationOwner(lockPath);
        if (currentOwner?.token !== owner.token) {
          return;
        }
        const releasedPath = `${lockPath}.released-${owner.token}`;
        try {
          await rename(lockPath, releasedPath);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        await rm(releasedPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
    }

    if (await recoverStalePublication(lockPath, recoveryPath, owner.token)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting ${PUBLICATION_LOCK_TIMEOUT_MS}ms to publish completed build output.`,
      );
    }
    await delay(PUBLICATION_LOCK_POLL_MS);
  }
}

async function recoverStalePublication(
  lockPath: string,
  recoveryPath: string,
  recoveryToken: string,
): Promise<boolean> {
  const releaseRecoveryLease = await acquireRecoveryLease(recoveryPath, recoveryToken);
  if (releaseRecoveryLease === undefined) {
    return false;
  }

  try {
    const existingOwner = await readPublicationOwner(lockPath);
    if (existingOwner !== undefined && isProcessAlive(existingOwner.pid)) {
      return false;
    }
    if (existingOwner === undefined) {
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_STALE_MS) {
          return false;
        }
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    if (await pathExists(lockPath)) {
      const recoveringOwnerPath = join(recoveryPath, `owner-${recoveryToken}`);
      try {
        await rename(lockPath, recoveringOwnerPath);
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    const entries = await readdir(recoveryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("owner-")) {
        continue;
      }
      await finishInterruptedPublication(join(recoveryPath, entry.name));
    }
    return true;
  } finally {
    await releaseRecoveryLease();
  }
}

async function acquireRecoveryLease(
  recoveryPath: string,
  token: string,
): Promise<(() => Promise<void>) | undefined> {
  const leasePath = join(recoveryPath, "lease");
  const leaseOwner: RecoveryLeaseOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  await mkdir(recoveryPath, { recursive: true });

  for (;;) {
    try {
      await mkdir(leasePath);
      try {
        await writeRecoveryLeaseOwner(leasePath, leaseOwner);
      } catch (error) {
        await rm(leasePath, { force: true, recursive: true });
        throw error;
      }
      return async () => {
        const currentOwner = await readRecoveryLeaseOwner(leasePath);
        if (currentOwner?.token !== token) {
          return;
        }
        const releasedPath = `${recoveryPath}.released-${token}`;
        try {
          await rename(recoveryPath, releasedPath);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        await rm(releasedPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
    }

    const currentOwner = await readRecoveryLeaseOwner(leasePath);
    if (currentOwner !== undefined && isProcessAlive(currentOwner.pid)) {
      return undefined;
    }
    if (currentOwner === undefined) {
      try {
        const leaseStat = await stat(leasePath);
        if (Date.now() - leaseStat.mtimeMs < INCOMPLETE_LOCK_STALE_MS) {
          return undefined;
        }
      } catch (error) {
        if (isNodeErrorWithCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
    }

    const staleLeasePath = `${leasePath}.stale-${token}`;
    try {
      await rename(leasePath, staleLeasePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    await rm(staleLeasePath, { force: true, recursive: true });
  }
}

async function finishInterruptedPublication(ownerPath: string): Promise<void> {
  try {
    const staleOwner = await readPublicationOwner(ownerPath);
    if (staleOwner !== undefined) {
      if (staleOwner.phase === "committed") {
        await removePublicationBackups(staleOwner);
      } else {
        await rollbackOutputPublication(staleOwner);
      }
    }
  } finally {
    await rm(ownerPath, { force: true, recursive: true });
  }
}

async function rollbackOutputPublication(owner: OutputPublicationOwner): Promise<void> {
  await rollbackOneArtifact({
    backupPath: owner.outputBackupPath,
    finalPath: owner.finalOutputDir,
    hadPrevious: owner.hadOutput,
    stagedPath: owner.stagedOutputDir,
  });
  await rollbackOneArtifact({
    backupPath: owner.summaryBackupPath,
    finalPath: owner.finalSummaryPath,
    hadPrevious: owner.hadSummary,
    stagedPath: owner.stagedSummaryPath,
  });
}

async function rollbackOneArtifact(input: {
  readonly backupPath: string;
  readonly finalPath: string;
  readonly hadPrevious: boolean;
  readonly stagedPath: string;
}): Promise<void> {
  if (await pathExists(input.backupPath)) {
    if (!(await pathExists(input.stagedPath)) && (await pathExists(input.finalPath))) {
      await mkdir(dirname(input.stagedPath), { recursive: true });
      await rename(input.finalPath, input.stagedPath);
    } else {
      await rm(input.finalPath, { force: true, recursive: true });
    }
    await rename(input.backupPath, input.finalPath);
    return;
  }
  if (
    !input.hadPrevious &&
    !(await pathExists(input.stagedPath)) &&
    (await pathExists(input.finalPath))
  ) {
    await mkdir(dirname(input.stagedPath), { recursive: true });
    await rename(input.finalPath, input.stagedPath);
  }
}

async function removePublicationBackups(owner: OutputPublicationOwner): Promise<void> {
  await Promise.all([
    rm(owner.outputBackupPath, { force: true, recursive: true }),
    rm(owner.summaryBackupPath, { force: true, recursive: true }),
  ]);
}

async function writePublicationOwner(
  lockPath: string,
  owner: OutputPublicationOwner,
): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  await rename(temporaryPath, ownerPath);
}

async function readPublicationOwner(lockPath: string): Promise<OutputPublicationOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown;
    return isOutputPublicationOwner(value) ? value : undefined;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeRecoveryLeaseOwner(
  leasePath: string,
  owner: RecoveryLeaseOwner,
): Promise<void> {
  const ownerPath = join(leasePath, "owner.json");
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  await rename(temporaryPath, ownerPath);
}

async function readRecoveryLeaseOwner(leasePath: string): Promise<RecoveryLeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(leasePath, "owner.json"), "utf8")) as unknown;
    return isRecoveryLeaseOwner(value) ? value : undefined;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isOutputPublicationOwner(value: unknown): value is OutputPublicationOwner {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const owner = value as Partial<OutputPublicationOwner>;
  return (
    typeof owner.finalOutputDir === "string" &&
    typeof owner.finalSummaryPath === "string" &&
    typeof owner.hadOutput === "boolean" &&
    typeof owner.hadSummary === "boolean" &&
    typeof owner.outputBackupPath === "string" &&
    ["acquired", "prepared", "backed-up", "installed", "committed"].includes(owner.phase ?? "") &&
    typeof owner.pid === "number" &&
    typeof owner.stagedOutputDir === "string" &&
    typeof owner.stagedSummaryPath === "string" &&
    typeof owner.startedAt === "string" &&
    typeof owner.summaryBackupPath === "string" &&
    typeof owner.token === "string"
  );
}

function isRecoveryLeaseOwner(value: unknown): value is RecoveryLeaseOwner {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const owner = value as Partial<RecoveryLeaseOwner>;
  return (
    typeof owner.pid === "number" &&
    typeof owner.startedAt === "string" &&
    typeof owner.token === "string"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorWithCode(error, "ESRCH");
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
