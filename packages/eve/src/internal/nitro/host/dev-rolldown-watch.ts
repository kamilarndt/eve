import { relative, resolve } from "node:path";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Creates Rolldown watch exclusions for paths whose publication is coordinated
 * by eve's authored-source watcher.
 */
export function createDevelopmentRolldownWatchExclusions(
  paths: readonly string[],
  cwd?: string,
): RegExp[] {
  const normalizedCwd = cwd === undefined ? undefined : resolve(cwd);
  const patterns = new Set<string>();

  for (const path of paths) {
    const absolutePath = normalizePath(resolve(path));
    patterns.add(`^${escapeRegularExpression(absolutePath)}(?:/|$)`);
    if (normalizedCwd !== undefined) {
      const relativePath = normalizePath(relative(normalizedCwd, absolutePath));
      if (relativePath.length > 0) {
        patterns.add(`^(?:\\./)?${escapeRegularExpression(relativePath)}(?:/|$)`);
      }
    }
  }

  return [...patterns].map(
    (pattern) => new RegExp(pattern, process.platform === "win32" ? "i" : undefined),
  );
}
