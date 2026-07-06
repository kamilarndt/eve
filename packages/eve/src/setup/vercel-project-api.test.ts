import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureVercel, type VercelCaptureResult } from "#setup/primitives/index.js";

import { listRecentProjects, listTeams, searchProjects } from "./vercel-project-api.js";

vi.mock("#setup/primitives/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/primitives/index.js")>()),
  captureVercel: vi.fn(),
}));

const mockedCaptureVercel = vi.mocked(captureVercel);
const captured = (value: unknown): VercelCaptureResult => ({
  ok: true,
  stdout: JSON.stringify(value),
});
const failed = (stderr: string): VercelCaptureResult => ({
  ok: false,
  failure: { code: 1, message: "Vercel CLI failed.", stderr, stdout: "" },
});

beforeEach(() => {
  mockedCaptureVercel.mockReset();
});

describe("listTeams", () => {
  it("drains every page and deduplicates by slug", async () => {
    mockedCaptureVercel
      .mockResolvedValueOnce(
        captured({
          teams: [{ name: "Current", slug: "current", current: true }],
          pagination: { next: 20 },
        }),
      )
      .mockResolvedValueOnce(
        captured({
          teams: [
            { name: "Current", slug: "current", current: true },
            { name: "Other", slug: "other", current: false },
          ],
          pagination: { next: null },
        }),
      );

    await expect(listTeams("/repo")).resolves.toEqual([
      { name: "Current", slug: "current", current: true },
      { name: "Other", slug: "other", current: false },
    ]);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["teams", "ls", "--format", "json", "--next", "20"],
      { cwd: "/repo", signal: undefined },
    );
  });

  it("drains a team list that spans the 20-item page limit even when Vercel echoes the same cursor", async () => {
    // Repro for an `eve init` report: a user with 23 teams (over the 20-item
    // page limit) got a pagination-cursor failure. Vercel's `next` cursor is
    // a createdAt timestamp (ms), so teams created in the same millisecond
    // (bulk-provisioned accounts) can make it repeat across pages even though
    // the next page still returns new teams, not the same page again. A pure
    // "seen this cursor before" check treats that as an infinite loop and
    // fails the request; it should only bail when a page stops making
    // progress.
    const firstPage = Array.from({ length: 20 }, (_, i) => ({
      name: `Team ${i + 1}`,
      slug: `team-${i + 1}`,
      current: i === 0,
    }));
    const secondPage = Array.from({ length: 3 }, (_, i) => ({
      name: `Team ${i + 21}`,
      slug: `team-${i + 21}`,
      current: false,
    }));
    const boundaryCursor = 1_700_000_000_000;

    mockedCaptureVercel
      .mockResolvedValueOnce(captured({ teams: firstPage, pagination: { next: boundaryCursor } }))
      .mockResolvedValueOnce(captured({ teams: secondPage, pagination: { next: boundaryCursor } }))
      .mockResolvedValueOnce(captured({ teams: [], pagination: { next: null } }));

    const teams = await listTeams("/repo");

    expect(teams).toHaveLength(23);
    expect(teams.map((team) => team.slug)).toEqual([
      ...firstPage.map((team) => team.slug),
      ...secondPage.map((team) => team.slug),
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledTimes(3);
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      2,
      ["teams", "ls", "--format", "json", "--next", String(boundaryCursor)],
      { cwd: "/repo", signal: undefined },
    );
    expect(mockedCaptureVercel).toHaveBeenNthCalledWith(
      3,
      ["teams", "ls", "--format", "json", "--next", String(boundaryCursor)],
      { cwd: "/repo", signal: undefined },
    );
  });

  it("rejects a cursor that stops making progress", async () => {
    mockedCaptureVercel.mockResolvedValue(captured({ teams: [], pagination: { next: 20 } }));

    await expect(listTeams("/repo")).rejects.toThrow("stopped making progress");
  });

  it("rejects an invalid entry instead of returning a partial page", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({ teams: [{ name: "Missing current", slug: "broken" }] }),
    );

    await expect(listTeams("/repo")).rejects.toThrow("Could not read teams");
  });
});

describe("listRecentProjects", () => {
  it("returns one team-scoped page without following its cursor", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({
        projects: [{ id: "prj_recent", name: "recent" }],
        pagination: { next: 8 },
      }),
    );

    await expect(listRecentProjects("/repo", "team-a")).resolves.toEqual([
      { id: "prj_recent", name: "recent" },
    ]);
    expect(mockedCaptureVercel).toHaveBeenCalledOnce();
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["project", "ls", "--format", "json", "--scope", "team-a"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("routes a scoped SSO denial to a human action", async () => {
    mockedCaptureVercel.mockResolvedValue(failed("This team requires SAML Single Sign-On."));

    await expect(listRecentProjects("/repo", "team-a")).rejects.toMatchObject({
      name: "HumanActionRequiredError",
      action: { kind: "vercel-forbidden", command: "vercel login" },
    });
  });

  it("honors cancellation that lands while the CLI result is settling", async () => {
    const abort = new AbortController();
    mockedCaptureVercel.mockImplementation(async () => {
      abort.abort();
      return captured({ projects: [] });
    });

    await expect(
      listRecentProjects("/repo", "team-a", { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("searchProjects", () => {
  it("returns a ranked matching page and its continuation cursor", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({
        projects: [
          { id: "prj_infix", name: "env" },
          { id: "prj_prefix", name: "v-api" },
          { id: "prj_exact", name: "v" },
        ],
        pagination: { next: 7 },
      }),
    );

    await expect(searchProjects("/repo", "team-a", " V ")).resolves.toEqual({
      projects: [
        { id: "prj_exact", name: "v" },
        { id: "prj_prefix", name: "v-api" },
        { id: "prj_infix", name: "env" },
      ],
      next: 7,
    });
    expect(mockedCaptureVercel).toHaveBeenCalledOnce();
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["project", "ls", "--format", "json", "--scope", "team-a", "--filter", "V"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("loads and ranks a requested continuation page", async () => {
    mockedCaptureVercel.mockResolvedValue(
      captured({
        projects: [
          { id: "prj_infix", name: "env" },
          { id: "prj_prefix", name: "v-api" },
        ],
        pagination: { next: null },
      }),
    );
    const continuation = { next: 7 };

    await expect(searchProjects("/repo", "team-a", "v", continuation)).resolves.toEqual({
      projects: [
        { id: "prj_prefix", name: "v-api" },
        { id: "prj_infix", name: "env" },
      ],
    });
    expect(mockedCaptureVercel).toHaveBeenCalledWith(
      ["project", "ls", "--format", "json", "--scope", "team-a", "--filter", "v", "--next", "7"],
      { cwd: "/repo", signal: undefined, timeoutMs: 15_000 },
    );
  });

  it("rejects empty queries", async () => {
    await expect(searchProjects("/repo", "team-a", "  ")).rejects.toThrow("cannot be empty");
  });
});
