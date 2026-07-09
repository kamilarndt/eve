import { describe, expect, it, vi } from "vitest";

import {
  assertUrlSafeToFetch,
  readBodyTextSafe,
  safeFetch,
  type SafeFetchOptions,
} from "#shared/safe-fetch.js";

/** Resolver stub: maps a hostname to fixed addresses. */
function lookupReturning(addresses: string[]): SafeFetchOptions["lookup"] {
  return async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

const PUBLIC = lookupReturning(["93.184.216.34"]);

describe("assertUrlSafeToFetch", () => {
  it("accepts a public https host", async () => {
    await expect(
      assertUrlSafeToFetch("https://example.com/x", { lookup: PUBLIC }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects a reserved IP literal (cloud metadata)", async () => {
    await expect(assertUrlSafeToFetch("https://169.254.169.254/latest")).rejects.toThrow(
      /reserved/,
    );
  });

  it("rejects private IP literals", async () => {
    for (const host of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "[fd00::1]"]) {
      await expect(assertUrlSafeToFetch(`https://${host}/`)).rejects.toThrow(/reserved/);
    }
  });

  it("rejects a host that DNS-resolves to a private address", async () => {
    await expect(
      assertUrlSafeToFetch("https://rebind.example/", { lookup: lookupReturning(["10.0.0.5"]) }),
    ).rejects.toThrow(/reserved/);
  });

  it("rejects when any resolved address is unsafe", async () => {
    await expect(
      assertUrlSafeToFetch("https://mixed.example/", {
        lookup: lookupReturning(["93.184.216.34", "169.254.169.254"]),
      }),
    ).rejects.toThrow(/reserved/);
  });

  it("allows loopback by default and rejects it when disallowed", async () => {
    await expect(assertUrlSafeToFetch("https://127.0.0.1/")).resolves.toBeInstanceOf(URL);
    await expect(assertUrlSafeToFetch("https://localhost/")).resolves.toBeInstanceOf(URL);
    await expect(
      assertUrlSafeToFetch("https://127.0.0.1/", { allowLoopback: false }),
    ).rejects.toThrow(/reserved/);
    await expect(
      assertUrlSafeToFetch("https://localhost/", { allowLoopback: false }),
    ).rejects.toThrow(/reserved/);
  });

  it("pins protocol: rejects http unless allowHttp or loopback", async () => {
    await expect(assertUrlSafeToFetch("http://example.com/", { lookup: PUBLIC })).rejects.toThrow(
      /https/,
    );
    await expect(
      assertUrlSafeToFetch("http://example.com/", { lookup: PUBLIC, allowHttp: true }),
    ).resolves.toBeInstanceOf(URL);
    // Plain http on loopback is allowed for local dev.
    await expect(assertUrlSafeToFetch("http://localhost:3000/")).resolves.toBeInstanceOf(URL);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(assertUrlSafeToFetch("file:///etc/passwd")).rejects.toThrow(/https/);
  });

  it("enforces an optional host allowlist", async () => {
    await expect(
      assertUrlSafeToFetch("https://evil.com/", { lookup: PUBLIC, allowedHosts: ["example.com"] }),
    ).rejects.toThrow(/allowlist/);
    await expect(
      assertUrlSafeToFetch("https://api.example.com/", {
        lookup: PUBLIC,
        allowedHosts: ["example.com"],
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("prefixes errors with the label", async () => {
    await expect(
      assertUrlSafeToFetch("https://169.254.169.254/", { label: "my-connection" }),
    ).rejects.toThrow(/^my-connection:/);
  });
});

describe("safeFetch", () => {
  const ok = (body = "ok") => new Response(body, { status: 200 });

  it("fetches a validated URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok("hello"));
    const res = await safeFetch("https://example.com/", { lookup: PUBLIC, fetch: fetchImpl });
    expect(await res.text()).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("follows redirects and re-validates each hop", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/final")
        ? ok("done")
        : new Response(null, { status: 302, headers: { location: "https://example.com/final" } }),
    );
    const res = await safeFetch("https://example.com/start", { lookup: PUBLIC, fetch: fetchImpl });
    expect(await res.text()).toBe("done");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect to a private host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("start")
        ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })
        : ok(),
    );
    await expect(
      safeFetch("https://example.com/start", { lookup: PUBLIC, fetch: fetchImpl }),
    ).rejects.toThrow(/reserved/);
  });

  it("drops authorization/cookie on cross-origin redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("start")
        ? new Response(null, { status: 302, headers: { location: "https://other.example/next" } })
        : ok(),
    );
    await safeFetch("https://example.com/start", {
      lookup: PUBLIC,
      fetch: fetchImpl,
      headers: { authorization: "Bearer secret", cookie: "s=1", "x-keep": "1" },
    });
    const secondHopHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(secondHopHeaders.get("authorization")).toBeNull();
    expect(secondHopHeaders.get("cookie")).toBeNull();
    expect(secondHopHeaders.get("x-keep")).toBe("1");
  });

  it("keeps credentials on same-origin redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("start")
        ? new Response(null, { status: 307, headers: { location: "https://example.com/next" } })
        : ok(),
    );
    await safeFetch("https://example.com/start", {
      lookup: PUBLIC,
      fetch: fetchImpl,
      headers: { authorization: "Bearer secret" },
    });
    const secondHopHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(secondHopHeaders.get("authorization")).toBe("Bearer secret");
  });

  it("throws after exceeding maxRedirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
    );
    await expect(
      safeFetch("https://example.com/loop", { lookup: PUBLIC, fetch: fetchImpl, maxRedirects: 2 }),
    ).rejects.toThrow(/redirects/);
  });

  it("times out", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(
      safeFetch("https://example.com/", { lookup: PUBLIC, fetch: fetchImpl, timeoutMs: 10 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("readBodyTextSafe", () => {
  it("reads a small body", async () => {
    expect(await readBodyTextSafe(new Response("hello"))).toBe("hello");
  });

  it("throws when the body exceeds maxBytes", async () => {
    await expect(readBodyTextSafe(new Response("x".repeat(100)), { maxBytes: 10 })).rejects.toThrow(
      /exceeded/,
    );
  });
});
