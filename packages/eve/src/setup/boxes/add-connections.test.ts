import { describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import { headlessAsker, interactiveAsker } from "../ask.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "../prompter.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { addConnections, type AddConnectionsDeps } from "./add-connections.js";
import { selectConnections } from "./select-connections.js";

const silentSink: OutputSink = { write: () => {} };
const snapshot = { snapshot: snapshotSetupState };

function resolvedState(): SetupState {
  const state = createDefaultSetupState();
  state.projectPath = { kind: "resolved", inPlace: false, path: "/tmp/project" };
  state.vercelProject = { kind: "new", project: "project", team: "team" };
  state.project = { kind: "linked", projectId: "prj_demo" };
  return state;
}

function createDeps() {
  return {
    cleanupCreatedConnectionConnector: vi.fn<
      AddConnectionsDeps["cleanupCreatedConnectionConnector"]
    >(async () => {}),
    detectPackageManager: vi.fn<AddConnectionsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "lockfile",
    })),
    ensureConnection: vi.fn<AddConnectionsDeps["ensureConnection"]>(async (options) => ({
      slug: options.slug ?? options.entry.slug,
      protocol: options.protocol,
      action: "created",
      filePath: `/tmp/project/agent/connections/${options.slug ?? options.entry.slug}.ts`,
      filesWritten: [`/tmp/project/agent/connections/${options.slug ?? options.entry.slug}.ts`],
      filesSkipped: [],
      envKeysAdded: [],
      envKeysRequired: [],
    })),
    ensureConnectionDependencies: vi.fn<AddConnectionsDeps["ensureConnectionDependencies"]>(
      async () => [],
    ),
    listAuthoredConnections: vi.fn<AddConnectionsDeps["listAuthoredConnections"]>(async () => []),
    runPackageManagerInstall: vi.fn<AddConnectionsDeps["runPackageManagerInstall"]>(
      async () => true,
    ),
    setupConnectionConnector: vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(async () => ({
      kind: "attached-existing",
      connectorUid: "mcp.linear.app",
    })),
  } satisfies AddConnectionsDeps;
}

function boxes(input: {
  prompter: Prompter;
  deps: AddConnectionsDeps;
  presetConnections: string[];
  headless?: boolean;
}) {
  const headless = input.headless ?? false;
  return [
    selectConnections({
      asker: headless ? headlessAsker() : interactiveAsker(input.prompter),
      headless,
      presetConnections: input.presetConnections,
    }),
    addConnections({ prompter: input.prompter, deps: input.deps }),
  ] as const;
}

