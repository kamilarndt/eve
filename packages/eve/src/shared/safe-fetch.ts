import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  isLoopbackHostname,
  isReservedIpAddress,
  normalizeAddress,
} from "#shared/network-address.js";

/**
 * SSRF-safe outbound `fetch` for URLs whose host comes from author, tenant, or
 * model input. Every hop: pins `https` (plain `http` only via `allowHttp` or on
 * loopback), DNS-resolves the host and rejects any private/link-local/reserved
 * address, re-validates redirects (dropping credentials cross-origin), and
 * bounds time + body size.
 *
 * It resolves-then-connects rather than pinning the IP at connect time, so a
 * sub-second DNS rebind can still slip through; closing that needs a custom
 * undici dispatcher (a runtime dep eve avoids). The preflight still blocks the
 * common cases (configured private host, host resolving private, redirect to
 * metadata).
 */

type FetchImpl = typeof globalThis.fetch;
type FetchInit = NonNullable<Parameters<FetchImpl>[1]>;

/** Resolver seam matching `node:dns/promises` `lookup(host, { all: true })`. */
type LookupImpl = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

const dnsPromisesLookup: LookupImpl = (hostname, options) => dnsLookup(hostname, options);

// Default resolver, swappable so hermetic unit tests can avoid real DNS without
// threading a `lookup` option through every call site.
let activeLookup: LookupImpl = dnsPromisesLookup;

/**
 * Test-only: override the default DNS resolver (or pass `undefined` to restore
 * `node:dns`). Production code should never call this.
 */
export function setSafeFetchLookupOverride(lookup: LookupImpl | undefined): void {
  activeLookup = lookup ?? dnsPromisesLookup;
}

/** Options shared by {@link assertUrlSafeToFetch} and {@link safeFetch}. */
export interface AssertUrlSafeOptions {
  /**
   * Allow requests to loopback hosts (`localhost`, `127.0.0.0/8`, `::1`).
   * Loopback is same-host rather than a network pivot and local development
   * depends on it, so it is allowed by default. Set `false` to harden a
   * production surface.
   *
   * @default true
   */
  readonly allowLoopback?: boolean;

  /**
   * Allow plain `http:` to non-loopback hosts. Off by default so credentialed
   * requests never run over cleartext; the `web_fetch` tool enables it because
   * arbitrary web pages are still commonly `http:`.
   *
   * @default false
   */
  readonly allowHttp?: boolean;

  /**
   * Optional hostname allowlist. When set, the host must equal an entry
   * (case-insensitive) or be a subdomain of one. The SSRF resolution check
   * still runs on top of the allowlist.
   */
  readonly allowedHosts?: readonly string[];

  /** Prefix for error messages (e.g. an OpenAPI connection name). */
  readonly label?: string;

  /** Injectable resolver for tests. Defaults to `node:dns/promises` `lookup`. */
  readonly lookup?: LookupImpl;
}

/** Options for {@link safeFetch}. */
export interface SafeFetchOptions extends AssertUrlSafeOptions {
  readonly method?: string;
  readonly headers?: FetchInit["headers"];
  readonly body?: FetchInit["body"];
  /** External abort signal; combined with the internal timeout. */
  readonly signal?: AbortSignal;
  /**
   * Timeout in milliseconds across the whole redirect chain.
   *
   * @default 30_000
   */
  readonly timeoutMs?: number;
  /**
   * Maximum redirect hops to follow.
   *
   * @default 5
   */
  readonly maxRedirects?: number;
  /** Injectable `fetch` for tests. Defaults to the global `fetch`. */
  readonly fetch?: FetchImpl;
}

/** Options for the body readers. */
export interface ReadBodyOptions {
  /**
   * Maximum bytes to read before aborting with an error.
   *
   * @default 10 MB
   */
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function withLabel(label: string | undefined, message: string): string {
  return label === undefined ? message : `${label}: ${message}`;
}

// isReservedIpAddress allows loopback by design, so reject it separately when
// the caller disallows loopback.
function isAddressAllowed(address: string, allowLoopback: boolean): boolean {
  if (isReservedIpAddress(address)) {
    return false;
  }
  return allowLoopback || !isLoopbackHostname(address);
}

function assertProtocol(
  url: URL,
  allowHttp: boolean,
  allowLoopback: boolean,
  label?: string,
): void {
  if (url.protocol === "https:") {
    return;
  }
  if (
    url.protocol === "http:" &&
    (allowHttp || (allowLoopback && isLoopbackHostname(url.hostname)))
  ) {
    return;
  }
  throw new Error(
    withLabel(
      label,
      `refusing to fetch "${url.protocol}//${url.host}" — only ${allowHttp ? "http(s)" : "https"} is allowed${allowHttp ? "" : " (plain http only for loopback)"}.`,
    ),
  );
}

function isHostInAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const normalized = entry.toLowerCase();
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
  });
}

/**
 * Validates a URL for SSRF safety without issuing a request: parses it, pins
 * the protocol, applies any host allowlist, and rejects hosts that are — or
 * that DNS-resolve to — a private, loopback (when disallowed), link-local, or
 * otherwise reserved address. Returns the parsed URL. Throws otherwise.
 *
 * Use this to preflight a URL handed to a third-party client that owns its own
 * socket (e.g. an MCP SDK or a JWKS fetcher), where {@link safeFetch} cannot
 * wrap the request itself.
 */
