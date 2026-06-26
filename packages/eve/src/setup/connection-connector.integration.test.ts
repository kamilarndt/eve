import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { captureVercel, runVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";

import {
  parseConnectors,
  parseCreatedConnector,
  setupConnectionConnector,
} from "./connection-connector.js";

vi.mock("#setup/primitives/run-vercel.js", () => ({
  captureVercel: vi.fn(),
  runVercel: vi.fn(),
  runVercelCaptureStdout: vi.fn(),
}));

const capture = vi.mocked(captureVercel);
const run = vi.mocked(runVercel);
const create = vi.mocked(runVercelCaptureStdout);
const SERVICE = "mcp.linear.app/mcp";
const CANONICAL_UID = "mcp.linear.app/linear";

function jsonResult(value: unknown) {
  return { ok: true as const, stdout: JSON.stringify(value) };
}

function connectorResult(uid: string, id: string, subject: "app" | "user") {
  return jsonResult({ uid, id, service: SERVICE, supportedSubjectTypes: [subject] });
}

describe("connector response parsing", () => {
  it("parses terminal JSON and rejects created connectors without user support", () => {
    const response = { uid: "linear/acme", id: "scl_1", supportedSubjectTypes: ["user"] };
    expect(
      parseCreatedConnector(`Connector ready\n\u001B[32m${JSON.stringify(response)}\u001B[0m`),
    ).toEqual({
      uid: "linear/acme",
      id: "scl_1",
    });
    expect(
      parseCreatedConnector(JSON.stringify({ ...response, supportedSubjectTypes: ["app"] })),
    ).toBeUndefined();
    expect(
      parseConnectors(
        {
          connectors: [
            { uid: "linear/acme", id: "scl_1", name: "acme", service: SERVICE },
            { uid: "notion/acme", id: "scl_2", service: "mcp.notion.com/mcp" },
          ],
        },
        SERVICE,
      ),
    ).toEqual([{ uid: "linear/acme", id: "scl_1", name: "acme" }]);
  });
});

describe("setupConnectionConnector", () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), "eve-connect-"));
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_1", orgId: "org_1" }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  function options(prompter = createFakePrompter().prompter) {
    return {
      log: prompter.log,
      prompter,
      projectRoot,
      slug: "linear",
      service: SERVICE,
      canonicalConnectorUid: CANONICAL_UID,
      linkProject: async () => "prj_1",
    };
  }

  it("attaches the canonical connector without listing or creating", async () => {
    run.mockResolvedValue(true);

    await expect(setupConnectionConnector(options())).resolves.toEqual({
      kind: "existing",
      connectorUid: CANONICAL_UID,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      ["connect", "attach", CANONICAL_UID, "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("paginates and offers only existing connectors that support user authorization", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture
      .mockResolvedValueOnce(
        jsonResult({
          connectors: [{ uid: "linear/app", id: "scl_app" }],
          cursor: "next_page",
        }),
      )
      .mockResolvedValueOnce(jsonResult({ connectors: [{ uid: "linear/user", id: "scl_user" }] }))
      .mockResolvedValueOnce(connectorResult("linear/app", "scl_app", "app"))
      .mockResolvedValueOnce(connectorResult("linear/user", "scl_user", "user"));
    const answers = ["find", "linear/user"];
    const selectOptions: SingleSelectOptions<PrompterValue>[] = [];
    const fake = createFakePrompter({
      single: (input) => {
        selectOptions.push(input);
        return answers.shift()!;
      },
    });

    await expect(setupConnectionConnector(options(fake.prompter))).resolves.toEqual({
      kind: "existing",
      connectorUid: "linear/user",
    });
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["--next", "next_page"]),
      expect.any(Object),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["--scope", "org_1"]),
      expect.any(Object),
    );
    expect(fake.selectMessages).toEqual([
      "Which connector should linear use?",
      "Select a connector for linear",
    ]);
    expect(selectOptions[0]).toMatchObject({
      hintLayout: "inline",
      notices: [{ tone: "warning", text: `Could not attach ${CANONICAL_UID}.` }],
    });
    expect(selectOptions[1]).toMatchObject({
      hintLayout: "inline",
      placeholder: "type to search connectors",
      search: true,
    });
  });

  it("accepts an array connector inventory from the CLI", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture
      .mockResolvedValueOnce(jsonResult([{ uid: "linear/user", id: "scl_user" }]))
      .mockResolvedValueOnce(connectorResult("linear/user", "scl_user", "user"));
    const answers = ["find", "linear/user"];
    const fake = createFakePrompter({ single: () => answers.shift()! });

    await expect(setupConnectionConnector(options(fake.prompter))).resolves.toEqual({
      kind: "existing",
      connectorUid: "linear/user",
    });
  });

  it("removes a created connector when attach fails", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture.mockResolvedValue(
      jsonResult({ connectors: [{ uid: CANONICAL_UID, id: "scl_existing", name: "Linear" }] }),
    );
    create.mockResolvedValue(connectorResult("linear/linear-2", "scl_created", "user"));
    const fake = createFakePrompter({
      single: () => "create",
      text: (input) => input.defaultValue!,
    });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      "Could not attach linear/linear-2",
    );
    expect(create).toHaveBeenCalledWith(
      ["connect", "create", SERVICE, "--name", "linear-2", "-F", "json", "--scope", "org_1"],
      expect.any(Object),
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_created", "--disconnect-all", "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });

  it("recovers a partially created connector id from CLI progress and removes it", async () => {
    run.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    capture.mockResolvedValue(jsonResult({ connectors: [] }));
    create.mockImplementation(async (_args, createOptions) => {
      createOptions.onOutput?.({ stream: "stderr", text: "Connector created: scl_partial" });
      return { ok: false, stdout: "" };
    });
    const fake = createFakePrompter({ single: () => "create", text: () => "acme" });

    await expect(setupConnectionConnector(options(fake.prompter))).rejects.toThrow(
      `Could not create the ${SERVICE} connector`,
    );
    expect(run).toHaveBeenLastCalledWith(
      ["connect", "remove", "scl_partial", "--disconnect-all", "--yes", "--scope", "org_1"],
      expect.any(Object),
    );
  });
});
