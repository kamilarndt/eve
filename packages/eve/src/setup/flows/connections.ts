import {
  CONNECTION_CATALOG,
  listAuthoredConnections,
  type ConnectionCatalogEntry,
} from "#setup/scaffold/index.js";
import { toErrorMessage } from "#shared/errors.js";

import { interactiveAsker } from "../ask.js";
import { addConnections, type AddConnectionsDeps } from "../boxes/add-connections.js";
import { selectConnections } from "../boxes/select-connections.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
} from "../project-resolution.js";
import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";

import { prompterSink } from "./in-project.js";

/** The connection list's prompt; sub-flow prompts (protocol pick) differ. */
export const CONNECTIONS_PROMPT_MESSAGE =
  "Select an MCP server to add to your agent through Vercel Connect";

/** Injected for tests; defaults to the real detection and box effects. */
export interface ConnectionsFlowDeps {
  detectDeployment: typeof detectDeployment;
  listAuthoredConnections: typeof listAuthoredConnections;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  addConnections?: AddConnectionsDeps;
}

export type ConnectionsFlowResult =
  | { kind: "done"; addedConnections: readonly string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; addedConnections: readonly string[]; message: string };

/** One row on the connection task list: a catalog slug or Done. */
type ConnectionListRow = string;

/**
 * Why a Connect-backed connection can't be added yet, or `undefined` when it
 * can. Connect provisions a connector against the linked Vercel project, so it
 * needs an installed CLI, a logged-in session, and a link — each missing
 * piece points at its own fix rather than dead-ending. Mirrors the channels
 * flow's blocker so the two task lists gate Vercel-backed rows identically.
 */
function vercelConnectionBlocker(
  authStatus: VercelAuthStatus,
  projectLinked: boolean,
): string | undefined {
  const authBlocker = vercelAuthBlockerReason(authStatus);
  if (authBlocker !== undefined) return authBlocker;
  if (!projectLinked) return "Run eve link first";
  return undefined;
}

/**
 * The action list reads like a task list: connections already authored render
 * checked and remain cursor-addressable for an "Already added" hint but cannot
 * be selected; Connect-backed entries are disabled with the blocker while the
 * directory is unlinked or logged out; the rest are pickable. The custom
 * MCP/OpenAPI escape hatch is intentionally omitted here — the TUI offers the
 * curated catalog only.
 */
function connectionListRows(
  authored: ReadonlySet<string>,
  projectLinked: boolean,
  authStatus: VercelAuthStatus,
): SelectOption<ConnectionListRow>[] {
  const rows: SelectOption<ConnectionListRow>[] = [];
  for (const entry of CONNECTION_CATALOG) {
    if (authored.has(entry.slug)) {
      rows.push({
        value: entry.slug,
        label: entry.label,
        completed: true,
        focusHint: "Already added",
      });
      continue;
    }
    if (entry.auth.kind === "connect") {
      const blocker = vercelConnectionBlocker(authStatus, projectLinked);
      if (blocker !== undefined) {
        rows.push({
          value: entry.slug,
          label: entry.label,
          disabled: true,
          disabledReason: blocker,
          disabledReasonTone: "warning",
        });
        continue;
      }
    }
    const row: SelectOption<ConnectionListRow> = { value: entry.slug, label: entry.label };
    if (entry.hint !== undefined) row.hint = entry.hint;
    rows.push(row);
  }
  rows.push({ value: "done", label: "Done" });
  return rows;
}

type ConnectionPickResult = { kind: "picked"; value: ConnectionListRow } | { kind: "cancelled" };

