import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { AddConnectionsDeps } from "../boxes/add-connections.js";
import type { DeploymentInfo } from "../project-resolution.js";
import type { PrompterValue, SelectOption, SingleSelectOptions } from "../prompter.js";
import { WizardCancelledError } from "../step.js";

import {
  CONNECTIONS_PROMPT_MESSAGE,
  runConnectionsFlow,
  type ConnectionsFlowDeps,
} from "./connections.js";

const APP_ROOT = "/app/my-agent";
const UNLINKED: DeploymentInfo = { state: "unlinked" };
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };

const CANCEL = Symbol("cancel");

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Scripts the action-list loop: each list paint consumes the next pick (and
 * records the painted rows), while every other single-select (a protocol
 * pick) resolves to its first option so a catalog entry that asks for a
 * protocol does not dead-end the test.
 */
function scriptList(picks: ReadonlyArray<PrompterValue | typeof CANCEL>) {
  const queue = [...picks];
  const listPaints: SelectOption<PrompterValue>[][] = [];
  const listRequests: SingleSelectOptions<PrompterValue>[] = [];
  const single = (opts: SingleSelectOptions<PrompterValue>): PrompterValue => {
    if (opts.message !== CONNECTIONS_PROMPT_MESSAGE) {
      const first = opts.options[0];
      if (first === undefined) throw new Error(`Unexpected empty select: ${opts.message}`);
      return first.value;
    }
    listRequests.push(opts);
    listPaints.push(opts.options);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("The connection list was asked more times than the test scripted.");
    }
    if (next === CANCEL) throw new WizardCancelledError();
    return next;
  };
  return { single, listPaints, listRequests };
}

/**
 * A stateful add-connections stub: `ensureConnection` records the slug as
 * authored (the file landing on disk), so the injected `listAuthoredConnections`
 * sees it on the next read — exactly as the real scaffold behaves.
 */
function createAddConnectionsDeps(
  authored: Set<string>,
  options: { connectorThrows?: boolean } = {},
) {
  return {
    cleanupCreatedConnectionConnector: vi.fn<
      AddConnectionsDeps["cleanupCreatedConnectionConnector"]
    >(async () => {}),
    detectPackageManager: vi.fn<AddConnectionsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "lockfile",
    })),
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (opts) => {
      const slug = opts.slug ?? opts.entry.slug;
      const action = authored.has(slug) ? "skipped" : "created";
      authored.add(slug);
      return {
        slug,
        protocol: opts.protocol,
        action,
        filePath: `${APP_ROOT}/agent/connections/${opts.slug}.ts`,
        filesWritten: action === "created" ? [`${APP_ROOT}/agent/connections/${opts.slug}.ts`] : [],
        filesSkipped: action === "skipped" ? [`${APP_ROOT}/agent/connections/${opts.slug}.ts`] : [],
        envKeysAdded: [],
        envKeysRequired: [],
      };
    }),
    ensureConnectionDependencies: vi.fn<AddConnectionsDeps["ensureConnectionDependencies"]>(
      async () => [],
    ),
    listAuthoredConnections: vi.fn<AddConnectionsDeps["listAuthoredConnections"]>(async () => [
      ...authored,
    ]),
    runPackageManagerInstall: vi.fn<AddConnectionsDeps["runPackageManagerInstall"]>(
      async () => true,
    ),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () => {
      if (options.connectorThrows === true) throw new Error("Connector provisioning failed.");
      return { kind: "attached-existing", connectorUid: "linear/uid" };
    }),
  } satisfies AddConnectionsDeps;
}

function runWith(args: {
  deployment: DeploymentInfo;
  authStatus?: "authenticated" | "logged-out" | "cli-missing" | "unavailable";
  authored: Set<string>;
  picks: ReadonlyArray<PrompterValue | typeof CANCEL>;
  addConnections: AddConnectionsDeps;
  detectDeployment?: ConnectionsFlowDeps["detectDeployment"];
}) {
  const { single, listPaints, listRequests } = scriptList(args.picks);
  const fake = createFakePrompter({ single });
  const result = runConnectionsFlow({
    appRoot: APP_ROOT,
    prompter: fake.prompter,
    deps: {
      detectDeployment: args.detectDeployment ?? vi.fn(async () => args.deployment),
      listAuthoredConnections: vi.fn(async () => [...args.authored]),
      getVercelAuthStatus: vi.fn(async () => args.authStatus ?? "authenticated"),
      addConnections: args.addConnections,
    },
  });
  return { result, listPaints, listRequests };
}

