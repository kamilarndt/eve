import { InvalidArgumentError } from "#compiled/commander/index.js";

export function collectHeaderOption(
  value: string,
  previous: readonly string[] = [],
): readonly string[] {
  return [...previous, value];
}

export function parseHeaderOptions(
  values: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (values === undefined) return undefined;

  let headers: Readonly<Record<string, string>> = {};
  for (const value of values) {
    headers = parseHeaderOption(value, headers);
  }
  return headers;
}

function parseHeaderOption(
  value: string,
  previous: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const separator = value.indexOf(":");
  if (separator < 1) {
    throw new InvalidArgumentError('Expected --header to use "Name: value" format.');
  }

  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (name.length === 0) {
    throw new InvalidArgumentError("Expected --header to include a header name.");
  }

  try {
    const headers = new Headers(previous);
    headers.set(name, headerValue);
    return Object.fromEntries(headers.entries());
  } catch {
    throw new InvalidArgumentError(`Invalid --header name "${name}".`);
  }
}
