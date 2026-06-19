import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPromptCommandOutput, WHIMSY_POOLS } from "#setup/cli/index.js";
import { captureVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { HumanActionRequiredError } from "#setup/human-action.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "./prompter.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  assertNewProjectNameAvailable,
  getVercelAuthStatus,
  linkProject,
  pickNewProjectName,
  pickProject,
  pickTeam,
  requireAuth,
  validateTeam,
} from "./vercel-project.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#setup/primitives/index.js")>();
  return {
    ...original,
    captureVercel: vi.fn(),
  };
});

vi.mock("./project-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-resolution.js")>()),
  readProjectLink: vi.fn(),
  writeProjectLink: vi.fn(),
}));

import { readProjectLink, writeProjectLink } from "./project-resolution.js";

const mockedCaptureVercel = vi.mocked(captureVercel);
const mockedReadProjectLink = vi.mocked(readProjectLink);
const mockedWriteProjectLink = vi.mocked(writeProjectLink);

/** Wraps stdout as a successful capture result for the mocked `captureVercel`. */
const captured = (stdout: string): VercelCaptureResult => ({ ok: true, stdout });

const failedCapture = (stdout: string, stderr = ""): VercelCaptureResult => ({
  ok: false,
  failure: {
    code: 1,
    message: "vercel api exited with code 1.",
    stderr,
    stdout,
  },
});

/** Minimal prompter whose spinner and one chosen select can be observed. */
function createSpyPrompter(overrides: {
  spinner?: NonNullable<Prompter["log"]["spinner"]>;
  single?: (opts: SingleSelectOptions<PrompterValue>) => PrompterValue | Promise<PrompterValue>;
}): Prompter {
  const base = createFakePrompter(overrides.single ? { single: overrides.single } : {}).prompter;
  return { ...base, log: { ...base.log, spinner: overrides.spinner } };
}

beforeEach(() => {
  mockedCaptureVercel.mockReset();
  mockedReadProjectLink.mockReset();
  mockedWriteProjectLink.mockReset();
});

describe("getVercelAuthStatus", () => {
  it("reports authenticated when whoami succeeds", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(captured("acme\n"));
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("authenticated");
  });

  it("reports logged-out when whoami ran but exited non-zero", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failedCapture("", "Error: Not authenticated"));
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("logged-out");
  });

  it("reports cli-missing — not logged-out — when the binary is absent (ENOENT)", async () => {
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: { errno: "ENOENT", stderr: "", stdout: "", message: "Vercel CLI not found." },
    });
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("cli-missing");
  });

  it("reports unavailable — not logged-out — on a transient fault (DNS/network)", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture("", "Error: getaddrinfo ENOTFOUND api.vercel.com"),
    );
    await expect(getVercelAuthStatus("/tmp/eve-agent")).resolves.toBe("unavailable");
  });
});

describe("requireAuth", () => {
  it("throws a CLI-missing action (not a login action) on ENOENT", async () => {
    mockedCaptureVercel.mockResolvedValueOnce({
      ok: false,
      failure: { errno: "ENOENT", stderr: "", stdout: "", message: "Vercel CLI not found." },
    });
    await expect(requireAuth("/tmp/eve-agent")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-cli-missing", command: "npm i -g vercel@latest" },
    });
  });

  it("throws a login action when whoami reports no credentials", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(failedCapture("", "Error: Not authenticated"));
    await expect(requireAuth("/tmp/eve-agent")).rejects.toMatchObject({
      action: { kind: "vercel-login" },
    });
  });

  it("throws a plain error (not a login action) on a transient fault", async () => {
    mockedCaptureVercel.mockResolvedValueOnce(
      failedCapture("", "Error: getaddrinfo ENOTFOUND api.vercel.com"),
    );
    const error = await requireAuth("/tmp/eve-agent").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(HumanActionRequiredError);
    expect(error).toMatchObject({
      message: expect.stringContaining("Couldn't verify your Vercel"),
    });
  });
});

