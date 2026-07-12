import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const INSTRUMENTATION_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export function resolveInstrumentationModulePaths(agentRoot: string): string[] {
  return INSTRUMENTATION_EXTENSIONS.map((extension) =>
    join(agentRoot, `instrumentation${extension}`),
  );
}

export function resolveInstrumentationModule(agentRoot: string): string | undefined {
  return resolveInstrumentationModulePaths(agentRoot).find((path) => existsSync(path));
}

export function isInstrumentationModulePath(agentRoot: string, path: string): boolean {
  const resolvedPath = resolve(path);
  return resolveInstrumentationModulePaths(agentRoot).some(
    (candidate) => resolve(candidate) === resolvedPath,
  );
}
