import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "#compiled/zod/index.js";
import {
  EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV,
  EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV,
  LOCAL_DEVELOPMENT_AUTH_VERSION,
  type LocalDevelopmentAuthMetadata,
} from "#protocol/local-dev-auth.js";
import { err, ok, type Result } from "#shared/result.js";

const LOCAL_DEVELOPMENT_AUTH_DIRECTORY = "dev-auth";
const LOCAL_DEVELOPMENT_AUTH_GRANTS_DIRECTORY = "grants";
const LOCAL_DEVELOPMENT_AUTH_GRANT_KIND = "eve-local-dev-user-grant";
const LOCAL_DEVELOPMENT_AUTH_OWNER_FILE = "owner.json";
const LOCAL_DEVELOPMENT_AUTH_OWNER_KIND = "eve-local-dev-auth-server";
const LOCAL_DEVELOPMENT_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LOCAL_DEVELOPMENT_AUTH_GRANT_BYTES = 4_096;
const MAX_LOCAL_DEVELOPMENT_AUTH_OWNER_BYTES = 4_096;
const MAX_LOCAL_DEVELOPMENT_USER_ID_LENGTH = 512;
const LOCAL_DEVELOPMENT_AUTH_TOKEN_CREATE_ATTEMPTS = 3;

const serverInstanceIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const serverDescriptorSchema = z
  .object({
    serverInstanceId: serverInstanceIdSchema,
    version: z.literal(LOCAL_DEVELOPMENT_AUTH_VERSION),
  })
  .strict();
const serverOwnerSchema = z
  .object({
    kind: z.literal(LOCAL_DEVELOPMENT_AUTH_OWNER_KIND),
    processId: z.number().int().positive(),
    serverInstanceId: serverInstanceIdSchema,
    version: z.literal(LOCAL_DEVELOPMENT_AUTH_VERSION),
  })
  .strict();
const userGrantSchema = z
  .object({
    kind: z.literal(LOCAL_DEVELOPMENT_AUTH_GRANT_KIND),
    ownerProcessId: z.number().int().positive(),
    principal: z
      .object({
        authenticator: z.literal("vercel-cli"),
        id: z.string().trim().min(1).max(MAX_LOCAL_DEVELOPMENT_USER_ID_LENGTH),
        type: z.literal("user"),
      })
      .strict(),
    serverInstanceId: serverInstanceIdSchema,
    version: z.literal(LOCAL_DEVELOPMENT_AUTH_VERSION),
  })
  .strict();

export interface LocalDevelopmentAuthServerHandle {
  readonly metadata: LocalDevelopmentAuthMetadata;
  dispose(): Promise<void>;
}

export interface LocalDevelopmentUserGrantHandle {
  readonly token: string;
  dispose(): Promise<void>;
}

export type LocalDevelopmentUserPrincipal = z.output<typeof userGrantSchema>["principal"];

/** A filesystem operation needed by local development auth failed. */
export type LocalDevelopmentAuthFileError = {
  readonly kind: "io";
  readonly cause: unknown;
};

export type LocalDevelopmentAuthStartError = LocalDevelopmentAuthFileError;

export type LocalDevelopmentAuthCreateError =
  | LocalDevelopmentAuthFileError
  | { readonly kind: "invalid-user-id" }
  | { readonly kind: "token-allocation-failed" };

export type LocalDevelopmentAuthReadError = LocalDevelopmentAuthFileError;

/** Creates independently revocable grants in one local development auth registry. */
export interface LocalDevelopmentAuthWriter {
  create(input: {
    readonly userId: string;
  }): Promise<Result<LocalDevelopmentUserGrantHandle, LocalDevelopmentAuthCreateError>>;
}

/** Resolves credentials issued by one local development auth registry. */
export interface LocalDevelopmentAuthReader {
  read(
    credential: string,
  ): Promise<Result<LocalDevelopmentUserPrincipal | undefined, LocalDevelopmentAuthReadError>>;
}

