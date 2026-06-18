const CONSOLE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  warn: "warning",
};

export interface DevToolsConsoleCoordinates {
  readonly session: string;
  readonly turn: string;
}

export interface DevToolsConsoleContext {
  readonly coordinates?: DevToolsConsoleCoordinates;
  readonly fingerprint: string;
  readonly type: string;
}

export function normalizeConsoleType(type: string): string {
  return CONSOLE_TYPE_ALIASES[type] ?? type;
}

export function fingerprintConsoleArguments(args: readonly unknown[]): string {
  return JSON.stringify(args.map(fingerprintValue));
}

export function fingerprintRemoteConsoleArguments(args: readonly unknown[]): string {
  return JSON.stringify(args.map(fingerprintRemoteValue));
}

export function isDevToolsConsoleContext(value: unknown): value is DevToolsConsoleContext {
  if (!isRecord(value)) return false;
  const coordinates = value.coordinates;
  return (
    typeof value.type === "string" &&
    typeof value.fingerprint === "string" &&
    (coordinates === undefined ||
      (isRecord(coordinates) &&
        typeof coordinates.session === "string" &&
        typeof coordinates.turn === "string"))
  );
}

function fingerprintValue(value: unknown): readonly [string, string] {
  if (value === null) return ["object", "null"];
  switch (typeof value) {
    case "bigint":
      return ["bigint", String(value)];
    case "function":
      return ["function", "Function"];
    case "object":
      return ["object", objectClassName(value)];
    case "symbol":
      return ["symbol", String(value)];
    case "undefined":
      return ["undefined", "undefined"];
    default:
      return [typeof value, String(value)];
  }
}

function fingerprintRemoteValue(value: unknown): readonly [string, string] {
  if (!isRecord(value)) return fingerprintValue(value);
  if ("value" in value) return fingerprintValue(value.value);
  const type = typeof value.type === "string" ? value.type : "unknown";
  if (type === "bigint" && typeof value.unserializableValue === "string") {
    return ["bigint", value.unserializableValue.replace(/n$/u, "")];
  }
  if (type === "symbol") {
    return ["symbol", typeof value.description === "string" ? value.description : "Symbol()"];
  }
  if (type === "function") return ["function", "Function"];
  if (type === "undefined") return ["undefined", "undefined"];
  return [
    type,
    typeof value.className === "string"
      ? value.className
      : typeof value.subtype === "string"
        ? value.subtype
        : type,
  ];
}

function objectClassName(value: object): string {
  if (Array.isArray(value)) return "Array";
  const constructor = Reflect.get(value, "constructor");
  return isRecord(constructor) || typeof constructor === "function"
    ? typeof constructor.name === "string"
      ? constructor.name
      : "Object"
    : "Object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
