import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { AddConnectionsDeps } from "#setup/boxes/add-connections.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  CONNECTIONS_PROMPT_MESSAGE,
  runConnectionsFlow,
  type ConnectionsFlowDeps,
} from "./connections.js";

const APP_ROOT = "/app/agent";
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };

function scriptConnectionList(queue: Array<PrompterValue | "cancel">) {
  const requests: SingleSelectOptions<PrompterValue>[] = [];
  return {
    requests,
    single(options: SingleSelectOptions<PrompterValue>): PrompterValue {
      if (options.message !== CONNECTIONS_PROMPT_MESSAGE) {
        throw new Error(`Unexpected select: ${options.message}`);
      }
      requests.push(options);
      const next = queue.shift();
      if (next === undefined) throw new Error("Connection list exhausted its scripted picks.");
      if (next === "cancel") throw new WizardCancelledError();
      return next;
    },
  };
}

function addConnectionDeps(): AddConnectionsDeps {
  return {
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (options) => ({
      slug: options.slug ?? options.entry.slug,
      protocol: options.protocol,
      action: "created",
      filePath: `${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`,
      filesWritten: [`${APP_ROOT}/agent/connections/${options.slug ?? options.entry.slug}.ts`],
      filesSkipped: [],
      packageJsonUpdated: [],
      envKeysAdded: [],
      envKeysRequired: [],
    })),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () =>
      Object.freeze({ kind: "existing", connectorUid: "mcp.linear.app/linear" }),
    ),
    listAuthoredConnections: vi.fn(async () => []),
    cleanupCreatedConnectionConnector: vi.fn(async () => {}),
  };
}

function runConnectionFlow(
  list: ReturnType<typeof scriptConnectionList>,
  deps: Partial<ConnectionsFlowDeps> = {},
) {
  const defaults: ConnectionsFlowDeps = {
    detectDeployment: vi.fn(async () => LINKED),
    detectPackageManager: vi.fn(async () => Object.freeze({ kind: "pnpm", source: "default" })),
    ensureConnectionDependencies: vi.fn(async () => []),
    getVercelAuthStatus: vi.fn(() => Promise.resolve<"authenticated">("authenticated")),
    listAuthoredConnections: vi.fn(async () => []),
    runLinkFlow: vi.fn(async () => Object.freeze({ kind: "done" })),
    runPackageManagerInstall: vi.fn(async () => true),
    addConnections: addConnectionDeps(),
  };
  return runConnectionsFlow({
    appRoot: APP_ROOT,
    prompter: createFakePrompter({ single: list.single }).prompter,
    deps: { ...defaults, ...deps },
  });
}

describe("runConnectionsFlow", () => {
  it("adds a catalog connection and repaints the searchable list", async () => {
    const listAuthoredConnections = vi
      .fn(async () => [] as string[])
      .mockResolvedValueOnce([])
      .mockResolvedValue(["linear"]);
    const list = scriptConnectionList(["linear", "done"]);

    await expect(runConnectionFlow(list, { listAuthoredConnections })).resolves.toEqual({
      kind: "done",
      addedConnections: ["linear"],
    });

    expect(list.requests[0]).toMatchObject({
      hintLayout: "inline",
      search: true,
      placeholder: "type to search MCP servers",
    });
    expect(list.requests[0]?.options.map((row) => row.value)).toEqual(["linear", "notion", "done"]);
    expect(list.requests[1]?.options.find((row) => row.value === "linear")).toMatchObject({
      completed: true,
    });
  });

  it("defaults to Done when every catalog connection is already authored", async () => {
    const list = scriptConnectionList(["done"]);
    await runConnectionFlow(list, {
      listAuthoredConnections: vi.fn(async () => ["linear", "notion"]),
    });

    expect(list.requests[0]?.initialValue).toBe("done");
  });

  it("blocks logged-out rows", async () => {
    const loggedOutList = scriptConnectionList(["cancel"]);
    await expect(
      runConnectionFlow(loggedOutList, {
        detectDeployment: vi.fn(() => Promise.resolve<DeploymentInfo>({ state: "unlinked" })),
        getVercelAuthStatus: vi.fn(async (): Promise<"logged-out"> => "logged-out"),
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(loggedOutList.requests[0]?.options.find((row) => row.value === "linear")).toMatchObject({
      disabled: true,
      disabledReason: "Log in to Vercel first, see /vc:login",
    });
  });

  it("runs the shared create-or-link flow before configuring an unlinked project", async () => {
    const detectDeployment = vi
      .fn<ConnectionsFlowDeps["detectDeployment"]>()
      .mockResolvedValueOnce({ state: "unlinked" })
      .mockResolvedValueOnce(LINKED);
    const runLinkFlow = vi.fn<ConnectionsFlowDeps["runLinkFlow"]>(async () => ({ kind: "done" }));
    const listAuthoredConnections = vi
      .fn(async () => [] as string[])
      .mockResolvedValueOnce([])
      .mockResolvedValue(["linear"]);
    const list = scriptConnectionList(["linear", "done"]);
    await expect(
      runConnectionFlow(list, {
        detectDeployment,
        listAuthoredConnections,
        runLinkFlow,
      }),
    ).resolves.toEqual({ kind: "done", addedConnections: ["linear"] });

    const linkInput = runLinkFlow.mock.calls[0]?.[0];
    expect(linkInput?.projectSelection).toBe("create-or-link");
    expect(linkInput?.teamSelectMessage?.("Acme")).toBe(
      "You need to link to a project to use Vercel Connect.\n\nSelect your team",
    );
  });

  it("returns to the connection list when project linking is cancelled", async () => {
    const runLinkFlow = vi.fn(async () => Object.freeze({ kind: "cancelled" }));
    const list = scriptConnectionList(["linear", "done"]);

    await expect(
      runConnectionFlow(list, {
        detectDeployment: vi.fn(() => Promise.resolve<DeploymentInfo>({ state: "unlinked" })),
        runLinkFlow,
      }),
    ).resolves.toEqual({ kind: "done", addedConnections: [] });
  });

  it("does not mutate dependencies when connector selection is cancelled", async () => {
    const list = scriptConnectionList(["linear"]);
    const addConnections = addConnectionDeps();
    vi.mocked(addConnections.setupConnectionConnector).mockRejectedValueOnce(
      new WizardCancelledError(),
    );
    const ensureConnectionDependencies = vi.fn(async () => []);
    const runPackageManagerInstall = vi.fn(async () => true);

    await expect(
      runConnectionFlow(list, {
        addConnections,
        ensureConnectionDependencies,
        runPackageManagerInstall,
      }),
    ).resolves.toEqual({ kind: "cancelled" });

    expect(ensureConnectionDependencies).not.toHaveBeenCalled();
    expect(runPackageManagerInstall).not.toHaveBeenCalled();
  });
});
