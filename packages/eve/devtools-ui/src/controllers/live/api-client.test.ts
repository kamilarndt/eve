import { afterEach, describe, expect, it, vi } from "vitest";

import { DevToolsApiClient, DevToolsApiError } from "@ui/controllers/live/api-client";

describe("DevToolsApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authenticates JSON requests without putting the capability in the URL", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer local-capability");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DevToolsApiClient("local-capability", "http://127.0.0.1:4310");

    await expect(client.get("/api/v1/bootstrap")).resolves.toEqual({ ok: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4310/api/v1/bootstrap");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("local-capability");
  });

  it("surfaces structured API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Capability expired." }, { status: 401 })),
    );
    const client = new DevToolsApiClient("expired", "http://127.0.0.1:4310");

    await expect(client.get("/api/v1/bootstrap")).rejects.toEqual(
      expect.objectContaining<Partial<DevToolsApiError>>({
        message: "Capability expired.",
        status: 401,
      }),
    );
  });

  it("parses authenticated SSE records and stops when aborted", async () => {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('id: 7\nevent: run.updated\ndata: {"sessionId":"session-1"}\n\n'),
        );
      },
    });
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer stream-capability");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DevToolsApiClient("stream-capability", "http://127.0.0.1:4310");
    const events: unknown[] = [];

    await client.subscribe({
      onConnectionChange: () => {},
      onEvent(event) {
        events.push(event);
        abort.abort();
      },
      signal: abort.signal,
    });

    expect(events).toEqual([{ data: { sessionId: "session-1" }, event: "run.updated", id: "7" }]);
  });
});
