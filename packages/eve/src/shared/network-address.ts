import { BlockList, isIP } from "node:net";

import { z } from "#compiled/zod/index.js";

/** HTTP(S) URL accepted as a development-server endpoint. */
export const httpServerUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * Private, link-local, and otherwise reserved IP ranges that a framework-issued
 * outbound request to a caller-supplied URL must not target. This is the SSRF
 * blocklist for {@link isReservedIpAddress}.
 *
 * Loopback (`127.0.0.0/8`, `::1`) is intentionally NOT included: it is same-host
 * rather than a network pivot, and local-dev self-callbacks use it. The
 * high-value SSRF target — cloud metadata at `169.254.169.254` — is link-local
 * and IS blocked here.
 */
const reservedRanges = new BlockList();
reservedRanges.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / unspecified
reservedRanges.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("100.64.0.0", 10, "ipv4"); // RFC6598 carrier-grade NAT
reservedRanges.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. cloud metadata
reservedRanges.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("198.18.0.0", 15, "ipv4"); // RFC2544 benchmarking
reservedRanges.addAddress("::", "ipv6"); // unspecified
reservedRanges.addSubnet("fc00::", 7, "ipv6"); // unique-local
reservedRanges.addSubnet("fe80::", 10, "ipv6"); // link-local

/**
 * Expands an IPv6 literal to its 16 bytes, or `undefined` if it is not a valid
 * IPv6 address. Handles `::` compression and a trailing dotted-IPv4 tail
 * (`::ffff:1.2.3.4`).
 */
function ipv6ToBytes(address: string): number[] | undefined {
  if (isIP(address) !== 6) {
    return undefined;
  }
  let text = address.toLowerCase();

  // Rewrite a trailing dotted IPv4 (e.g. `::ffff:1.2.3.4`) as its two hex
  // groups so the rest can be parsed as a pure-hex IPv6.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(text);
  if (dotted !== null) {
    const o = (dotted[1] as string).split(".").map(Number);
    const hi = ((o[0]! << 8) | o[1]!).toString(16);
    const lo = ((o[2]! << 8) | o[3]!).toString(16);
    text = `${text.slice(0, text.length - (dotted[1] as string).length)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length > 1 ? parse(halves[1] ?? "") : [];
  const groups =
    halves.length > 1
      ? [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return undefined;
  }
  return groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
}

/**
 * Extracts the embedded IPv4 from an IPv6 byte array for every well-known form
 * that tunnels an IPv4 address (mapped `::ffff:0:0/96`, SIIT-translated,
 * IPv4-compatible `::/96`, 6to4 `2002::/16`, NAT64 `64:ff9b::/96`), or
 * `undefined` when none applies. Without this, a private/metadata IPv4 written
 * in one of these IPv6 forms sails past the IPv4 blocklist as an opaque IPv6.
 */
function embeddedIpv4(bytes: number[]): string | undefined {
  const low = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const zero = (start: number, end: number): boolean =>
    bytes.slice(start, end).every((b) => b === 0);

  // 6to4 (`2002:AABB:CCDD::/16`) tunnels A.B.C.D in bytes 2-5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
  }
  // NAT64 well-known prefix `64:ff9b::/96`.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zero(4, 12)
  ) {
    return low;
  }
  // IPv4-mapped `::ffff:a.b.c.d` (`ffff` at bytes 10-11).
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return low;
  }
  // SIIT-translated `::ffff:0:a.b.c.d` (`ffff` at bytes 8-9, bytes 10-11 zero).
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return low;
  }
  // IPv4-compatible `::/96` (deprecated). Skip `::` and `::1` — a leading
  // embedded octet of 0 is that reserved/loopback space, handled elsewhere.
  if (zero(0, 12) && bytes[12] !== 0) {
    return low;
  }
  return undefined;
}

/**
 * Reduces a URL host or address literal to a bare, classifiable address:
 * trims, strips IPv6 brackets and any zone index (`%eth0`), and unwraps any
 * IPv6 form that tunnels an IPv4 address (mapped, SIIT, IPv4-compatible, 6to4,
 * NAT64) down to that IPv4 so the IPv4 ranges apply. Plain hostnames pass
 * through unchanged. Shared with the SSRF fetch guard so URL hosts are
 * normalized identically here and before a DNS lookup.
 */
export function normalizeAddress(host: string): string {
  const withoutBrackets = host.trim().replace(/^\[(.*)\]$/u, "$1");
  const zoneIndex = withoutBrackets.indexOf("%");
  const withoutZone = zoneIndex === -1 ? withoutBrackets : withoutBrackets.slice(0, zoneIndex);

  const bytes = ipv6ToBytes(withoutZone);
  if (bytes !== undefined) {
    const v4 = embeddedIpv4(bytes);
    if (v4 !== undefined && isIP(v4) === 4) {
      return v4;
    }
  }

  return withoutZone;
}

/**
 * Returns whether `hostname` names the current machine's loopback interface.
 * Accepts the full IPv4 loopback block, IPv6 loopback, and the RFC 6761
 * `localhost` namespace. Wildcard bind addresses such as `0.0.0.0` are not
 * loopback connect targets.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeAddress(hostname).toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const family = isIP(normalized);
  if (family === 4) {
    return normalized.startsWith("127.");
  }

  return family === 6 && normalized === "::1";
}

/** Returns whether `urlText` is an HTTP(S) URL with a loopback hostname. */
export function isLoopbackServerUrl(urlText: string): boolean {
  const parsed = httpServerUrlSchema.safeParse(urlText);
  return parsed.success && isLoopbackHostname(new URL(parsed.data).hostname);
}

/**
 * Whether `host` is an IP literal in a private, link-local, or otherwise
 * reserved range that an outbound framework request must not target — an SSRF
 * guard for caller-supplied URLs (covers RFC1918, CGNAT, link-local incl. cloud
 * metadata at `169.254.169.254`, IPv6 ULA/link-local, and the unspecified
 * address). Loopback is intentionally allowed (see {@link reservedRanges}).
 *
 * Plain hostnames return `false`: no DNS resolution is performed here, so a
 * hostname that resolves to a private address is not caught at this layer.
 */
export function isReservedIpAddress(host: string): boolean {
  const normalized = normalizeAddress(host);
  const family = isIP(normalized);
  if (family === 0) {
    return false;
  }
  return reservedRanges.check(normalized, family === 4 ? "ipv4" : "ipv6");
}
