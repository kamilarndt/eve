/**
 * Builds a fetchable URL from a caller-provided host and an eve route path.
 *
 * `host` may be an absolute origin (`https://agent.example.com`) or a
 * same-origin prefix (`/api`). Prefixes are important for browser clients that
 * talk to an app-owned proxy instead of the eve deployment directly.
 */
export function createClientUrl(
  host: string,
  routePath: string,
  searchParams?: Readonly<Record<string, string>>,
): string {
  const route = splitRoutePath(routePath);
  const normalizedRoute = route.pathname.startsWith("/") ? route.pathname : `/${route.pathname}`;
  const search = formatSearch(route.search, searchParams);

  if (isAbsoluteUrl(host)) {
    const url = new URL(host);
    const basePath = trimTrailingSlash(url.pathname);
    url.pathname = `${basePath}${normalizedRoute}`;
    url.search = search;
    url.hash = "";
    return url.toString();
  }

  return `${trimTrailingSlash(host)}${normalizedRoute}${search}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}

function trimTrailingSlash(value: string): string {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function splitRoutePath(routePath: string): { readonly pathname: string; readonly search: string } {
  const hashIndex = routePath.indexOf("#");
  const withoutHash = hashIndex === -1 ? routePath : routePath.slice(0, hashIndex);
  const searchIndex = withoutHash.indexOf("?");
  if (searchIndex === -1) {
    return { pathname: withoutHash, search: "" };
  }
  return {
    pathname: withoutHash.slice(0, searchIndex),
    search: withoutHash.slice(searchIndex),
  };
}

function formatSearch(
  routeSearch: string,
  searchParams: Readonly<Record<string, string>> | undefined,
): string {
  const params = new URLSearchParams(routeSearch);

  if (searchParams !== undefined) {
    for (const [key, value] of Object.entries(searchParams)) {
      params.set(key, value);
    }
  }

  const formatted = params.toString();
  return formatted.length > 0 ? `?${formatted}` : "";
}
