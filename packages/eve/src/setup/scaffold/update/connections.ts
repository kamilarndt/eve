import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  endpointForProtocol,
  type ConnectionAuthSpec,
  type ConnectionCatalogEntry,
  type ConnectionProtocol,
  type CustomConnectionInput,
  type McpEndpoint,
  type OpenApiEndpoint,
} from "../connections/catalog.js";
import { pathExists, writeTextFile } from "../files.js";
import { resolveVersionToken } from "../version-tokens.js";
import { getSupportedModuleBaseName, matchesSupportedModuleBaseName } from "./module-files.js";
import { patchPackageJson } from "./package-json.js";
import type { PackageJsonMutation } from "./channels.js";

const DEFAULT_CONNECT_PACKAGE_VERSION = "__VERCEL_CONNECT_VERSION__";
const CONNECT_PACKAGE_NAME = "@vercel/connect";
const USER_AUTHORED_CONNECTION_DIR = "agent/connections";
const ENV_LOCAL_FILE = ".env.local";

export type ConnectionMutationAction = "created" | "overwritten" | "skipped";

export interface ConnectionMutationResult {
  slug: string;
  protocol: ConnectionProtocol;
  action: ConnectionMutationAction;
  /** Absolute path of the connection module. */
  filePath: string;
  filesWritten: string[];
  filesOverwritten?: string[];
  filesSkipped: string[];
  /** Env keys appended to `.env.local` (empty when none were added). */
  envKeysAdded: string[];
  /** Env keys the user must populate for this connection. */
  envKeysRequired: string[];
}

/** A catalog entry or a free-form custom connection. */
export type ConnectionInput = ConnectionCatalogEntry | CustomConnectionInput;

export interface EnsureConnectionOptions {
  projectRoot: string;
  /** File name / connection name. Defaults to `entry.slug`. */
  slug?: string;
  /** Protocol resolved by the flow before scaffolding. */
  protocol: ConnectionProtocol;
  entry: ConnectionInput;
  force?: boolean;
}

export interface EnsureConnectionDependenciesOptions {
  projectRoot: string;
  connectPackageVersion?: string;
}

function resolveAuth(entry: ConnectionInput): ConnectionAuthSpec {
  return entry.auth ?? { kind: "none" };
}

function envKeysForAuth(auth: ConnectionAuthSpec): string[] {
  switch (auth.kind) {
    case "bearer-env":
      return [auth.envVar];
    case "header":
      return auth.headers.map((entry) => entry.envVar);
    case "connect":
    case "none":
      return [];
  }
}

function authBlock(auth: ConnectionAuthSpec): string {
  switch (auth.kind) {
    case "connect":
      return `  auth: connect("${auth.connector}"),\n`;
    case "bearer-env":
      return `  auth: { getToken: async () => ({ token: process.env.${auth.envVar}! }) },\n`;
    case "header": {
      const lines = auth.headers
        .map((header) => `    "${header.header}": process.env.${header.envVar}!,`)
        .join("\n");
      return `  headers: () => ({\n${lines}\n  }),\n`;
    }
    case "none":
      return "";
  }
}

function renderMcpTemplate(endpoint: McpEndpoint, description: string, auth: ConnectionAuthSpec) {
  const imports =
    auth.kind === "connect"
      ? `import { connect } from "@vercel/connect/eve";\nimport { defineMcpClientConnection } from "eve/connections";\n`
      : `import { defineMcpClientConnection } from "eve/connections";\n`;
  return `${imports}
export default defineMcpClientConnection({
  url: "${endpoint.url}",
  description: "${description}",
${authBlock(auth)}});
`;
}

function renderOpenApiTemplate(
  endpoint: OpenApiEndpoint,
  description: string,
  auth: ConnectionAuthSpec,
) {
  const imports =
    auth.kind === "connect"
      ? `import { connect } from "@vercel/connect/eve";\nimport { defineOpenAPIConnection } from "eve/connections";\n`
      : `import { defineOpenAPIConnection } from "eve/connections";\n`;
  const baseUrlLine = endpoint.baseUrl ? `  baseUrl: "${endpoint.baseUrl}",\n` : "";
  return `${imports}
export default defineOpenAPIConnection({
  spec: "${endpoint.spec}",
${baseUrlLine}  description: "${description}",
${authBlock(auth)}});
`;
}