describe("pickTeam", () => {
  it("shows a spinner around the team pull and stops it before selection", async () => {
    stubVercel({
      teams: [
        { slug: "team-a", name: "Team A", current: true },
        { slug: "team-b", name: "Team B", current: false },
      ],
    });
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner, single: async () => "team-b" });

    await expect(pickTeam(prompter, "/tmp/eve-agent", undefined)).resolves.toBe("team-b");
    // The copy is randomized per run; assert pool membership, not one phrasing.
    expect(WHIMSY_POOLS.teams).toContain(spinner.mock.calls[0]?.[0]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the spinner even when the team pull throws", async () => {
    mockedCaptureVercel.mockRejectedValue(new Error("network down"));
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner });

    await expect(pickTeam(prompter, "/tmp/eve-agent", undefined)).rejects.toThrow("network down");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("pickProject", () => {
  it("labels the spinner with the team and stops it before selection", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ projects: [{ name: "p1", id: "prj_p1", updatedAt: 1 }] })),
    );
    const stop = vi.fn();
    const spinner = vi.fn((_message: string) => ({ stop }));
    const prompter = createSpyPrompter({ spinner, single: async () => "p1" });

    await expect(pickProject(prompter, "/tmp/eve-agent", "team-a")).resolves.toEqual({
      project: "p1",
      exists: true,
    });
    // Randomized copy: the team name must still anchor the step.
    expect(spinner.mock.calls[0]?.[0]).toContain("team-a");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("pickNewProjectName", () => {
  it("prompts for a replacement when the default project name already exists", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
      )
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      );
    const text = vi.fn(() => "my-agent-2");
    const { prompter } = createFakePrompter({ text });

    await expect(
      pickNewProjectName(prompter, "/tmp/eve-agent", "team-a", "my-agent"),
    ).resolves.toBe("my-agent-2");
    // The collision rides the question as a notice (gone once a free name
    // lands), not a persistent log line.
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "New project name",
        notices: [
          expect.objectContaining({
            tone: "warning",
            text: expect.stringContaining("already exists in"),
          }),
        ],
      }),
    );
    expect(prompter.note).not.toHaveBeenCalled();
  });
});

describe("assertNewProjectNameAvailable", () => {
  it("uses an exact project lookup instead of a paginated list", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).rejects.toThrow(
      'Vercel project "my-agent" already exists in team-a. Pass --project my-agent to link it, or choose a different project name.',
    );
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent" },
    );
  });

  it("treats a proven 404 as available", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "not_found", message: "Project not found" } })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).resolves.toBeUndefined();
  });

  it("does not turn lookup failures into availability", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } })),
    );

    await expect(
      assertNewProjectNameAvailable("/tmp/eve-agent", "team-a", "my-agent"),
    ).rejects.toThrow("Could not resolve project");
  });
});

describe("linkProject", () => {
  it("writes an already-resolved project without another API lookup", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
    );
    mockedReadProjectLink.mockResolvedValue({ projectId: "prj_existing", orgId: "team-a" });
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "existing", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toBe(true);

    expect(mockedCaptureVercel).toHaveBeenCalledTimes(1);
    expect(mockedWriteProjectLink).toHaveBeenCalledWith({
      projectRoot: "/tmp/eve-agent",
      link: { projectId: "prj_existing", orgId: "team-a", projectName: "my-agent" },
      signal: undefined,
    });
  });

  it("rejects a persisted link whose ids differ from the resolved project", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_expected", name: "my-agent", accountId: "team-a" })),
    );
    mockedReadProjectLink.mockResolvedValue({ projectId: "prj_other", orgId: "team-a" });
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "existing", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow('Linked project identity did not match Vercel project "my-agent".');
  });

  it("fails a new-project plan when that project name already exists", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured(JSON.stringify({ id: "prj_existing", name: "my-agent", accountId: "team-a" })),
    );
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow(
      'Vercel project "my-agent" already exists in team-a. Pass --project my-agent to link it, or choose a different project name.',
    );
    expect(mockedWriteProjectLink).not.toHaveBeenCalled();
  });

  it("fails an existing-project plan when the project cannot be resolved exactly", async () => {
    mockedCaptureVercel.mockResolvedValue(
      failedCapture(JSON.stringify({ error: { code: "not_found", message: "Project not found" } })),
    );
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "existing", project: "missing-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).rejects.toThrow('Vercel project "missing-agent" was not found in team-a.');
    expect(mockedWriteProjectLink).not.toHaveBeenCalled();
  });

  it("creates and links an available new project", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        failedCapture(
          JSON.stringify({ error: { code: "not_found", message: "Project not found" } }),
        ),
      )
      .mockResolvedValueOnce(
        captured(JSON.stringify({ id: "prj_new", name: "my-agent", accountId: "team-a" })),
      );
    mockedReadProjectLink.mockResolvedValue({
      projectId: "prj_new",
      orgId: "team-a",
      projectName: "my-agent",
    });
    const { prompter } = createFakePrompter();

    await expect(
      linkProject(
        prompter,
        "/tmp/eve-agent",
        { kind: "new", project: "my-agent", team: "team-a" },
        createPromptCommandOutput(prompter.log),
      ),
    ).resolves.toBe(true);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      1,
      ["api", "/v9/projects/my-agent", "--scope", "team-a", "--raw"],
      { cwd: "/tmp/eve-agent" },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      [
        "api",
        "/v10/projects",
        "--scope",
        "team-a",
        "--method",
        "POST",
        "--raw-field",
        "name=my-agent",
        "--raw",
      ],
      { cwd: "/tmp/eve-agent", onOutput: expect.any(Function) },
    );
    expect(mockedWriteProjectLink).toHaveBeenCalledWith({
      projectRoot: "/tmp/eve-agent",
      link: { projectId: "prj_new", orgId: "team-a", projectName: "my-agent" },
      signal: undefined,
    });
  });
});

