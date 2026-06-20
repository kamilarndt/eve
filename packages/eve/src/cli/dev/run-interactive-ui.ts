import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import type { LocalDevelopmentAuthMetadata } from "#protocol/local-dev-auth.js";
import type { createLocalDevelopmentUserCredential } from "#services/dev-client/local-user-credential.js";
import type { getVercelUserIdentity } from "#setup/vercel-project.js";

import type { RunDevelopmentTuiInput } from "./tui/tui.js";
import type { DevelopmentTuiTarget } from "./tui/target.js";
import type { TuiDisplayOptions } from "./tui/types.js";

interface RunInteractiveDevelopmentUiInput {
  readonly createUserCredential: typeof createLocalDevelopmentUserCredential;
  readonly display: TuiDisplayOptions;
  readonly initialInput?: string;
  readonly onBootProgress?: DevBootProgressReporter;
  readonly resolveIdentity: typeof getVercelUserIdentity;
  readonly resolveLocalAuth?: () => Promise<LocalDevelopmentAuthMetadata | undefined>;
  readonly runDevelopmentTui: (input: RunDevelopmentTuiInput) => Promise<void>;
  readonly target: DevelopmentTuiTarget;
}

/**
 * Runs the TUI with a short-lived user grant bound to the exact local server
 * currently registered for this app. The association is rechecked for setup
 * commands so an attached CLI can recover from startup races without trusting
 * an unrelated server at the same hostname.
 */
export async function runInteractiveDevelopmentUi(
  input: RunInteractiveDevelopmentUiInput,
): Promise<void> {
  const appRoot = input.target.workspaceRoot;
  const resolveAssociatedAppRoot = async (): Promise<string | undefined> =>
    input.target.kind === "local" &&
    (input.resolveLocalAuth === undefined || (await input.resolveLocalAuth()) !== undefined)
      ? appRoot
      : undefined;
  const localUserCredential =
    input.target.kind !== "local" || input.resolveLocalAuth === undefined
      ? undefined
      : input.createUserCredential({
          appRoot,
          resolveIdentity: () => input.resolveIdentity(appRoot),
          resolveServer: input.resolveLocalAuth,
        });

  try {
    await localUserCredential?.refresh();
    await resolveAssociatedAppRoot();
    await input.runDevelopmentTui({
      ...input.display,
      initialInput: input.initialInput,
      localUserCredential,
      onBootProgress: input.onBootProgress,
      resolveAppRoot: resolveAssociatedAppRoot,
      target: input.target,
    });
  } finally {
    await localUserCredential?.dispose();
  }
}
