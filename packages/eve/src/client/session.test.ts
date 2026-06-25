import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientSession } from "#client/session.js";
import type { ClientRedirectPolicy, SessionState } from "#client/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createSession(
  state: SessionState = { streamIndex: 0 },
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly preserveCompletedSessions?: boolean;
    readonly redirect?: ClientRedirectPolicy;
  } = {},
) {
  const context: ConstructorParameters<typeof ClientSession>[0] = {
    host: "https://eve.test",
    maxReconnectAttempts: 0,
    preserveCompletedSessions: options.preserveCompletedSessions ?? false,
    redirect: options.redirect,
    async resolveHeaders(perRequest) {
      return new Headers({ ...options.headers, ...perRequest });
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

function createContinuedResponse() {
  return Response.json({ ok: true, sessionId: "session_1" }, { status: 200 });
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
  it("cancels a message response through the authenticated turn route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createAcceptedResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
    const session = createSession(
      { streamIndex: 0 },
      { headers: { authorization: "Bearer test" }, redirect: "manual" },
    );

    const response = await session.send({
      headers: { "x-request-id": "request-1" },
      message: "Run until cancelled.",
    });
    await response.cancel();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://eve.test/eve/v1/session/session_1/cancel");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({
      continuationToken: "eve:test",
      scope: "turn",
    });
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer test");
    expect(headers.get("x-request-id")).toBe("request-1");
  });

  it("retains the existing continuation token on follow-up responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createContinuedResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
    const session = createSession({
      continuationToken: "eve:existing",
      sessionId: "session_1",
      streamIndex: 0,
    });

    const response = await session.send("Follow up.");
    await response.cancel();

    expect(response.continuationToken).toBe("eve:existing");
    const init = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      continuationToken: "eve:existing",
      scope: "turn",
    });
  });

  it("throws ClientError when turn cancellation is rejected", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createAcceptedResponse())
      .mockResolvedValueOnce(
        Response.json({ error: "No active turn.", ok: false }, { status: 409 }),
      );
    const session = createSession();
    const response = await session.send("Run until cancelled.");

    await expect(response.cancel()).rejects.toMatchObject({
      body: JSON.stringify({ error: "No active turn.", ok: false }),
      message: "No active turn.",
      name: "ClientError",
      status: 409,
    });
  });

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
});
