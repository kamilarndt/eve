import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import type { SessionState } from "#client/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createSession(
  state: SessionState = { streamIndex: 0 },
  options: { readonly preserveCompletedSessions?: boolean } = {},
) {
  const context: ConstructorParameters<typeof ClientSession>[0] = {
    host: "https://eve.test",
    maxReconnectAttempts: 0,
    preserveCompletedSessions: options.preserveCompletedSessions ?? false,
    async resolveHeaders() {
      return new Headers();
    },
  };

  return new ClientSession(context, state);
}

function createAcceptedResponse() {
  return Response.json(
    {
      continuationToken: "eve:test",
      ok: true,
      sessionId: "session_1",
    },
    { status: 202 },
  );
}

function createStreamResponse(events: readonly unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
  );
}

describe("ClientSession", () => {
  it("serializes clientContext when sending a create-session message", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession();

    await session.send({
      clientContext: { selectedWord: "jazz" },
      message: "What word is selected?",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: { selectedWord: "jazz" },
      message: "What word is selected?",
    });
  });

  it("serializes clientContext when continuing a session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 0,
    });

    await session.send({
      clientContext: "approve button visible",
      inputResponses: [{ requestId: "approval_1", optionId: "approve" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      clientContext: "approve button visible",
      continuationToken: "eve:test",
      inputResponses: [{ requestId: "approval_1", optionId: "approve" }],
    });
  });

  it("rejects clientContext-only sends", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(createAcceptedResponse());
    const session = createSession({
      continuationToken: "eve:test",
      sessionId: "session_1",
      streamIndex: 0,
    });

    await expect(
      session.send({
        clientContext: { selectedWord: "jazz" },
      }),
    ).rejects.toThrow("Session.send requires a non-empty message, inputResponses, or both.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues the session after consuming through session.waiting", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    const session = createSession();

    const first = await session.send("first");
    for await (const _event of first) {
      // Drain the stream so ClientSession can advance its cursor.
    }
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session/session_1");
    expect(postRequests[1]!.body).toEqual({
      continuationToken: "eve:test",
      message: "second",
    });
  });

  it("skips a replayed prior turn and its stale wait boundary", async () => {
    let streamRequest = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") return createAcceptedResponse();

      streamRequest += 1;
      if (streamRequest === 1) {
        return createStreamResponse(turnEvents(0, "first"));
      }
      return createStreamResponse([...turnEvents(0, "first"), ...turnEvents(1, "second")]);
    });
    const session = createSession();

    expect((await (await session.send("first")).result()).message).toBe("first");
    const second = await (await session.send("second")).result();

    expect(second.message).toBe("second");
    expect(second.events).toEqual(turnEvents(1, "second"));
    expect(session.state).toMatchObject({
      lastTurnId: "turn_1",
      sessionId: "session_1",
      streamIndex: 12,
    });
  });

  it("filters interleaved duplicate events from a concurrent turn replay", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") return createAcceptedResponse();

      const [started, completed, turnCompleted, waiting] = turnEvents(0, "answer");
      return createStreamResponse([
        started,
        started,
        completed,
        completed,
        turnCompleted,
        turnCompleted,
        waiting,
      ]);
    });
    const session = createSession();

    const result = await (await session.send("question")).result();

    expect(result.message).toBe("answer");
    expect(result.events).toEqual(turnEvents(0, "answer"));
    expect(session.state).toMatchObject({ lastTurnId: "turn_0", streamIndex: 7 });
  });

  it("cancels a parked stream after collecting its result", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "session.waiting", data: { wait: "next-user-message" } })}\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createAcceptedResponse();
      }

      return new Response(stream);
    });
    const session = createSession();

    const result = await (await session.send("first")).result();

    expect(result.status).toBe("waiting");
    expect(cancelled).toBe(true);
  });

  it("resets the session by default after consuming through session.completed", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([{ type: "session.completed", data: {} }]);
    });
    const session = createSession();

    await (await session.send("first")).result();
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session");
    expect(postRequests[1]!.body).toEqual({
      message: "second",
    });
  });

  it("continues the session after session.completed when configured", async () => {
    const requests: Array<{ body?: unknown; method: string; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const method = init?.method ?? "GET";
      requests.push({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method,
        url,
      });

      if (method === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([{ type: "session.completed", data: {} }]);
    });
    const session = createSession({ streamIndex: 0 }, { preserveCompletedSessions: true });

    await (await session.send("first")).result();
    await session.send("second");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const postRequests = requests.filter((request) => request.method === "POST");
    expect(new URL(postRequests[1]!.url).pathname).toBe("/eve/v1/session/session_1");
    expect(postRequests[1]!.body).toEqual({
      continuationToken: "eve:test",
      message: "second",
    });
  });

  it("returns input requests emitted during the consumed turn", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createAcceptedResponse();
      }

      return createStreamResponse([
        {
          type: "input.requested",
          data: {
            requests: [
              {
                action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "bash" },
                prompt: "Approve?",
                requestId: "approval_1",
              },
            ],
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_1",
          },
        },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ]);
    });
    const session = createSession();

    const result = await (await session.send("first")).result();

    expect(result.inputRequests.map((request) => request.requestId)).toEqual(["approval_1"]);
  });
});

function turnEvents(sequence: number, message: string): readonly unknown[] {
  return [
    { data: { sequence, turnId: `turn_${sequence}` }, type: "turn.started" },
    {
      data: {
        finishReason: "stop",
        message,
        sequence,
        stepIndex: 0,
        turnId: `turn_${sequence}`,
      },
      type: "message.completed",
    },
    { data: { sequence, turnId: `turn_${sequence}` }, type: "turn.completed" },
    { data: { wait: "next-user-message" }, type: "session.waiting" },
  ];
}
