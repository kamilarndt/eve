import { afterEach, describe, expect, it, vi } from "vitest";

import { Client } from "#client/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Client request policy", () => {
  it("enforces its redirect policy for info, health, raw fetch, and sessions", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          agent: { model: { id: "openai/gpt-5.5" } },
          diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
          kind: "eve-agent-info",
          version: 1,
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, status: "ready", workflowId: "wf" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "session_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(`${JSON.stringify({ data: {}, type: "session.completed" })}\n`),
      );
    const client = new Client({ host: "https://eve.test", redirect: "manual" });
    const signal = new AbortController().signal;

    await client.info({ signal });
    await client.health();
    await client.fetch("/custom", { redirect: "follow" });
    await (await client.session().send("hello")).result();

    expect(fetchMock.mock.calls).toHaveLength(5);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("rejects a non-Eve response from the agent info route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ kind: "eve-agent-info", version: 1 }),
    );
    const client = new Client({ host: "https://eve.test" });

    await expect(client.info()).rejects.toThrow(SyntaxError);
  });

  it.each([null, { kind: "gateway", connected: true }, { kind: "external" }])(
    "rejects an invalid model endpoint from the agent info route",
    async (endpoint) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          agent: { model: { endpoint, id: "openai/gpt-5.5" } },
          diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
          kind: "eve-agent-info",
          version: 1,
        }),
      );
      const client = new Client({ host: "https://eve.test" });

      await expect(client.info()).rejects.toThrow(SyntaxError);
    },
  );

  it("aborts while dynamic request headers are still resolving", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new Client({
      host: "https://eve.test",
      headers: () => new Promise<Readonly<Record<string, string>>>(() => {}),
    });
    const abort = new AbortController();
    const reason = new Error("cancelled");

    const info = client.info({ signal: abort.signal });
    abort.abort(reason);

    await expect(info).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a session send while dynamic request headers are still resolving", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new Client({
      host: "https://eve.test",
      headers: () => new Promise<Readonly<Record<string, string>>>(() => {}),
    });
    const abort = new AbortController();
    const reason = new Error("cancelled");

    const send = client.session().send({
      message: "hello",
      signal: abort.signal,
    });
    abort.abort(reason);

    await expect(send).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
