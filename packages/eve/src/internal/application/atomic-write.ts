import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

interface AtomicFileWrite {
  readonly contents: string | Uint8Array;
  readonly path: string;
}

/** Writes one file through a same-directory temporary path and atomic rename. */
export async function atomicWriteFile(path: string, contents: string | Uint8Array): Promise<void> {
  await atomicWriteFiles([{ contents, path }]);
}

/** Stages a related file set completely before replacing any stable target. */
export async function atomicWriteFiles(files: readonly AtomicFileWrite[]): Promise<void> {
  const stagedFiles = files.map((file) => ({
    ...file,
    temporaryPath: `${file.path}.${process.pid}-${randomUUID()}.tmp`,
  }));

  try {
    await Promise.all(stagedFiles.map((file) => writeFile(file.temporaryPath, file.contents)));
    for (const file of stagedFiles) {
      await rename(file.temporaryPath, file.path);
    }
  } finally {
    await Promise.all(
      stagedFiles.map((file) => rm(file.temporaryPath, { force: true }).catch(() => {})),
    );
  }
}