describe("selectConnections + addConnections", () => {
  test("headless scaffolding writes the canonical UID and instructs attach", async () => {
    const deps = createDeps();
    const prompter = createFakePrompter().prompter;

    await runHeadless(
      boxes({ prompter, deps, presetConnections: ["linear"], headless: true }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
    expect(deps.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          auth: expect.objectContaining({ connector: "mcp.linear.app/linear" }),
        }),
      }),
    );
    expect(prompter.log.info).toHaveBeenCalledWith(
      "Run `vercel connect attach mcp.linear.app/linear --yes`. If the canonical connector is unavailable, run `/connect` interactively.",
    );
  });

  test("provisions before writing the exact selected connector UID", async () => {
    const deps = createDeps();
    deps.setupConnectionConnector = vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(
      async () => ({
        kind: "attached-existing",
        connectorUid: "linear/team-selected",
      }),
    );
    const prompter = createFakePrompter().prompter;

    await runInteractive(
      boxes({ prompter, deps, presetConnections: ["linear"] }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(deps.setupConnectionConnector.mock.invocationCallOrder[0]).toBeLessThan(
      deps.ensureConnection.mock.invocationCallOrder[0]!,
    );
    expect(deps.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          auth: expect.objectContaining({ connector: "linear/team-selected" }),
        }),
      }),
    );
    expect(prompter.log.success).toHaveBeenCalledWith("Added agent/connections/linear.ts");
  });

  test("uses a two-step Find flow with a searchable connector list", async () => {
    const deps = createDeps();
    const requests: SingleSelectOptions<PrompterValue>[] = [];
    const prompter = createFakePrompter({
      single: (request) => {
        requests.push(request);
        return request.message.startsWith("Which connector") ? "find" : "linear/team-b";
      },
    }).prompter;
    deps.setupConnectionConnector = vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(
      async (options) => {
        const path = await options.prompts.choosePath({
          slug: "linear",
          service: "mcp.linear.app",
          canonicalConnectorUid: "mcp.linear.app/linear",
          notice: "Canonical unavailable",
        });
        expect(path).toEqual({ kind: "find" });
        const connector = await options.prompts.chooseExisting({
          slug: "linear",
          service: "mcp.linear.app",
          connectors: [
            { id: "scl_a", uid: "linear/team-a", name: "Alpha" },
            { id: "scl_b", uid: "linear/team-b", name: "Beta" },
          ],
        });
        if (connector === undefined) throw new Error("Expected an existing connector selection.");
        return { kind: "attached-existing", connectorUid: connector.uid };
      },
    );

    await runInteractive(
      boxes({ prompter, deps, presetConnections: ["linear"] }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(requests[0]?.options).toEqual([
      {
        value: "find",
        label: "Find a new one",
        hint: "Browse existing mcp.linear.app connectors",
      },
      {
        value: "create",
        label: "Create a new one",
        hint: "Register another mcp.linear.app connector",
      },
    ]);
    expect(requests[0]?.hintLayout).toBe("inline");
    expect(requests[1]).toMatchObject({
      search: true,
      placeholder: "type to search connectors",
      options: [
        { value: "linear/team-a", label: "linear/team-a", hint: "Alpha · scl_a" },
        { value: "linear/team-b", label: "linear/team-b", hint: "Beta · scl_b" },
      ],
    });
  });

  test("treats Esc in the existing-connector list as a return to Find/Create", async () => {
    const deps = createDeps();
    const prompter = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    }).prompter;
    deps.setupConnectionConnector = vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(
      async (options) => {
        await expect(
          options.prompts.chooseExisting({
            slug: "linear",
            service: "mcp.linear.app",
            connectors: [{ id: "scl_a", uid: "mcp.linear.app/linear", name: "linear" }],
          }),
        ).resolves.toBeUndefined();
        return { kind: "attached-existing", connectorUid: "mcp.linear.app/linear" };
      },
    );

    await runInteractive(
      boxes({ prompter, deps, presetConnections: ["linear"] }),
      resolvedState(),
      silentSink,
      snapshot,
    );
  });

  test("requires an explicit Create choice and validates the requested name", async () => {
    const deps = createDeps();
    let nameRequest: Parameters<Prompter["text"]>[0] | undefined;
    const prompter = createFakePrompter({
      single: () => "create",
      text: (request) => {
        nameRequest = request;
        return "linear-new";
      },
    }).prompter;
    deps.setupConnectionConnector = vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(
      async (options) => {
        await options.prompts.choosePath({
          slug: "linear",
          service: "mcp.linear.app",
          canonicalConnectorUid: "mcp.linear.app",
        });
        const name = await options.prompts.promptName({
          slug: "linear",
          service: "mcp.linear.app",
          suggestedName: "linear-2",
          unavailableNames: ["linear"],
        });
        return {
          kind: "attached-created",
          connectorId: "scl_new",
          connectorUid: `mcp.linear.app/${name}`,
        };
      },
    );

    await runInteractive(
      boxes({ prompter, deps, presetConnections: ["linear"] }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(nameRequest).toMatchObject({ message: "New connector name", defaultValue: "linear-2" });
    expect(nameRequest?.validate?.("  ")).toBe("Connector name cannot be empty.");
    expect(nameRequest?.validate?.("LINEAR")).toBe('Connector name "LINEAR" already exists.');
  });

  test("installs Connect dependencies once before provisioning multiple connectors", async () => {
    const deps = createDeps();
    const prompter = createFakePrompter().prompter;

    await runInteractive(
      boxes({ prompter, deps, presetConnections: ["linear", "notion"] }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(deps.ensureConnectionDependencies).toHaveBeenCalledOnce();
    expect(deps.runPackageManagerInstall).toHaveBeenCalledOnce();
    expect(deps.setupConnectionConnector).toHaveBeenCalledTimes(2);
    expect(deps.runPackageManagerInstall.mock.invocationCallOrder[0]).toBeLessThan(
      deps.setupConnectionConnector.mock.invocationCallOrder[0]!,
    );
  });

  test("dependency failure happens before any remote connector mutation", async () => {
    const deps = createDeps();
    deps.runPackageManagerInstall = vi.fn<AddConnectionsDeps["runPackageManagerInstall"]>(
      async () => false,
    );

    await expect(
      runInteractive(
        boxes({ prompter: createFakePrompter().prompter, deps, presetConnections: ["linear"] }),
        resolvedState(),
        silentSink,
        snapshot,
      ),
    ).rejects.toThrow(/pnpm install/);
    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
    expect(deps.ensureConnection).not.toHaveBeenCalled();
  });

  test("removes a connector created by this run when the file write fails", async () => {
    const deps = createDeps();
    deps.setupConnectionConnector = vi.fn<AddConnectionsDeps["setupConnectionConnector"]>(
      async () => ({
        kind: "attached-created",
        connectorId: "scl_new",
        connectorUid: "linear/new",
      }),
    );
    deps.ensureConnection = vi.fn<AddConnectionsDeps["ensureConnection"]>(async () => {
      throw new Error("disk full");
    });

    await expect(
      runInteractive(
        boxes({ prompter: createFakePrompter().prompter, deps, presetConnections: ["linear"] }),
        resolvedState(),
        silentSink,
        snapshot,
      ),
    ).rejects.toThrow("disk full");
    expect(deps.cleanupCreatedConnectionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "scl_new", projectRoot: "/tmp/project" }),
    );
  });

  test("does not provision or install for an authored connection", async () => {
    const deps = createDeps();
    deps.listAuthoredConnections = vi.fn<AddConnectionsDeps["listAuthoredConnections"]>(
      async () => ["linear"],
    );
    deps.ensureConnection = vi.fn<AddConnectionsDeps["ensureConnection"]>(async () => ({
      slug: "linear",
      protocol: "mcp",
      action: "skipped",
      filePath: "/tmp/project/agent/connections/linear.ts",
      filesWritten: [],
      filesSkipped: ["/tmp/project/agent/connections/linear.ts"],
      envKeysAdded: [],
      envKeysRequired: [],
    }));

    await runInteractive(
      boxes({
        prompter: createFakePrompter().prompter,
        deps,
        presetConnections: ["linear"],
      }),
      resolvedState(),
      silentSink,
      snapshot,
    );

    expect(deps.ensureConnectionDependencies).not.toHaveBeenCalled();
    expect(deps.setupConnectionConnector).not.toHaveBeenCalled();
  });
});
