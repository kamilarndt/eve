import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";

type PrewarmAppSandboxesInput = Parameters<typeof prewarmAppSandboxes>[0];

const VERCEL_BUILD_PREWARM_SKIPPED_WARNING =
  "[eve] WARNING: Skipped Vercel sandbox template prewarm because VERCEL_DEPLOYMENT_ID is missing. " +
  "The generated .vercel/output may reference sandbox templates that were not provisioned. " +
  'Do not deploy it with "vercel deploy --prebuilt"; use "vercel deploy" so Vercel builds from source.';

/**
 * Detects whether the current build is running inside Vercel with a
 * stable deployment identifier. Build-time sandbox prewarm runs only
 * when this returns true so dev runs and one-off builds don't try to
 * provision templates against the platform.
 */
export function shouldPrewarmVercelBuild(): boolean {
  const vercel = process.env.VERCEL?.trim();
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();

  return (
    typeof vercel === "string" &&
    vercel.length > 0 &&
    typeof deploymentId === "string" &&
    deploymentId.length > 0
  );
}

/**
 * Build-time sandbox prewarm hook. Failures are build failures because the
 * same provisioning or bootstrap would otherwise fail after deployment.
 *
 * Backends opt in through `provisioning.prewarmAtBuild`. Vercel remains
 * restricted to builds with a deployment id because that id participates in
 * its template scope; other remote backends can prewarm in any build host.
 */
export async function runBuildSandboxPrewarm(input: PrewarmAppSandboxesInput): Promise<void> {
  if (process.env.VERCEL?.trim() && !process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
    console.warn(VERCEL_BUILD_PREWARM_SKIPPED_WARNING);
  }

  await prewarmAppSandboxes({
    ...input,
    shouldPrewarmBackend: shouldPrewarmBackendAtBuild,
  });
}

/** Backwards-compatible Vercel-only entry used by the Vercel build scenario harness. */
export async function runVercelBuildPrewarm(input: PrewarmAppSandboxesInput): Promise<boolean> {
  if (!shouldPrewarmVercelBuild()) {
    if (process.env.VERCEL?.trim() && !process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
      console.warn(VERCEL_BUILD_PREWARM_SKIPPED_WARNING);
    }
    return false;
  }
  await prewarmAppSandboxes(input);
  return true;
}

function shouldPrewarmBackendAtBuild(backend: SandboxBackend): boolean {
  if (backend.provisioning?.prewarmAtBuild !== true) {
    return false;
  }
  return backend.name !== "vercel" || shouldPrewarmVercelBuild();
}
