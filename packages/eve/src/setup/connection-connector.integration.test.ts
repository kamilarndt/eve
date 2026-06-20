import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "#setup/cli/index.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

import { listConnectionConnectors, parseCreatedConnectionConnector } from "./connection-connect.js";
import {
  setupConnectionConnector,
  type ConnectionConnectorPrompts,
} from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedRunVercel = vi.mocked(runVercel);
const mockedRunVercelCaptureStdout = vi.mocked(runVercelCaptureStdout);
const SERVICE = "mcp.linear.app";
const CANONICAL_CONNECTOR_UID = "mcp.linear.app/linear";

function success(stdout = ""): Awaited<ReturnType<typeof captureVercel>> {
  return { ok: true, stdout };
}

function failure(message: string): Awaited<ReturnType<typeof captureVercel>> {
  return { ok: false, failure: { code: 1, stderr: message, stdout: "", message } };
}

function connectorJson(
  uid: string,
  id = "scl_linear",
  supportedSubjectTypes: readonly string[] = ["user"],
): string {
  return JSON.stringify({
    id,
    uid,
    service: SERVICE,
    supportedSubjectTypes,
  });
}

function connectorList(
  connectors: readonly {
    id: string;
    uid: string;
    name?: string;
    projects?: unknown;
  }[],
  cursor?: string,
): string {
  return JSON.stringify({ connectors, cursor });
}

function createLog(): ChannelSetupLog {
  return {
    message: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    commandOutput: vi.fn(),
  };
}

function createPrompts(
  overrides: Partial<ConnectionConnectorPrompts> = {},
): ConnectionConnectorPrompts {
  return {
    choosePath: vi.fn<ConnectionConnectorPrompts["choosePath"]>(async () => ({
      kind: "create",
    })),
    chooseExisting: vi.fn<ConnectionConnectorPrompts["chooseExisting"]>(async (input) => {
      const connector = input.connectors[0];
      if (connector === undefined) throw new Error("No connector to select.");
      return { id: connector.id, uid: connector.uid };
    }),
    promptName: vi.fn<ConnectionConnectorPrompts["promptName"]>(async () => "linear-new"),
    ...overrides,
  };
}

describe("connection Connect boundary", () => {
  beforeEach(() => vi.resetAllMocks());

  test("parses the terminal user-authorizable JSON after create progress", () => {
    expect(
      parseCreatedConnectionConnector(
        `> Connector created: scl_linear\n${connectorJson("linear/new")}`,
        "user",
      ),
    ).toEqual({ id: "scl_linear", uid: "linear/new" });
    expect(
      parseCreatedConnectionConnector(
        JSON.stringify({ id: "scl_linear", uid: "linear/new", supportedSubjectTypes: [] }),
        "user",
      ),
    ).toBeUndefined();
    expect(parseCreatedConnectionConnector("not json", "user")).toBeUndefined();
  });

  test("parses the current CLI list shape and follows its cursor", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        success(
          connectorList(
            [
              {
                id: "scl_a",
                uid: "linear/a",
                name: "Alpha",
                projects: ["prj_a"],
              },
            ],
            "page-2",
          ),
        ),
      )
      .mockResolvedValueOnce(success(connectorList([{ id: "scl_b", uid: "linear/b" }])));

    await expect(
      listConnectionConnectors({ projectRoot: "/tmp/project", service: SERVICE }),
    ).resolves.toEqual([
      {
        id: "scl_a",
        uid: "linear/a",
        name: "Alpha",
      },
      { id: "scl_b", uid: "linear/b" },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["connect", "list", "--all-projects", "--service", SERVICE, "-F", "json", "--next", "page-2"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });

  test("parses a JSON list after the CLI progress preamble", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      success(
        `Vercel CLI 54.14.0\nFetching connectors…\n${connectorList([{ id: "scl_a", uid: "linear/a" }])}`,
      ),
    );

    await expect(
      listConnectionConnectors({ projectRoot: "/tmp/project", service: SERVICE }),
    ).resolves.toEqual([{ id: "scl_a", uid: "linear/a" }]);
  });

  test("ignores project-object metadata emitted by the current CLI", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      success(
        `Vercel CLI 54.14.0 (Node.js 26.0.0)\nFetching connectors…\n${connectorList([
          {
            id: "scl_a",
            uid: "mcp.notion.com/notion",
            name: "notion",
            projects: [{ id: "prj_a", name: "project-a" }],
          },
        ])}`,
      ),
    );

    await expect(
      listConnectionConnectors({ projectRoot: "/tmp/project", service: "mcp.notion.com" }),
    ).resolves.toEqual([{ id: "scl_a", uid: "mcp.notion.com/notion", name: "notion" }]);
  });

  test("rejects the obsolete raw API project shape", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      success(
        JSON.stringify({
          clients: [
            {
              id: "scl_a",
              uid: "linear/a",
              includes: { projects: { items: [{ projectId: "prj_a" }] } },
            },
          ],
        }),
      ),
    );
    await expect(
      listConnectionConnectors({ projectRoot: "/tmp/project", service: SERVICE }),
    ).rejects.toThrow(/invalid connector list/i);
  });
});