function renderTemplate(
  protocol: ConnectionProtocol,
  endpoint: McpEndpoint | OpenApiEndpoint,
  description: string,
  auth: ConnectionAuthSpec,
): string {
  if (protocol === "mcp") {
    return renderMcpTemplate(endpoint as McpEndpoint, description, auth);
  }
  return renderOpenApiTemplate(endpoint as OpenApiEndpoint, description, auth);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureConnectDependency(
  packageJsonPath: string,
  dependencyVersion: string,
): Promise<PackageJsonMutation[]> {
  if (!(await pathExists(packageJsonPath))) return [];
  const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const current =
    isJsonObject(parsed) && isJsonObject(parsed.dependencies)
      ? parsed.dependencies[CONNECT_PACKAGE_NAME]
      : undefined;
  if (current === dependencyVersion) return [];

  await patchPackageJson(packageJsonPath, {
    dependencies: { [CONNECT_PACKAGE_NAME]: dependencyVersion },
  });
  return [
    {
      path: packageJsonPath,
      dependencies: [CONNECT_PACKAGE_NAME],
      devDependencies: [],
      scripts: [],
    },
  ];
}

/** Adds the package dependency required by a Connect-auth connection. */
export async function ensureConnectionDependencies(
  options: EnsureConnectionDependenciesOptions,
): Promise<PackageJsonMutation[]> {
  const connectPackageVersion = resolveVersionToken(
    "connectPackageVersion",
    options.connectPackageVersion ?? DEFAULT_CONNECT_PACKAGE_VERSION,
  );
  return ensureConnectDependency(join(options.projectRoot, "package.json"), connectPackageVersion);
}

function envKeyPresent(source: string, key: string): boolean {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, "m");
  return pattern.test(source);
}

async function seedEnvPlaceholders(envPath: string, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];

  let current = "";
  if (await pathExists(envPath)) {
    current = await readFile(envPath, "utf8");
  }

  const missing = keys.filter((key) => !envKeyPresent(current, key));
  if (missing.length === 0) return [];

  const needsNewline = current.length > 0 && !current.endsWith("\n");
  const appended = `${needsNewline ? "\n" : ""}${missing.map((key) => `${key}=`).join("\n")}\n`;
  await writeFile(envPath, current + appended, "utf8");
  return missing;
}

/**
 * Scaffolds `agent/connections/<slug>.ts` from a catalog entry or custom
 * input and seeding `.env.local` placeholders for static-key connections.
 * Connect dependency installation is owned by the setup box so a multi-entry
 * run mutates and installs the project exactly once.
 */
export async function ensureConnection(
  options: EnsureConnectionOptions,
): Promise<ConnectionMutationResult> {
  const slug = options.slug ?? options.entry.slug;
  const auth = resolveAuth(options.entry);
  const endpoint = endpointForProtocol(options.entry, options.protocol);
  if (endpoint === null) {
    throw new Error(
      `Connection "${slug}" is missing a ${options.protocol === "mcp" ? "mcp.url" : "openapi.spec"} endpoint for protocol "${options.protocol}".`,
    );
  }

  const authoredModules = await listAuthoredConnectionModules(options.projectRoot);
  const matchingModules = authoredModules.filter((module) => module.slug === slug);
  if (matchingModules.length > 1) {
    throw new Error(
      `Connection "${slug}" has multiple authored modules: ${matchingModules
        .map((module) => module.filePath)
        .join(", ")}. Keep exactly one before retrying.`,
    );
  }
  const filePath =
    matchingModules[0]?.filePath ??
    join(options.projectRoot, USER_AUTHORED_CONNECTION_DIR, `${slug}.ts`);
  const envKeysRequired = envKeysForAuth(auth);
  const fileAlreadyExists = await pathExists(filePath);

  if (!options.force && fileAlreadyExists) {
    return {
      slug,
      protocol: options.protocol,
      action: "skipped",
      filePath,
      filesWritten: [],
      filesSkipped: [filePath],
      envKeysAdded: [],
      envKeysRequired,
    };
  }

  await writeTextFile(
    filePath,
    renderTemplate(options.protocol, endpoint, options.entry.description, auth),
    {
      force: true,
    },
  );

  const envKeysAdded = await seedEnvPlaceholders(
    join(options.projectRoot, ENV_LOCAL_FILE),
    envKeysRequired,
  );

  const result: ConnectionMutationResult = {
    slug,
    protocol: options.protocol,
    action: fileAlreadyExists ? "overwritten" : "created",
    filePath,
    filesWritten: [filePath],
    filesSkipped: [],
    envKeysAdded,
    envKeysRequired,
  };
  if (fileAlreadyExists) {
    result.filesOverwritten = [filePath];
  }
  return result;
}

interface AuthoredConnectionModule {
  readonly filePath: string;
  readonly slug: string;
}

async function listAuthoredConnectionModules(
  projectRoot: string,
): Promise<AuthoredConnectionModule[]> {
  const connectionsDir = join(projectRoot, USER_AUTHORED_CONNECTION_DIR);
  let entries;
  try {
    entries = await readdir(connectionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const connections: AuthoredConnectionModule[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const baseName = getSupportedModuleBaseName(entry.name);
      if (baseName !== null) {
        connections.push({ filePath: join(connectionsDir, entry.name), slug: baseName });
      }
      continue;
    }
    if (entry.isDirectory()) {
      try {
        const inner = await readdir(join(connectionsDir, entry.name));
        const fileName = inner.find((candidate) =>
          matchesSupportedModuleBaseName(candidate, "connection"),
        );
        if (fileName !== undefined) {
          connections.push({
            filePath: join(connectionsDir, entry.name, fileName),
            slug: entry.name,
          });
        }
      } catch {
        // Skip unreadable directories.
      }
    }
  }

  return connections.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Lists authored connection names under `agent/connections/` (file and folder form). */
export async function listAuthoredConnections(projectRoot: string): Promise<string[]> {
  return (await listAuthoredConnectionModules(projectRoot)).map((connection) => connection.slug);
}
