/**
 * Returns the first non-empty line of a framework-selected action argument.
 * Framework tool definitions opt into this projection explicitly so authored
 * tools with the same name never inherit a display policy by accident.
 */
export function formatTextDisplayArgument(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Returns a command only when it does not contain a common credential marker
 * or URL userinfo. Suspicious commands fall back to the bare action name.
 */
export function formatCommandDisplayArgument(value: unknown): string | undefined {
  const command = formatTextDisplayArgument(value);
  if (command === undefined) return undefined;
  if (
    /\b(?:authorization|api[_-]?key|access[_-]?key|token|secret|password|passwd|cookie|credential)\b\s*(?::|=|\s)/iu.test(
      command,
    ) ||
    /\bhttps?:\/\/[^/\s]*@/iu.test(command)
  ) {
    return undefined;
  }
  return command;
}

/** Keeps the final two path segments, which carry more signal than a workspace prefix. */
export function formatPathDisplayArgument(value: unknown): string | undefined {
  const path = formatTextDisplayArgument(value);
  if (path === undefined) return undefined;
  const segments = path.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.slice(-2).join("/") || undefined;
}

/** Returns only the URL host, excluding credentials, query parameters, and fragments. */
export function formatUrlDisplayArgument(value: unknown): string | undefined {
  const rawUrl = formatTextDisplayArgument(value);
  if (rawUrl === undefined) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.host || undefined
      : undefined;
  } catch {
    return undefined;
  }
}