describe("runConnectionsFlow", () => {
  it("adds the picked connection, repaints it as a checked task, and Done exits", async () => {
    const authored = new Set<string>();
    const addConnections = createAddConnectionsDeps(authored);
    const { result, listPaints, listRequests } = runWith({
      deployment: LINKED,
      authored,
      picks: ["linear", "done"],
      addConnections,
    });

    await expect(result).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });
    expect(addConnections.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "linear", projectRoot: APP_ROOT }),
    );
    // The list repaints from a fresh authored read: linear is now checked.
    expect(listPaints).toHaveLength(2);
    expect(listRequests[0]).toMatchObject({
      message: "Select an MCP server to add to your agent through Vercel Connect",
      hintLayout: "inline",
    });
    expect(listRequests[0]).not.toHaveProperty("search");
    const linearRow = listPaints[1]?.find((option) => option.value === "linear");
    expect(linearRow).toMatchObject({ completed: true, focusHint: "Already added" });
  });

  it("waits for remote provisioning before repainting the list or accepting Done", async () => {
    const authored = new Set<string>();
    const addConnections = createAddConnectionsDeps(authored);
    const remote = deferred<{
      kind: "attached-existing";
      connectorUid: string;
    }>();
    addConnections.setupConnectionConnector.mockImplementationOnce(() => remote.promise);
    const { result, listPaints } = runWith({
      deployment: LINKED,
      authored,
      picks: ["linear", "done"],
      addConnections,
    });

    await vi.waitFor(() => expect(addConnections.setupConnectionConnector).toHaveBeenCalledOnce());
    expect(listPaints).toHaveLength(1);
    expect(addConnections.ensureConnection).not.toHaveBeenCalled();

    remote.resolve({ kind: "attached-existing", connectorUid: "linear/uid" });
    await expect(result).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });
    expect(listPaints).toHaveLength(2);
  });

  it("keeps project selection out of /connect and directs unlinked users to eve link", async () => {
    const authored = new Set<string>();
    const { result, listPaints } = runWith({
      deployment: UNLINKED,
      authored,
      picks: ["done"],
      addConnections: createAddConnectionsDeps(authored),
    });

    await expect(result).resolves.toEqual({ kind: "done", addedConnections: [] });
    expect(listPaints[0]).not.toContainEqual(expect.objectContaining({ value: "link-project" }));
    const linearRow = listPaints[0]?.find((option) => option.value === "linear");
    expect(linearRow).toMatchObject({
      disabled: true,
      disabledReason: "Run eve link first",
      disabledReasonTone: "warning",
    });
  });

  it("disables connections when logged out even though the project is linked", async () => {
    const authored = new Set<string>();
    const { result, listPaints } = runWith({
      deployment: LINKED,
      authStatus: "logged-out",
      authored,
      picks: ["done"],
      addConnections: createAddConnectionsDeps(authored),
    });

    await expect(result).resolves.toEqual({ kind: "done", addedConnections: [] });
    const linearRow = listPaints[0]?.find((option) => option.value === "linear");
    expect(linearRow).toMatchObject({
      disabled: true,
      disabledReason: "Log in to Vercel first, see /vc:login",
    });
  });

  it("returns cancelled when the list is dismissed with nothing added", async () => {
    const authored = new Set<string>();
    const { result } = runWith({
      deployment: LINKED,
      authored,
      picks: [CANCEL],
      addConnections: createAddConnectionsDeps(authored),
    });

    await expect(result).resolves.toEqual({ kind: "cancelled" });
  });

  it("reports additions when the list is dismissed after adding one", async () => {
    const authored = new Set<string>();
    const { result } = runWith({
      deployment: LINKED,
      authored,
      picks: ["linear", CANCEL],
      addConnections: createAddConnectionsDeps(authored),
    });

    await expect(result).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });
  });

  it("propagates remote provisioning failure before authoring the connection", async () => {
    const authored = new Set<string>();
    const addConnections = createAddConnectionsDeps(authored, { connectorThrows: true });
    const { result } = runWith({
      deployment: LINKED,
      authored,
      picks: ["linear", "done"],
      addConnections,
    });

    await expect(result).rejects.toThrow("Connector provisioning failed.");
    expect(authored).toEqual(new Set());
    expect(addConnections.ensureConnection).not.toHaveBeenCalled();
  });
});
