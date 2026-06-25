import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

const TRISTATE_LOCATIONS = [
  "New York City, NY",
  "Brooklyn, NY",
  "Queens, NY",
  "Newark, NJ",
  "Jersey City, NJ",
  "Stamford, CT",
  "Bridgeport, CT",
  "Yonkers, NY",
  "Long Island, NY",
  "Hoboken, NJ",
] as const;

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) {
        throw new Error("Deferred promise resolver was not initialized.");
      }
      resolvePromise();
    },
  };
}

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "mock-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Searches weather for one location.",
          inputSchema: null,
          name: "web_search",
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:tool-batching",
    history: [],
    sessionId: "tool-batching",
  };
}

describe("batched tool execution", () => {
  it("starts ten independent web searches before any search is allowed to finish", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const releaseSearches = createDeferred();
    const startedLocations = new Set<string>();
    const expectedCallIds = TRISTATE_LOCATIONS.map((_, index) => `call-weather-${index}`);
    let actionBatchesAtFirstExecution: readonly (readonly string[])[] | undefined;

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            ...TRISTATE_LOCATIONS.map((location, index) => ({
              input: JSON.stringify({ location }),
              toolCallId: `call-weather-${index}`,
              toolName: "web_search",
              type: "tool-call" as const,
            })),
            {
              finishReason: { raw: undefined, unified: "tool-calls" },
              type: "finish" as const,
              usage: {
                inputTokens: {
                  cacheRead: undefined,
                  cacheWrite: undefined,
                  noCache: 1,
                  total: 1,
                },
                outputTokens: {
                  reasoning: undefined,
                  text: 0,
                  total: TRISTATE_LOCATIONS.length,
                },
              },
            },
          ],
        }),
      }),
    });
    const config: ToolLoopHarnessConfig = {
      handleEvent: async (event) => {
        events.push(event);
      },
      mode: "conversation",
      resolveModel: async () => model,
      tools: new Map([
        [
          "web_search",
          {
            description: "Searches weather for one location.",
            execute: async (input) => {
              if (startedLocations.size === 0) {
                actionBatchesAtFirstExecution = events
                  .filter((event) => event.type === "actions.requested")
                  .map((event) => event.data.actions.map((action) => action.callId));
              }

              const location = (input as { readonly location: string }).location;
              startedLocations.add(location);
              await releaseSearches.promise;
              return { location };
            },
            inputSchema: jsonSchema({
              additionalProperties: false,
              properties: { location: { type: "string" } },
              required: ["location"],
              type: "object",
            }),
            name: "web_search",
          },
        ],
      ]),
    };

    const run = createToolLoopHarness(config)(createSession(), {
      message: "Fan out weather searches across the tristate area.",
    });

    try {
      await vi.waitFor(() => expect(startedLocations).toEqual(new Set(TRISTATE_LOCATIONS)), {
        timeout: 1_000,
      });
      expect(actionBatchesAtFirstExecution).toEqual([expectedCallIds]);
    } finally {
      releaseSearches.resolve();
      await run;
    }
  });
});
