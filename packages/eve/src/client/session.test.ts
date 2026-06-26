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

  it("suppresses replayed event IDs across turns and advances past their records", async () => {
    let streamCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return createAcceptedResponse();
      }

      const firstMessage = {
        data: {
          finishReason: "stop",
          message: "First",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
        meta: { at: "2026-06-26T12:00:00.000Z", id: "evt_message_1" },
        type: "message.completed",
      };
      const firstWaiting = {
        data: { wait: "next-user-message" },
        meta: { at: "2026-06-26T12:00:01.000Z", id: "evt_waiting_1" },
        type: "session.waiting",
      };

      streamCount += 1;
      if (streamCount === 1) {
        return createStreamResponse([firstMessage, firstWaiting]);
      }

      return createStreamResponse([
        firstMessage,
        firstWaiting,
        {
          data: {
            finishReason: "stop",
            message: "Second",
            sequence: 1,
            stepIndex: 0,
            turnId: "turn_1",
          },
          meta: { at: "2026-06-26T12:00:02.000Z", id: "evt_message_2" },
          type: "message.completed",
        },
        {
          data: { wait: "next-user-message" },
          meta: { at: "2026-06-26T12:00:03.000Z", id: "evt_waiting_2" },
          type: "session.waiting",
        },
      ]);
    });
    const session = createSession();

    await (await session.send("first")).result();
    const result = await (await session.send("second")).result();

    expect(result.events.map((event) => event.type)).toEqual([
      "message.completed",
      "session.waiting",
    ]);
    expect(result.message).toBe("Second");
    expect(session.state.streamIndex).toBe(6);
  });
});
