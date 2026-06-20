/** Header carrying the unguessable capability for a local `eve dev` user. */
export const EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER = "x-eve-local-dev-user-credential";

/** Marks a process as an active `eve dev` runtime. */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/** Absolute path of the active server's local-auth grant directory. */
export const EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV = "EVE_LOCAL_DEV_AUTH_DIRECTORY";

/** Random server-run id that binds local-auth grants to one dev-server lifetime. */
export const EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV = "EVE_LOCAL_DEV_AUTH_INSTANCE_ID";

/** Persisted local-auth protocol version. */
export const LOCAL_DEVELOPMENT_AUTH_VERSION = 1;

/** Non-secret coordinates for one local development server's user-grant registry. */
export interface LocalDevelopmentAuthMetadata {
  readonly serverInstanceId: string;
  readonly version: typeof LOCAL_DEVELOPMENT_AUTH_VERSION;
}