describe("setupConnectionConnector", () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    mockedRunVercel.mockResolvedValue(true);
    projectRoot = await mkdtemp(join(tmpdir(), "eve-connection-connect-"));
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_demo", orgId: "team_demo" }),
    );
  });

  afterEach(async () => rm(projectRoot, { force: true, recursive: true }));

  test("attaches the concrete canonical UID without listing or creating", async () => {
    mockedCaptureVercel.mockResolvedValue(success("{}"));
    const prompts = createPrompts();
    const log = createLog();

    await expect(
      setupConnectionConnector({
        log,
        principalType: "user",
        projectRoot,
        prompts,
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).resolves.toEqual({ kind: "attached-existing", connectorUid: CANONICAL_CONNECTOR_UID });

    expect(mockedCaptureVercel).toHaveBeenCalledOnce();
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["connect", "attach", CANONICAL_CONNECTOR_UID, "--yes", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedRunVercelCaptureStdout).not.toHaveBeenCalled();
    expect(prompts.choosePath).not.toHaveBeenCalled();
    expect(log.success).toHaveBeenCalledWith(`Attached ${CANONICAL_CONNECTOR_UID} connector`);
  });

  test("shows the canonical attach diagnostic before offering a fallback", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failure("Connector does not exist"));
    const choosePath = vi.fn<ConnectionConnectorPrompts["choosePath"]>(async (input) => {
      expect(input.notice).toBe(
        `Could not attach ${CANONICAL_CONNECTOR_UID}: Connector does not exist`,
      );
      throw new Error("stop after diagnostic");
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts({ choosePath }),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).rejects.toThrow("stop after diagnostic");
  });

  test("offers only existing connectors that support user authorization", async () => {
    const unsupported = { id: "scl_app", uid: "mcp.linear.app/app-only", name: "App only" };
    const supported = { id: "scl_user", uid: "mcp.linear.app/user", name: "User" };
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") {
        if (args[2] === CANONICAL_CONNECTOR_UID) return failure("Connector does not exist");
        return success("{}");
      }
      if (args[0] === "connect" && args[1] === "list")
        return success(connectorList([unsupported, supported]));
      if (args[0] === "api" && args[1]?.includes(unsupported.id)) {
        return success(connectorJson(unsupported.uid, unsupported.id, ["app"]));
      }
      if (args[0] === "api" && args[1]?.includes(supported.id)) {
        return success(connectorJson(supported.uid, supported.id));
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    const chooseExisting = vi.fn<ConnectionConnectorPrompts["chooseExisting"]>(async (input) => {
      expect(input.connectors).toEqual([supported]);
      return { id: supported.id, uid: supported.uid };
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts({
          choosePath: vi.fn<ConnectionConnectorPrompts["choosePath"]>(async () => ({
            kind: "find",
          })),
          chooseExisting,
        }),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).resolves.toEqual({ kind: "attached-existing", connectorUid: supported.uid });
    for (const [args, options] of mockedCaptureVercel.mock.calls) {
      if (args[0] === "api" || (args[0] === "connect" && args[1] === "attach")) {
        expect(options.onOutput).toBeUndefined();
      }
    }
  });

  test("returns to Find/Create when the existing-connector picker is cancelled", async () => {
    const supported = { id: "scl_user", uid: "mcp.linear.app/user", name: "User" };
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") {
        if (args[2] === CANONICAL_CONNECTOR_UID) return failure("Connector does not exist");
        return success("{}");
      }
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([supported]));
      if (args[0] === "api") return success(connectorJson(supported.uid, supported.id));
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: connectorJson("mcp.linear.app/new", "scl_new"),
    });
    const choosePath = vi
      .fn<ConnectionConnectorPrompts["choosePath"]>()
      .mockResolvedValueOnce({ kind: "find" })
      .mockResolvedValueOnce({ kind: "create" });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts({
          choosePath,
          chooseExisting: vi.fn<ConnectionConnectorPrompts["chooseExisting"]>(
            async () => undefined,
          ),
        }),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).resolves.toEqual({
      kind: "attached-created",
      connectorId: "scl_new",
      connectorUid: "mcp.linear.app/new",
    });
    expect(choosePath).toHaveBeenCalledTimes(2);
  });

  test("requires an explicit Find choice before using a sole noncanonical connector", async () => {
    const existing = { id: "scl_existing", uid: "linear/existing", name: "Existing" };
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach" && args[2] === CANONICAL_CONNECTOR_UID) {
        return failure("No connector found");
      }
      if (args[0] === "connect" && args[1] === "list") {
        return success(connectorList([existing]));
      }
      if (args[0] === "api") return success(connectorJson(existing.uid, existing.id));
      return success("{}");
    });
    const prompts = createPrompts({
      choosePath: vi.fn<ConnectionConnectorPrompts["choosePath"]>(async () => ({
        kind: "find",
      })),
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts,
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).resolves.toEqual({ kind: "attached-existing", connectorUid: existing.uid });
    expect(prompts.choosePath).toHaveBeenCalledOnce();
    expect(prompts.chooseExisting).toHaveBeenCalledWith(
      expect.objectContaining({ connectors: [existing] }),
    );
  });

  test("returns to Find/Create after Find produces an empty list", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach" && args[2] === CANONICAL_CONNECTOR_UID) {
        return failure("No connector found");
      }
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      return success("{}");
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: `> Connector created: scl_new\n${connectorJson("linear/new", "scl_new")}`,
    });
    const choosePath = vi
      .fn<ConnectionConnectorPrompts["choosePath"]>()
      .mockResolvedValueOnce({ kind: "find" })
      .mockResolvedValueOnce({ kind: "create" });
    const prompts = createPrompts({ choosePath });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts,
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).resolves.toEqual({
      kind: "attached-created",
      connectorId: "scl_new",
      connectorUid: "linear/new",
    });
    expect(choosePath).toHaveBeenCalledTimes(2);
    expect(choosePath).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ notice: `No ${SERVICE} connectors were found.` }),
    );
  });

  test("marks connector creation as an external browser-action wait", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach" && args[2] === CANONICAL_CONNECTOR_UID) {
        return failure("No connector found");
      }
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      return success("{}");
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: connectorJson("linear/new", "scl_new"),
    });
    const stop = vi.fn();
    const spinner = vi.fn(() => ({ stop }));
    const log = { ...createLog(), spinner } satisfies ChannelSetupLog;

    await setupConnectionConnector({
      log,
      principalType: "user",
      projectRoot,
      prompts: createPrompts(),
      service: SERVICE,
      canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
      slug: "linear",
    });

    expect(spinner).toHaveBeenCalledWith("Waiting for you to complete setup in the browser…", {
      kind: "external-action",
      emphasis: "browser",
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  test("cleans up and never attaches progress from a nonzero create", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") return failure("No connector found");
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      if (args[0] === "connect" && args[1] === "remove") return success("{}");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: false,
      stdout: "> Connector created: scl_partial\n",
      stderr: "Setup failed",
      failure: "exit",
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts(),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).rejects.toThrow(/could not create/i);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["connect", "remove", "scl_partial", "--disconnect-all", "--yes", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedCaptureVercel).not.toHaveBeenCalledWith(
      expect.arrayContaining(["attach", "linear/partial"]),
      expect.anything(),
    );
  });

  test("cleans up and never attaches JSON output from a nonzero create", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") return failure("No connector found");
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      if (args[0] === "connect" && args[1] === "remove") return success("{}");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    mockedRunVercelCaptureStdout.mockResolvedValueOnce({
      ok: false,
      stdout: connectorJson("linear/json-partial", "scl_json_partial"),
      stderr: "Setup failed",
      failure: "exit",
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts(),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).rejects.toThrow(/could not create/i);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["connect", "remove", "scl_json_partial", "--disconnect-all", "--yes", "-F", "json"],
      expect.objectContaining({ cwd: projectRoot }),
    );
    expect(mockedCaptureVercel).not.toHaveBeenCalledWith(
      expect.arrayContaining(["attach", "linear/json-partial"]),
      expect.anything(),
    );
  });

  test("cleans up a created connector when attachment fails", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") return failure("Attach denied");
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      if (args[0] === "connect" && args[1] === "remove") return success("{}");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: connectorJson("linear/new", "scl_new"),
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts(),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).rejects.toThrow(/could not attach linear\/new/i);
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      expect.arrayContaining(["remove", "scl_new"]),
      expect.objectContaining({ cwd: projectRoot }),
    );
  });

  test("reports the exact connector when cleanup fails", async () => {
    mockedCaptureVercel.mockImplementation(async (args) => {
      if (args[0] === "connect" && args[1] === "attach") return failure("Attach denied");
      if (args[0] === "connect" && args[1] === "list") return success(connectorList([]));
      if (args[0] === "connect" && args[1] === "remove") return failure("Delete denied");
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });
    mockedRunVercelCaptureStdout.mockResolvedValue({
      ok: true,
      stdout: connectorJson("linear/new", "scl_new"),
    });

    await expect(
      setupConnectionConnector({
        log: createLog(),
        principalType: "user",
        projectRoot,
        prompts: createPrompts(),
        service: SERVICE,
        canonicalConnectorUid: CANONICAL_CONNECTOR_UID,
        slug: "linear",
      }),
    ).rejects.toThrow("vercel connect remove scl_new --disconnect-all --yes");
  });
});
