import type { ConsoleRecord, RunSession } from "@ui/model/devtools-model";

export type ConsoleLevel = "all" | ConsoleRecord["level"];
export type ConsoleScope = "action" | "runtime" | "session";

export interface ConsoleView {
  readonly level: ConsoleLevel;
  readonly query: string;
  readonly records: readonly ConsoleRecord[];
  readonly scope: ConsoleScope;
  readonly selectedActionId?: string;
  readonly selectedSessionId?: string;
  readonly selectedSessionTitle?: string;
  clearRecords(): void;
  setLevel(level: ConsoleLevel): void;
  setQuery(query: string): void;
  setScope(scope: ConsoleScope): void;
}

export function resolveConsoleSessionTitle(
  runs: readonly Pick<RunSession, "id" | "label">[],
  sessionId: string,
): string {
  return runs.find((run) => run.id === sessionId)?.label ?? "Session";
}

export function filterConsoleRecords(input: {
  readonly actionId?: string;
  readonly clearedIds?: ReadonlySet<string>;
  readonly level: ConsoleLevel;
  readonly query: string;
  readonly records: readonly ConsoleRecord[];
  readonly scope: ConsoleScope;
  readonly sessionId?: string;
}): readonly ConsoleRecord[] {
  const query = input.query.toLocaleLowerCase().trim();
  return input.records.filter((record) => {
    if (input.clearedIds?.has(record.id) === true) return false;
    if (input.level !== "all" && record.level !== input.level) return false;
    if (input.scope === "session" && record.coordinates?.session !== input.sessionId) return false;
    if (input.scope === "action" && record.coordinates?.action !== input.actionId) return false;
    if (query.length === 0) return true;
    return [
      record.message,
      record.stream,
      record.coordinates?.session,
      record.coordinates?.action,
      record.source?.path,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}