export async function assertUrlSafeToFetch(
  rawUrl: string | URL,
  options: AssertUrlSafeOptions = {},
): Promise<URL> {
  const {
    allowLoopback = true,
    allowHttp = false,
    allowedHosts,
    label,
    lookup = activeLookup,
  } = options;

  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new Error(withLabel(label, `invalid URL "${String(rawUrl)}".`));
  }

  assertProtocol(url, allowHttp, allowLoopback, label);

  // Strip IPv6 brackets/zone so isIP classifies it and the resolver gets a bare host.
  const host = normalizeAddress(url.hostname);

  if (allowedHosts !== undefined && !isHostInAllowlist(host, allowedHosts)) {
    throw new Error(withLabel(label, `host "${host}" is not in the allowlist.`));
  }

  const reject = (): never => {
    throw new Error(
      withLabel(
        label,
        `refusing to connect to "${host}" — private, loopback, or reserved address.`,
      ),
    );
  };

  if (isIP(host) !== 0) {
    if (!isAddressAllowed(host, allowLoopback)) {
      reject();
    }
    return url;
  }

  if (isLoopbackHostname(host)) {
    if (!allowLoopback) {
      reject();
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(withLabel(label, `could not resolve host "${host}".`));
  }
  if (addresses.length === 0) {
    throw new Error(withLabel(label, `could not resolve host "${host}".`));
  }
  for (const { address } of addresses) {
    if (!isAddressAllowed(address, allowLoopback)) {
      reject();
    }
  }

  return url;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function drainBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Releasing the socket is best-effort.
  }
}

const CONTENT_HEADERS = new Set([
  "content-length",
  "content-type",
  "content-encoding",
  "content-language",
  "content-location",
]);

/**
 * SSRF-safe `fetch`. Validates the URL (see {@link assertUrlSafeToFetch}),
 * follows redirects manually so every hop is re-validated, drops
 * `authorization`/`cookie` on cross-origin redirects, and bounds the whole
 * chain with a timeout. Returns the final `Response`; read its body with
 * {@link readBodyTextSafe} to enforce a size cap.
 */
export async function safeFetch(
  rawUrl: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const {
    method,
    headers,
    body,
    signal: externalSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    fetch: fetchImpl = globalThis.fetch,
    ...assertOptions
  } = options;

  let currentUrl = await assertUrlSafeToFetch(rawUrl, assertOptions);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(withLabel(assertOptions.label, `request timed out after ${timeoutMs}ms.`)),
    );
  }, timeoutMs);
  // Don't let a pending timeout keep the process alive on the rare path where
  // the returned body is never read (cleanup is otherwise tied to the body).
  timer.unref?.();

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  };

  let currentMethod = method ?? "GET";
  let currentBody = body;
  const currentHeaders = new Headers(headers);

  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(currentUrl.toString(), {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody ?? undefined,
        redirect: "manual",
        signal: controller.signal,
      });

      if (!isRedirectStatus(response.status)) {
        // The timeout and abort signal must keep bounding and cancelling the
        // caller's body read, so hand cleanup off to the response body's
        // lifetime rather than firing it now that headers have arrived.
        return bindResponseCleanup(response, cleanup);
      }
      if (hop >= maxRedirects) {
        await drainBody(response);
        throw new Error(withLabel(assertOptions.label, `exceeded ${maxRedirects} redirects.`));
      }

      const location = response.headers.get("location");
      if (location === null) {
        await drainBody(response);
        throw new Error(
          withLabel(assertOptions.label, "redirect response is missing a Location header."),
        );
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        await drainBody(response);
        throw new Error(
          withLabel(assertOptions.label, `redirect Location "${location}" is not a valid URL.`),
        );
      }

      await drainBody(response);
      await assertUrlSafeToFetch(nextUrl, assertOptions);

      // RFC 7231 §6.4: 301/302/303 downgrade to GET and drop the body.
      if (
        (response.status === 301 || response.status === 302 || response.status === 303) &&
        currentMethod.toUpperCase() !== "HEAD"
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        for (const name of CONTENT_HEADERS) {
          currentHeaders.delete(name);
        }
      }

      if (nextUrl.origin !== currentUrl.origin) {
        currentHeaders.delete("authorization");
        currentHeaders.delete("cookie");
      }

      currentUrl = nextUrl;
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Returns `response` with cleanup deferred until its body settles: reading to
 * completion, erroring, or cancelling runs {@link cleanup}. This keeps the
 * request timeout and abort signal live across the caller's body read (a plain
 * `Response` hands the body off without them otherwise). Bodyless responses
 * clean up immediately.
 */
function bindResponseCleanup(response: Response, cleanup: () => void): Response {
  if (response.body === null) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Reads a `Response` body as UTF-8 text, aborting the connection and throwing
 * once `maxBytes` is exceeded so an oversized body cannot exhaust memory.
 */
export async function readBodyTextSafe(
  response: Response,
  options: ReadBodyOptions = {},
): Promise<string> {
  const { maxBytes = DEFAULT_MAX_BYTES } = options;
  const body = response.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response body exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be cancelled.
    }
  }

  return text;
}