async function pickConnection(
  prompter: Prompter,
  authored: ReadonlySet<string>,
  projectLinked: boolean,
  authStatus: VercelAuthStatus,
): Promise<ConnectionPickResult> {
  const rows = connectionListRows(authored, projectLinked, authStatus);
  // When every catalog connection is already added or blocked, the only action
  // left is to finish: default the cursor to "Done" instead of a dead row.
  const onlyDoneRemains = !rows.some(
    (row) => row.value !== "done" && row.completed !== true && row.disabled !== true,
  );
  const request: SingleSelectOptions<ConnectionListRow> = {
    message: CONNECTIONS_PROMPT_MESSAGE,
    options: rows,
    hintLayout: "inline",
  };
  if (onlyDoneRemains) request.initialValue = "done";

  try {
    return { kind: "picked", value: await prompter.select<ConnectionListRow>(request) };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

function isCatalogEntry(slug: string): ConnectionCatalogEntry | undefined {
  return CONNECTION_CATALOG.find((entry) => entry.slug === slug);
}

/**
 * THE CONNECTIONS FLOW for the dev TUI's `/connect`: a task list that loops,
 * mirroring the channels flow. Pick an unauthored catalog connection, run its
 * add sub-flow (the select-connections preset plus the add-connections
 * scaffold and Connect provisioning), and land back on the repainted list with
 * that connection checked; "Done" or Esc leaves. Esc on the list after
 * something was added reports the additions exactly like Done; only an empty
 * exit folds to cancelled.
 *
 * Session additions are derived by diffing the on-disk authored set against the
 * set seen at entry, re-read after every sub-flow. Connect provisioning runs
 * before `ensureConnection`, so a remote failure propagates without authoring a
 * placeholder. Failures after the local write are retained and surfaced as a
 * `failed` result.
 */
export async function runConnectionsFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<ConnectionsFlowDeps>;
}): Promise<ConnectionsFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ConnectionsFlowDeps = {
    detectDeployment,
    listAuthoredConnections,
    getVercelAuthStatus,
    ...input.deps,
  };

  async function checkProject<T>(task: () => Promise<T>): Promise<T> {
    const spinner = prompter.log.spinner?.("Checking the project…");
    try {
      return await task();
    } finally {
      spinner?.stop();
    }
  }

  // Link detection and the auth probe are independent `vercel` round-trips; the
  // authored-connection read is local. One ephemeral spinner covers all three
  // so the list paints with no persisted loading lines.
  const [deployment, initialConnections, authStatus] = await checkProject(() =>
    Promise.all([
      deps.detectDeployment(appRoot, { signal }),
      deps.listAuthoredConnections(appRoot),
      deps.getVercelAuthStatus(appRoot, { signal }),
    ]),
  );
  signal?.throwIfAborted();

  const baseline = new Set(initialConnections);
  let authored = new Set(initialConnections);
  const configuredThisRun = new Set<string>();
  // Session additions: what is on disk now that was not when the flow began.
  // Deriving from the authored set (rather than tracking picks) means a pick
  // that resolved to an already-existing file is correctly not counted.
  const addedConnections = (): string[] => [
    ...new Set([...[...authored].filter((slug) => !baseline.has(slug)), ...configuredThisRun]),
  ];

  let state: SetupState = {
    ...createDefaultSetupState(),
    project: projectResolutionFromDeployment(deployment),
    projectPath: { kind: "resolved", inPlace: true, path: appRoot },
  };
  const retainedFailures = new Map<string, string>();

  while (true) {
    const picked = await pickConnection(
      prompter,
      authored,
      isProjectResolved(state.project),
      authStatus,
    );
    if (picked.kind === "cancelled") {
      if (addedConnections().length === 0) return { kind: "cancelled" };
      break;
    }
    const pick = picked.value;
    if (pick === "done") break;
    if (authored.has(pick) || isCatalogEntry(pick) === undefined) continue;

    const boxes: AnySetupBox<SetupState>[] = [
      selectConnections({ asker: interactiveAsker(prompter), presetConnections: [pick] }),
      addConnections({
        prompter,
        deps: deps.addConnections,
        signal,
      }),
    ];
    let result: Awaited<ReturnType<typeof runInteractive<SetupState>>>;
    try {
      result = await runInteractive(boxes, state, prompterSink(prompter), {
        snapshot: snapshotSetupState,
        signal,
      });
    } catch (error) {
      const observed = await checkProject(() => deps.listAuthoredConnections(appRoot));
      if (!authored.has(pick) && observed.includes(pick)) {
        // The connection file landed before a later local step threw. Keep it
        // and retain the failure for the result.
        authored = new Set(observed);
        retainedFailures.set(pick, toErrorMessage(error));
        if (signal?.aborted === true) break;
        continue;
      }
      // A remote provisioning failure throws before the connection file is
      // scaffolded, so it propagates to the command handler.
      throw error;
    }
    if (result.kind === "done") {
      state = result.state;
    }
    // Whether the sub-flow completed or was cancelled, re-read the durable set:
    // a scaffolded file counts even when a later box cancelled.
    const observed = await checkProject(() => deps.listAuthoredConnections(appRoot));
    authored = new Set(observed);
    if (authored.has(pick)) {
      configuredThisRun.add(pick);
      retainedFailures.delete(pick);
    }
    signal?.throwIfAborted();
  }

  if (retainedFailures.size === 0) {
    return { kind: "done", addedConnections: addedConnections() };
  }
  return {
    kind: "failed",
    addedConnections: addedConnections(),
    message: [...retainedFailures.values()].join("; "),
  };
}
