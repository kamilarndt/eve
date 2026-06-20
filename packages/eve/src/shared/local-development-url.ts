const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "::1", "[::1]"]);
const LOOPBACK_IPV4_PREFIX = /^127\./;

/** Returns whether a URL hostname resolves to the local loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    LOCAL_HOSTNAMES.has(hostname) ||
    LOOPBACK_IPV4_PREFIX.test(hostname) ||
    hostname.endsWith(".localhost")
  );
}

/** Returns whether a server URL uses a recognized loopback hostname. */
export function isLocalDevelopmentServerUrl(serverUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
}

/** Compares development endpoints while treating loopback hostname aliases as equivalent. */
export function isSameDevelopmentServerEndpoint(left: string, right: string): boolean {
  const leftUrl = parseHttpUrl(left);
  const rightUrl = parseHttpUrl(right);
  if (leftUrl === undefined || rightUrl === undefined) return false;

  const hostMatches =
    leftUrl.hostname === rightUrl.hostname ||
    (isLoopbackHostname(leftUrl.hostname) && isLoopbackHostname(rightUrl.hostname));
  return (
    hostMatches &&
    leftUrl.protocol === rightUrl.protocol &&
    effectivePort(leftUrl) === effectivePort(rightUrl) &&
    leftUrl.pathname === rightUrl.pathname &&
    leftUrl.search === rightUrl.search
  );
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function effectivePort(url: URL): string {
  if (url.port.length > 0) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
