import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { pickExistingVercelProject } from "./vercel-project-picker.js";

describe("pickExistingVercelProject", () => {
  it("orders recent projects newest first", async () => {
    const single = vi.fn((options) => {
      expect(options.options.map((option: { label: string }) => option.label)).toEqual([
        "newer",
        "older",
        "Search all projects",
      ]);
      return "newer";
    });
    const { prompter } = createFakePrompter({ single });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [
          { id: "prj_old", name: "older", updatedAt: 1 },
          { id: "prj_new", name: "newer", updatedAt: 2 },
        ],
        search: vi.fn(),
      }),
    ).resolves.toBe("newer");
  });

  it("searches the full team scope and merges results by id", async () => {
    const single = vi
      .fn()
      .mockImplementationOnce(
        (options) =>
          options.options.find(
            (option: { label: string }) => option.label === "Search all projects",
          )?.value,
      )
      .mockImplementationOnce((options) => {
        expect(options.options.map((option: { label: string }) => option.label)).toEqual([
          "found",
          "recent-updated",
          "Search all projects",
        ]);
        return "found";
      });
    const search = vi.fn(async () => [
      { id: "prj_recent", name: "recent-updated", updatedAt: 20 },
      { id: "prj_found", name: "found", updatedAt: 30 },
    ]);
    const { prompter } = createFakePrompter({ single, text: () => " found " });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [{ id: "prj_recent", name: "recent", updatedAt: 10 }],
        search,
      }),
    ).resolves.toBe("found");
    expect(search).toHaveBeenCalledWith("found");
  });

  it("reports an empty server search and reopens the picker", async () => {
    const single = vi
      .fn()
      .mockImplementationOnce(
        (options) =>
          options.options.find(
            (option: { label: string }) => option.label === "Search all projects",
          )?.value,
      )
      .mockResolvedValueOnce("recent");
    const { prompter } = createFakePrompter({ single, text: () => "missing" });

    await expect(
      pickExistingVercelProject({
        prompter,
        team: "team-a",
        projects: [{ id: "prj_recent", name: "recent", updatedAt: 10 }],
        search: async () => [],
      }),
    ).resolves.toBe("recent");
    expect(prompter.note).toHaveBeenCalledWith('No projects matched "missing" in team-a.');
  });
});
