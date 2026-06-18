import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevToolsEventHub } from "#internal/devtools/event-hub.js";
import { createDevToolsSourcesDomain } from "./sources-domain.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  stat: mocks.stat,
}));

describe("createDevToolsSourcesDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readdir.mockImplementation(async (directory: string) => {
      switch (directory) {
        case "/app":
          return [directoryEntry(".eve"), directoryEntry("agent"), fileEntry("package.json")];
        case "/app/agent":
          return [directoryEntry("tools"), fileEntry("instructions.md")];
        case "/app/agent/tools":
          return [fileEntry("weather.ts")];
        default:
          throw new Error(`Unexpected directory: ${directory}`);
      }
    });
    mocks.readFile.mockResolvedValue("export const weather = true;\n");
    mocks.stat.mockResolvedValue({ size: 64 });
  });

  it("catalogs authored files and associates loaded local scripts", async () => {
    const eventHub = createDevToolsEventHub({ replayLimit: 10 });
    const domain = createDevToolsSourcesDomain({
      appRoot: "/app",
      eventHub,
      getRevision: () => "rev-2",
    });
    domain.recordScript({
      revision: "rev-2",
      scriptId: "script-1",
      sourceMapUrl: "weather.ts.map",
      url: pathToFileURL("/app/agent/tools/weather.ts").href,
    });
    domain.recordScript({
      scriptId: "external",
      url: pathToFileURL("/dependency/index.js").href,
    });

    await expect(domain.list()).resolves.toEqual([
      {
        id: "agent/instructions.md",
        kind: "authored",
        loaded: false,
        path: "agent/instructions.md",
        revision: "rev-2",
        scripts: [],
      },
      {
        id: "agent/tools/weather.ts",
        kind: "authored",
        loaded: true,
        path: "agent/tools/weather.ts",
        revision: "rev-2",
        scripts: [
          {
            scriptId: "script-1",
            sourceMapUrl: "weather.ts.map",
            url: pathToFileURL("/app/agent/tools/weather.ts").href,
          },
        ],
      },
      {
        id: "package.json",
        kind: "authored",
        loaded: false,
        path: "package.json",
        revision: "rev-2",
        scripts: [],
      },
    ]);
    expect(mocks.readdir).not.toHaveBeenCalledWith("/app/.eve", expect.anything());
    expect(eventHub.replayAfter("0").events).toMatchObject([
      { data: { sourceId: "agent/tools/weather.ts" }, event: "source.loaded" },
    ]);
  });

  it("retrieves cataloged source content and rejects paths outside the app", async () => {
    const domain = createDevToolsSourcesDomain({
      appRoot: "/app",
      eventHub: createDevToolsEventHub({ replayLimit: 1 }),
      getRevision: () => undefined,
    });

    await expect(domain.get("agent/tools/weather.ts")).resolves.toMatchObject({
      content: "export const weather = true;\n",
      source: { id: "agent/tools/weather.ts" },
    });
    await expect(domain.get("../secret.ts")).rejects.toMatchObject({
      code: "source_not_found",
      status: 404,
    });
  });

  it("resolves authored lines to generated CDP locations through source maps", async () => {
    const sourceMap = Buffer.from(
      JSON.stringify({
        mappings: "AAAA;AACA,CAAA",
        sources: [pathToFileURL("/app/agent/tools/weather.ts").href],
        version: 3,
      }),
    ).toString("base64");
    const domain = createDevToolsSourcesDomain({
      appRoot: "/app",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
      getRevision: () => "rev-2",
    });

    domain.recordScript({
      scriptId: "generated-script",
      sourceMapUrl: `data:application/json;base64,${sourceMap}`,
      url: pathToFileURL("/app/.eve/compile/weather.js").href,
    });

    await vi.waitFor(async () => {
      await expect(domain.locations("agent/tools/weather.ts", 2)).resolves.toEqual([
        { columnNumber: 0, lineNumber: 1, scriptId: "generated-script" },
      ]);
      expect(
        domain.originalLocation({
          columnNumber: 0,
          lineNumber: 1,
          scriptId: "generated-script",
        }),
      ).toEqual({ column: 1, line: 2, sourceId: "agent/tools/weather.ts" });
    });
  });
});

function directoryEntry(name: string): {
  isDirectory(): true;
  isFile(): false;
  name: string;
} {
  return { isDirectory: () => true, isFile: () => false, name };
}

function fileEntry(name: string): {
  isDirectory(): false;
  isFile(): true;
  name: string;
} {
  return { isDirectory: () => false, isFile: () => true, name };
}
