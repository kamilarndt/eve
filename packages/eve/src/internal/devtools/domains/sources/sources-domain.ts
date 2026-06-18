import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { DevToolsEventHub } from "#internal/devtools/event-hub.js";
import { DevToolsApiError } from "#internal/devtools/host/errors.js";

const AUTHORED_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const IGNORED_SOURCE_DIRECTORIES = new Set([
  ".eve",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".workflow-data",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 16 * 1024 * 1024;
const MAX_SCRIPTS_PER_SOURCE = 8;

interface SourceMapAssociation {
  readonly mappings: string;
  readonly script: DevToolsSourceEntry["scripts"][number];
  readonly sourceIndex: number;
}

export interface DevToolsSourceEntry {
  readonly id: string;
  readonly kind: "authored";
  readonly loaded: boolean;
  readonly path: string;
  readonly revision?: string;
  readonly scripts: readonly {
    readonly scriptId: string;
    readonly sourceMapUrl?: string;
    readonly url: string;
  }[];
}

export interface DevToolsSourcesDomain {
  get(
    sourceId: string,
  ): Promise<{ readonly content: string; readonly source: DevToolsSourceEntry }>;
  list(): Promise<readonly DevToolsSourceEntry[]>;
  locations(
    sourceId: string,
    line: number,
  ): Promise<
    readonly {
      readonly columnNumber: number;
      readonly lineNumber: number;
      readonly scriptId: string;
    }[]
  >;
  originalLocation(input: {
    readonly columnNumber: number;
    readonly lineNumber: number;
    readonly scriptId: string;
  }): { readonly column: number; readonly line: number; readonly sourceId: string } | undefined;
  recordScript(input: {
    readonly revision?: string;
    readonly scriptId: string;
    readonly sourceMapUrl?: string;
    readonly url: string;
  }): void;
}

export function createDevToolsSourcesDomain(input: {
  readonly appRoot: string;
  readonly eventHub: DevToolsEventHub;
  readonly getRevision: () => string | undefined;
}): DevToolsSourcesDomain {
  const scriptsByPath = new Map<string, DevToolsSourceEntry["scripts"][number][]>();
  const sourceMapsByPath = new Map<string, SourceMapAssociation[]>();

  const list = async (): Promise<readonly DevToolsSourceEntry[]> => {
    const paths = await collectAuthoredSourcePaths(input.appRoot);
    return paths.map((path) => ({
      id: path,
      kind: "authored" as const,
      loaded: (scriptsByPath.get(path)?.length ?? 0) > 0,
      path,
      revision: input.getRevision(),
      scripts: scriptsByPath.get(path) ?? [],
    }));
  };

  return {
    async get(sourceId) {
      const absolutePath = resolve(input.appRoot, sourceId);
      if (
        !isInside(input.appRoot, absolutePath) ||
        !AUTHORED_SOURCE_EXTENSIONS.has(extname(sourceId))
      ) {
        throw new DevToolsApiError(404, "source_not_found", "Source was not found.");
      }
      const statelessSources = await list();
      const source = statelessSources.find((entry) => entry.id === sourceId);
      if (source === undefined) {
        throw new DevToolsApiError(404, "source_not_found", "Source was not found.");
      }
      if ((await stat(absolutePath)).size > MAX_SOURCE_BYTES) {
        throw new DevToolsApiError(413, "source_too_large", "Source is too large to inspect.");
      }
      const content = await readFile(absolutePath, "utf8");
      return { content, source };
    },
    list,
    async locations(sourceId, line) {
      if (!Number.isInteger(line) || line < 1) {
        throw new DevToolsApiError(400, "invalid_source_line", "Source line must be positive.");
      }
      const source = (await list()).find((entry) => entry.id === sourceId);
      if (source === undefined) {
        throw new DevToolsApiError(404, "source_not_found", "Source was not found.");
      }
      const locationsByScript = new Map<
        string,
        { readonly columnNumber: number; readonly lineNumber: number; readonly scriptId: string }
      >();
      for (const association of sourceMapsByPath.get(sourceId) ?? []) {
        const location = findGeneratedLocations(
          association.mappings,
          association.sourceIndex,
          line - 1,
        )[0];
        if (location !== undefined && !locationsByScript.has(association.script.scriptId)) {
          locationsByScript.set(association.script.scriptId, {
            ...location,
            scriptId: association.script.scriptId,
          });
        }
      }
      return [...locationsByScript.values()];
    },
    originalLocation(location) {
      let best:
        | {
            readonly column: number;
            readonly generatedColumn: number;
            readonly line: number;
            readonly sourceId: string;
          }
        | undefined;
      for (const [sourceId, associations] of sourceMapsByPath) {
        for (const association of associations) {
          if (association.script.scriptId !== location.scriptId) continue;
          const candidate = findOriginalLocation(
            association.mappings,
            association.sourceIndex,
            location.lineNumber,
            location.columnNumber,
          );
          if (
            candidate !== undefined &&
            (best === undefined || candidate.generatedColumn > best.generatedColumn)
          ) {
            best = { ...candidate, sourceId };
          }
        }
      }
      return best === undefined
        ? undefined
        : { column: best.column + 1, line: best.line + 1, sourceId: best.sourceId };
    },
    recordScript(script) {
      const next = {
        scriptId: script.scriptId,
        sourceMapUrl: script.sourceMapUrl,
        url: script.url,
      };
      const sourcePath = authoredPathFromUrl(input.appRoot, script.url);
      if (sourcePath !== undefined) recordSourceScript(sourcePath, next);
      if (script.sourceMapUrl !== undefined) {
        void recordSourceMapAssociations({
          appRoot: input.appRoot,
          script: next,
          sourceMapUrl: script.sourceMapUrl,
          sourceMapsByPath,
          onSource(sourceId) {
            recordSourceScript(sourceId, next);
          },
        }).catch(() => {});
      }

      function recordSourceScript(
        path: string,
        sourceScript: DevToolsSourceEntry["scripts"][number],
      ): void {
        const scripts = scriptsByPath.get(path) ?? [];
        const existingIndex = scripts.findIndex((candidate) => candidate.url === sourceScript.url);
        if (existingIndex === -1) scripts.push(sourceScript);
        else scripts[existingIndex] = sourceScript;
        if (scripts.length > MAX_SCRIPTS_PER_SOURCE) scripts.shift();
        scriptsByPath.set(path, scripts);
        input.eventHub.publish("source.loaded", () => ({
          revision: script.revision,
          sourceId: path,
          script: sourceScript,
        }));
      }
    },
  };
}

async function recordSourceMapAssociations(input: {
  readonly appRoot: string;
  readonly onSource: (sourceId: string) => void;
  readonly script: DevToolsSourceEntry["scripts"][number];
  readonly sourceMapUrl: string;
  readonly sourceMapsByPath: Map<string, SourceMapAssociation[]>;
}): Promise<void> {
  const sourceMap = await readSourceMap(input.script.url, input.sourceMapUrl);
  if (sourceMap === undefined) return;
  for (const [sourceIndex, url] of sourceMap.sources.entries()) {
    const sourceId = authoredPathFromUrl(input.appRoot, url);
    if (sourceId === undefined) continue;
    const associations = input.sourceMapsByPath.get(sourceId) ?? [];
    const next = { mappings: sourceMap.mappings, script: input.script, sourceIndex };
    const existing = associations.findIndex(
      (candidate) => candidate.script.scriptId === input.script.scriptId,
    );
    if (existing === -1) associations.push(next);
    else associations[existing] = next;
    if (associations.length > MAX_SCRIPTS_PER_SOURCE) associations.shift();
    input.sourceMapsByPath.set(sourceId, associations);
    input.onSource(sourceId);
  }
}

async function readSourceMap(
  scriptUrl: string,
  sourceMapUrl: string,
): Promise<{ readonly mappings: string; readonly sources: readonly string[] } | undefined> {
  let raw: string;
  let baseUrl = scriptUrl;
  if (sourceMapUrl.startsWith("data:")) {
    const comma = sourceMapUrl.indexOf(",");
    if (comma === -1) return undefined;
    const metadata = sourceMapUrl.slice(0, comma);
    const data = sourceMapUrl.slice(comma + 1);
    raw = metadata.includes(";base64")
      ? Buffer.from(data, "base64").toString("utf8")
      : decodeURIComponent(data);
  } else {
    baseUrl = new URL(sourceMapUrl, scriptUrl).href;
    if (!baseUrl.startsWith("file:")) return undefined;
    const path = fileURLToPath(baseUrl);
    if ((await stat(path)).size > MAX_SOURCE_MAP_BYTES) return undefined;
    raw = await readFile(path, "utf8");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SOURCE_MAP_BYTES) return undefined;
  const parsed = JSON.parse(raw) as {
    readonly mappings?: unknown;
    readonly sourceRoot?: unknown;
    readonly sources?: unknown;
  };
  if (typeof parsed.mappings !== "string" || !Array.isArray(parsed.sources)) return undefined;
  const sourceRoot = typeof parsed.sourceRoot === "string" ? parsed.sourceRoot : "";
  return {
    mappings: parsed.mappings,
    sources: parsed.sources.map((source) =>
      normalizeSourceMapUrl(baseUrl, sourceRoot, String(source)),
    ),
  };
}

function normalizeSourceMapUrl(baseUrl: string, sourceRoot: string, source: string): string {
  if (/^[a-z][a-z+.-]*:/iu.test(source)) return source;
  const rootedSource = sourceRoot === "" ? source : `${sourceRoot.replace(/\/$/u, "")}/${source}`;
  return new URL(rootedSource, baseUrl).href;
}

function findGeneratedLocations(
  mappings: string,
  targetSourceIndex: number,
  targetOriginalLine: number,
): readonly { readonly columnNumber: number; readonly lineNumber: number }[] {
  const locations: { columnNumber: number; lineNumber: number }[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  for (const [generatedLine, encodedLine] of mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const encodedSegment of encodedLine.split(",")) {
      if (encodedSegment === "") continue;
      const values = decodeVlq(encodedSegment);
      generatedColumn += values[0] ?? 0;
      if (values.length < 4) continue;
      sourceIndex += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      if (values[4] !== undefined) nameIndex += values[4];
      if (sourceIndex === targetSourceIndex && originalLine === targetOriginalLine) {
        locations.push({ columnNumber: generatedColumn, lineNumber: generatedLine });
      }
    }
  }
  void originalColumn;
  void nameIndex;
  return locations;
}

function findOriginalLocation(
  mappings: string,
  targetSourceIndex: number,
  targetGeneratedLine: number,
  targetGeneratedColumn: number,
):
  | { readonly column: number; readonly generatedColumn: number; readonly line: number }
  | undefined {
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  let best:
    | { readonly column: number; readonly generatedColumn: number; readonly line: number }
    | undefined;
  for (const [generatedLine, encodedLine] of mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const encodedSegment of encodedLine.split(",")) {
      if (encodedSegment === "") continue;
      const values = decodeVlq(encodedSegment);
      generatedColumn += values[0] ?? 0;
      if (values.length < 4) continue;
      sourceIndex += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      if (values[4] !== undefined) nameIndex += values[4];
      if (
        generatedLine === targetGeneratedLine &&
        generatedColumn <= targetGeneratedColumn &&
        sourceIndex === targetSourceIndex
      ) {
        best = { column: originalColumn, generatedColumn, line: originalLine };
      }
    }
    if (generatedLine >= targetGeneratedLine) break;
  }
  void nameIndex;
  return best;
}

function decodeVlq(value: string): number[] {
  const result: number[] = [];
  let current = 0;
  let shift = 0;
  for (const character of value) {
    const digit = BASE64_DIGITS.indexOf(character);
    if (digit === -1) throw new Error("Invalid source-map VLQ segment.");
    current += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    result.push(((current & 1) === 1 ? -1 : 1) * (current >> 1));
    current = 0;
    shift = 0;
  }
  return result;
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

async function collectAuthoredSourcePaths(appRoot: string): Promise<string[]> {
  const sources: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRECTORIES.has(entry.name)) await walk(absolutePath);
      } else if (entry.isFile() && AUTHORED_SOURCE_EXTENSIONS.has(extname(entry.name))) {
        sources.push(relative(appRoot, absolutePath).replaceAll("\\", "/"));
      }
    }
  }
  await walk(appRoot);
  return sources.sort((a, b) => a.localeCompare(b));
}

function authoredPathFromUrl(appRoot: string, url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  try {
    const path = fileURLToPath(url);
    if (!isInside(appRoot, path)) return undefined;
    const sourcePath = relative(appRoot, path).replaceAll("\\", "/");
    return AUTHORED_SOURCE_EXTENSIONS.has(extname(sourcePath)) ? sourcePath : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}