/** Reads and writes user grants for one local development auth registry. */
export class LocalDevelopmentAuthServer
  implements LocalDevelopmentAuthWriter, LocalDevelopmentAuthReader
{
  readonly #grantsDirectory: string;
  readonly #registryRoot: string;
  readonly metadata: LocalDevelopmentAuthMetadata;

  private constructor(input: {
    readonly directory: string;
    readonly metadata: LocalDevelopmentAuthMetadata;
  }) {
    this.#grantsDirectory = resolveGrantsDirectory(input.directory);
    this.#registryRoot = dirname(input.directory);
    this.metadata = input.metadata;
  }

  /** Opens grant creation for a registry identified by trusted project metadata. */
  static writer(input: {
    readonly appRoot: string;
    readonly metadata: LocalDevelopmentAuthMetadata;
  }): LocalDevelopmentAuthWriter {
    return new LocalDevelopmentAuthServer({
      directory: resolveInstanceDirectory(input.appRoot, input.metadata),
      metadata: input.metadata,
    });
  }

  /** Opens grant resolution for a registry identified by trusted project metadata. */
  static reader(input: {
    readonly appRoot: string;
    readonly metadata: LocalDevelopmentAuthMetadata;
  }): LocalDevelopmentAuthReader {
    return new LocalDevelopmentAuthServer({
      directory: resolveInstanceDirectory(input.appRoot, input.metadata),
      metadata: input.metadata,
    });
  }

  /** Opens grant resolution for the active dev server's process environment. */
  static readerFromEnvironment(): LocalDevelopmentAuthReader | undefined {
    const directory = process.env[EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV]?.trim();
    const metadata = LocalDevelopmentAuthServer.parseMetadata({
      serverInstanceId: process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV],
      version: LOCAL_DEVELOPMENT_AUTH_VERSION,
    });
    if (directory === undefined || directory.length === 0 || metadata === undefined) {
      return undefined;
    }
    return new LocalDevelopmentAuthServer({ directory, metadata });
  }

  /** Parses untrusted serialized local-auth metadata. */
  static parseMetadata(value: unknown): LocalDevelopmentAuthMetadata | undefined {
    const parsed = serverDescriptorSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  /** Creates and activates one process-owned local development auth registry. */
  static async start(
    appRoot: string,
  ): Promise<Result<LocalDevelopmentAuthServerHandle, LocalDevelopmentAuthStartError>> {
    const metadata = {
      serverInstanceId: randomBytes(16).toString("hex"),
      version: LOCAL_DEVELOPMENT_AUTH_VERSION,
    } satisfies LocalDevelopmentAuthMetadata;
    const registryRoot = resolveRegistryRoot(appRoot);
    const directory = resolveInstanceDirectory(appRoot, metadata);
    const grantsDirectory = resolveGrantsDirectory(directory);
    let directoryCreated = false;

    try {
      await mkdir(registryRoot, { mode: 0o700, recursive: true });
      await assertRegistryDirectory(registryRoot);
      await restrictDirectoryPermissions(registryRoot);
      await removeAbandonedServerDirectories(registryRoot);
      await mkdir(directory, { mode: 0o700 });
      directoryCreated = true;
      await restrictDirectoryPermissions(directory);
      await writeFile(
        resolveOwnerPath(directory),
        `${JSON.stringify({
          kind: LOCAL_DEVELOPMENT_AUTH_OWNER_KIND,
          processId: process.pid,
          serverInstanceId: metadata.serverInstanceId,
          version: LOCAL_DEVELOPMENT_AUTH_VERSION,
        } satisfies z.input<typeof serverOwnerSchema>)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await mkdir(grantsDirectory, { mode: 0o700 });
      await restrictDirectoryPermissions(grantsDirectory);
    } catch (cause) {
      if (directoryCreated) {
        await rm(directory, { force: true, recursive: true }).catch(() => {});
      }
      return err({ kind: "io", cause });
    }
    const registryRegistration = registerActiveRegistry({ directory, metadata });
    let disposePromise: Promise<void> | undefined;

    return ok({
      metadata,
      async dispose() {
        if (disposePromise === undefined) {
          disposePromise = (async () => {
            unregisterActiveRegistry(registryRegistration);
            await rm(directory, { force: true, recursive: true });
          })().catch((error: unknown) => {
            disposePromise = undefined;
            throw error;
          });
        }
        await disposePromise;
      },
    });
  }

  async create(input: {
    readonly userId: string;
  }): Promise<Result<LocalDevelopmentUserGrantHandle, LocalDevelopmentAuthCreateError>> {
    const parsedPrincipal = userGrantSchema.shape.principal.safeParse({
      authenticator: "vercel-cli",
      id: input.userId,
      type: "user",
    });
    if (!parsedPrincipal.success) return err({ kind: "invalid-user-id" });

    try {
      await assertRegistryDirectory(this.#registryRoot);
      await assertRegistryDirectory(this.#grantsDirectory);
    } catch (cause) {
      return err({ kind: "io", cause });
    }

    for (let attempt = 0; attempt < LOCAL_DEVELOPMENT_AUTH_TOKEN_CREATE_ATTEMPTS; attempt += 1) {
      const token = randomBytes(32).toString("base64url");
      const grantPath = resolveGrantPath(this.#grantsDirectory, token);
      const grant = {
        kind: LOCAL_DEVELOPMENT_AUTH_GRANT_KIND,
        ownerProcessId: process.pid,
        principal: parsedPrincipal.data,
        serverInstanceId: this.metadata.serverInstanceId,
        version: LOCAL_DEVELOPMENT_AUTH_VERSION,
      } satisfies z.input<typeof userGrantSchema>;

      try {
        await writeFile(grantPath, `${JSON.stringify(grant)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (cause) {
        if (isErrnoException(cause, "EEXIST")) continue;
        return err({ kind: "io", cause });
      }

      let disposePromise: Promise<void> | undefined;
      return ok({
        token,
        async dispose() {
          if (disposePromise === undefined) {
            disposePromise = rm(grantPath, { force: true }).catch((error: unknown) => {
              disposePromise = undefined;
              throw error;
            });
          }
          await disposePromise;
        },
      });
    }

    return err({ kind: "token-allocation-failed" });
  }

  async read(
    credential: string,
  ): Promise<Result<LocalDevelopmentUserPrincipal | undefined, LocalDevelopmentAuthReadError>> {
    if (!LOCAL_DEVELOPMENT_AUTH_TOKEN_PATTERN.test(credential)) return ok(undefined);

    const registry = await inspectRegistryDirectory(this.#grantsDirectory);
    if (!registry.ok) return err(registry.error);
    if (!registry.value) return ok(undefined);

    const grantPath = resolveGrantPath(this.#grantsDirectory, credential);
    let grantContents: string;
    try {
      const grantStat = await lstat(grantPath);
      if (!grantStat.isFile() || grantStat.size > MAX_LOCAL_DEVELOPMENT_AUTH_GRANT_BYTES) {
        return ok(undefined);
      }
      grantContents = await readFile(grantPath, "utf8");
    } catch (cause) {
      return isErrnoException(cause, "ENOENT") ? ok(undefined) : err({ kind: "io", cause });
    }

    let rawGrant: unknown;
    try {
      rawGrant = JSON.parse(grantContents);
    } catch {
      return ok(undefined);
    }
    const grant = userGrantSchema.safeParse(rawGrant);
    if (!grant.success || grant.data.serverInstanceId !== this.metadata.serverInstanceId) {
      return ok(undefined);
    }
    if (!isProcessRunning(grant.data.ownerProcessId)) {
      await rm(grantPath, { force: true }).catch(() => {});
      return ok(undefined);
    }
    return ok(grant.data.principal);
  }
}

interface ActiveRegistryEnvironment {
  readonly directory: string;
  readonly metadata: LocalDevelopmentAuthMetadata;
}

const activeRegistryEnvironments = new Map<symbol, ActiveRegistryEnvironment>();
let inheritedRegistryDirectory: string | undefined;
let inheritedRegistryInstanceId: string | undefined;

function registerActiveRegistry(environment: ActiveRegistryEnvironment): symbol {
  if (activeRegistryEnvironments.size === 0) {
    inheritedRegistryDirectory = process.env[EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV];
    inheritedRegistryInstanceId = process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV];
  }
  const registration = Symbol("local-development-auth-registry");
  activeRegistryEnvironments.set(registration, environment);
  publishRegistryEnvironment(environment);
  return registration;
}

function unregisterActiveRegistry(registration: symbol): void {
  if (!activeRegistryEnvironments.delete(registration)) return;

  const remaining = [...activeRegistryEnvironments.values()].at(-1);
  if (remaining !== undefined) {
    publishRegistryEnvironment(remaining);
    return;
  }

  restoreEnvironmentValue(EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV, inheritedRegistryDirectory);
  restoreEnvironmentValue(EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV, inheritedRegistryInstanceId);
  inheritedRegistryDirectory = undefined;
  inheritedRegistryInstanceId = undefined;
}

function publishRegistryEnvironment(environment: ActiveRegistryEnvironment): void {
  process.env[EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV] = environment.directory;
  process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV] = environment.metadata.serverInstanceId;
}

function resolveInstanceDirectory(appRoot: string, server: LocalDevelopmentAuthMetadata): string {
  return join(resolveRegistryRoot(appRoot), server.serverInstanceId);
}

function resolveRegistryRoot(appRoot: string): string {
  return join(appRoot, ".eve", LOCAL_DEVELOPMENT_AUTH_DIRECTORY);
}

function resolveGrantsDirectory(instanceDirectory: string): string {
  return join(instanceDirectory, LOCAL_DEVELOPMENT_AUTH_GRANTS_DIRECTORY);
}

function resolveGrantPath(grantsDirectory: string, token: string): string {
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  return join(grantsDirectory, `${tokenHash}.json`);
}

function resolveOwnerPath(instanceDirectory: string): string {
  return join(instanceDirectory, LOCAL_DEVELOPMENT_AUTH_OWNER_FILE);
}

async function assertRegistryDirectory(directory: string): Promise<void> {
  const inspected = await inspectRegistryDirectory(directory);
  if (!inspected.ok) throw inspected.error.cause;
  if (!inspected.value)
    throw new Error(`Local development auth registry is unavailable at ${directory}.`);
}

async function inspectRegistryDirectory(
  directory: string,
): Promise<Result<boolean, LocalDevelopmentAuthFileError>> {
  try {
    const directoryStat = await lstat(directory);
    return ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
  } catch (cause) {
    return isErrnoException(cause, "ENOENT") ? ok(false) : err({ kind: "io", cause });
  }
}

async function restrictDirectoryPermissions(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
}

async function removeAbandonedServerDirectories(registryRoot: string): Promise<void> {
  const entries = await readdir(registryRoot, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !serverInstanceIdSchema.safeParse(entry.name).success) return;
      const directory = join(registryRoot, entry.name);
      const owner = await readServerOwner(directory);
      if (owner === undefined || owner.serverInstanceId !== entry.name) return;
      if (isProcessRunning(owner.processId)) return;
      await rm(directory, { force: true, recursive: true });
    }),
  );
}

async function readServerOwner(
  instanceDirectory: string,
): Promise<z.output<typeof serverOwnerSchema> | undefined> {
  const ownerPath = resolveOwnerPath(instanceDirectory);
  let contents: string;
  try {
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || ownerStat.size > MAX_LOCAL_DEVELOPMENT_AUTH_OWNER_BYTES) {
      return undefined;
    }
    contents = await readFile(ownerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = serverOwnerSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return !isErrnoException(cause, "ESRCH");
  }
}

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
