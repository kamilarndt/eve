import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientError } from "#client/client-error.js";
import { createDevToolsEventHub } from "#internal/devtools/event-hub.js";
import { createDevToolsRunsDomain } from "./runs-domain.js";

const mocks = vi.hoisted(() => ({
  responses: [] as unknown[],
  sends: [] as unknown[],
  sessions: [] as unknown[],
}));

vi.mock("#client/index.js", () => ({
  Client: class {
    session(options?: unknown) {
      mocks.sessions.push(options);
      return {
        send: async (input: unknown) => {
          mocks.sends.push(input);
          const response = mocks.responses.shift();
          if (response === undefined) throw new Error("Missing mocked message response.");
          if (response instanceof Error) throw response;
          return response;
        },
      };
    }
  },
}));

describe("createDevToolsRunsDomain", () => {
  beforeEach(() => {
    mocks.responses.length = 0;
    mocks.sends.length = 0;
    mocks.sessions.length = 0;
  });

  it("reduces canonical events, bounds replay, continues at waiting, and prunes terminal runs", async () => {
    mocks.responses.push(
      createResponse("session-1", "continue-1", [
        event("session.started"),
        event("turn.started"),
        event("session.waiting"),
      ]),
    );
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 20 }),
      eventLimit: 2,
      runLimit: 1,
    });

    await expect(domain.create("hello")).resolves.toMatchObject({
      sessionId: "session-1",
      status: "running",
      title: "hello",
    });
    await vi.waitFor(() => {
      expect(domain.get("session-1")).toMatchObject({
        eventCount: 3,
        retainedEventCount: 2,
        status: "waiting",
      });
    });
    expect(domain.events("session-1", 0).events.map(({ event }) => event.type)).toEqual([
      "turn.started",
      "session.waiting",
    ]);
    expect(() => domain.events("session-1", 1)).toThrow(/older than retained history/u);

    mocks.responses.push(
      createResponse("session-1", undefined, [event("turn.started"), event("session.waiting")]),
    );
    await expect(domain.continue("session-1", "next")).resolves.toMatchObject({
      status: "running",
    });
    await vi.waitFor(() => {
      expect(domain.get("session-1").status).toBe("waiting");
    });
    expect(mocks.sessions[1]).toEqual({
      continuationToken: "continue-1",
      sessionId: "session-1",
      streamIndex: 3,
    });

    mocks.responses.push(createResponse("session-1", undefined, [event("session.completed")]));
    await expect(domain.continue("session-1", "third")).resolves.toMatchObject({
      status: "running",
    });
    await vi.waitFor(() => {
      expect(domain.get("session-1").status).toBe("completed");
    });
    expect(mocks.sessions[2]).toEqual({
      continuationToken: "continue-1",
      sessionId: "session-1",
      streamIndex: 5,
    });

    mocks.responses.push(createResponse("session-2", "continue-3", []));
    await domain.create("replacement");
    expect(domain.list().map(({ sessionId }) => sessionId)).toEqual(["session-2"]);
  });

  it("derives a bounded title from the first user message", async () => {
    mocks.responses.push(createResponse("session-1", "continue-1", []));
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    const run = await domain.create(
      "  Compare the weather across Berlin, Paris, Amsterdam, Copenhagen, and Vienna  ",
    );

    expect(run.title).toBe("Compare the weather across Berlin, Paris, Amste…");
  });

  it("lists the most recently created runs first", async () => {
    mocks.responses.push(
      createResponse("session-1", undefined, []),
      createResponse("session-2", undefined, []),
      createResponse("session-3", undefined, []),
    );
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    await domain.create("first");
    await domain.create("second");
    await domain.create("third");

    expect(domain.list().map(({ sessionId }) => sessionId)).toEqual([
      "session-3",
      "session-2",
      "session-1",
    ]);
  });

  it("distinguishes pending actions from an ordinary input boundary", async () => {
    mocks.responses.push(
      createResponse("session-1", "continue-1", [
        inputRequestedEvent("ask_question", "select"),
        event("session.waiting"),
      ]),
    );
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    await domain.create("hello");
    await vi.waitFor(() => {
      expect(domain.get("session-1")).toMatchObject({
        pendingAction: { kind: "question", name: "ask_question" },
        status: "waiting",
      });
    });

    mocks.responses.push(createBlockedResponse("session-1"));
    await expect(domain.continue("session-1", "answer")).resolves.toMatchObject({
      pendingAction: undefined,
      status: "running",
    });
  });

  it("rejects continuation and capacity changes while runs are active", async () => {
    mocks.responses.push(createBlockedResponse("session-1"));
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
      runLimit: 1,
    });
    await domain.create("hello");

    await expect(domain.continue("session-1", "too soon")).rejects.toMatchObject({
      code: "run_not_waiting",
      status: 409,
    });
    await expect(domain.create("over capacity")).rejects.toMatchObject({
      code: "run_capacity_reached",
      status: 503,
    });
    expect(() => domain.get("missing")).toThrow(/not found/u);
  });

  it("surfaces runtime client failures as structured DevTools errors", async () => {
    mocks.responses.push(
      new ClientError(409, JSON.stringify({ error: "Continuation token is invalid." })),
    );
    const domain = createDevToolsRunsDomain({
      assertInteractive: () => "http://127.0.0.1:3000/",
      eventHub: createDevToolsEventHub({ replayLimit: 10 }),
    });

    await expect(domain.create("hello")).rejects.toMatchObject({
      code: "runtime_request_failed",
      message: "Continuation token is invalid.",
      status: 409,
    });
  });
});

function event(type: HandleMessageStreamEvent["type"]): HandleMessageStreamEvent {
  return { data: {}, type } as HandleMessageStreamEvent;
}

function inputRequestedEvent(
  toolName: string,
  display: "confirmation" | "select" | "text",
): HandleMessageStreamEvent {
  return {
    data: {
      requests: [
        {
          action: { callId: "call-1", input: {}, kind: "tool-call", toolName },
          display,
          prompt: "Choose one",
          requestId: "request-1",
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
    },
    type: "input.requested",
  };
}

function createResponse(
  sessionId: string,
  continuationToken: string | undefined,
  events: readonly HandleMessageStreamEvent[],
): unknown {
  return {
    continuationToken,
    sessionId,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

function createBlockedResponse(sessionId: string): unknown {
  return {
    continuationToken: "continue-blocked",
    sessionId,
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<never>(() => {}),
      };
    },
  };
}