/** Stubs the `vercel` CLI lookups the provisioning prompts perform. */
function stubVercel(responses: {
  whoami?: string;
  teams?: { name: string; slug: string; current: boolean }[];
  projects?: { name: string; id: string; updatedAt?: number }[];
}): void {
  mockedCaptureVercel.mockImplementation(async (args): Promise<VercelCaptureResult> => {
    const failed = (): VercelCaptureResult => ({
      ok: false,
      failure: {
        code: 1,
        stdout: "",
        stderr: "",
        message: `vercel ${args.join(" ")} exited with code 1.`,
      },
    });
    if (args[0] === "whoami") return { ok: true, stdout: responses.whoami ?? "me" };
    if (args[0] === "teams" && args[1] === "ls") {
      return responses.teams === undefined
        ? failed()
        : { ok: true, stdout: JSON.stringify({ teams: responses.teams }) };
    }
    if (args[0] === "api" && args[1]?.startsWith("/v9/projects?limit=20")) {
      return responses.projects === undefined
        ? failed()
        : {
            ok: true,
            stdout: JSON.stringify({
              projects: responses.projects.map((project, index) => ({
                ...project,
                updatedAt: project.updatedAt ?? index,
              })),
            }),
          };
    }
    return failed();
  });
}

/**
 * A prompter that answers from queued values and records each select message.
 * `selects` answers both plain and searchable single-selects, in call order.
 */
function answeringPrompter(answers: { selects?: PrompterValue[]; texts?: string[] }): {
  prompter: Prompter;
  selectMessages: string[];
} {
  const selects = [...(answers.selects ?? [])];
  const texts = [...(answers.texts ?? [])];
  const unexpected = (): never => {
    throw new Error("Unexpected prompt in a vercel-project test.");
  };
  return createFakePrompter({
    text: () => texts.shift() ?? unexpected(),
    single: () => selects.shift() ?? unexpected(),
  });
}

describe("pickTeam selection", () => {
  it("filters and returns the chosen team slug when several exist", async () => {
    stubVercel({
      teams: [
        { name: "Current", slug: "current", current: true },
        { name: "Other", slug: "other", current: false },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["other"] });

    await expect(pickTeam(prompter, "/tmp/parent", undefined)).resolves.toBe("other");
    expect(selectMessages).toEqual(["Select your team"]);
  });

  it("uses the current scope without prompting when only one team exists", async () => {
    stubVercel({ teams: [{ name: "Solo", slug: "solo", current: true }] });
    const { prompter } = answeringPrompter({});

    await expect(pickTeam(prompter, "/tmp/parent", undefined)).resolves.toBe("solo");
  });
});

describe("pickProject selection", () => {
  it("returns an existing selection as exists:true", async () => {
    stubVercel({
      projects: [
        { name: "alpha", id: "prj_a" },
        { name: "beta", id: "prj_b" },
      ],
    });
    const { prompter, selectMessages } = answeringPrompter({ selects: ["beta"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      project: "beta",
      exists: true,
    });
    expect(selectMessages).toEqual(["Project to link"]);
  });

  it("returns a typed-in name as exists:false when no projects exist", async () => {
    stubVercel({ projects: [] });
    const { prompter } = answeringPrompter({ texts: ["fresh-agent"] });

    await expect(pickProject(prompter, "/tmp/parent", "team")).resolves.toEqual({
      project: "fresh-agent",
      exists: false,
    });
  });

  it("refuses to create a project when the picker is existing-only", async () => {
    stubVercel({ projects: [] });
    const { prompter } = answeringPrompter({});

    await expect(
      pickProject(prompter, "/tmp/parent", "team", { allowCreateWhenEmpty: false }),
    ).rejects.toThrow("No existing Vercel projects found in team.");
  });
});

describe("validateTeam", () => {
  it("throws fast when the slug is absent from a non-empty team list", async () => {
    stubVercel({ teams: [{ name: "Other", slug: "other", current: true }] });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).rejects.toThrow(
      /Team "missing" was not found/,
    );
  });

  it("does not block when the readable team list is empty", async () => {
    stubVercel({ teams: [] });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).resolves.toBeUndefined();
  });

  it("rejects when the team list is unreadable", async () => {
    stubVercel({ teams: undefined });
    const { prompter } = answeringPrompter({});

    await expect(validateTeam(prompter, "/tmp/parent", "missing")).rejects.toThrow(
      /Could not list Vercel teams/,
    );
  });
});
