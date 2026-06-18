import { useMemo, useState } from "react";

import type { ConsoleRecord } from "@ui/model/devtools-model";
import {
  filterConsoleRecords,
  type ConsoleLevel,
  type ConsoleScope,
  type ConsoleView,
} from "@ui/panels/console/console-view";

export function useConsoleView(input: {
  readonly records: readonly ConsoleRecord[];
  readonly selectedActionId?: string;
  readonly selectedSessionId?: string;
  readonly selectedSessionTitle?: string;
}): ConsoleView {
  const [level, setLevel] = useState<ConsoleLevel>("all");
  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ConsoleScope>("runtime");
  const activeScope =
    (scope === "session" && input.selectedSessionId === undefined) ||
    (scope === "action" && input.selectedActionId === undefined)
      ? "runtime"
      : scope;
  const records = useMemo(
    () =>
      filterConsoleRecords({
        actionId: input.selectedActionId,
        clearedIds,
        level,
        query,
        records: input.records,
        scope: activeScope,
        sessionId: input.selectedSessionId,
      }),
    [
      activeScope,
      clearedIds,
      input.records,
      input.selectedActionId,
      input.selectedSessionId,
      level,
      query,
    ],
  );

  return {
    clearRecords() {
      setClearedIds((current) => {
        const next = new Set(current);
        for (const record of input.records) next.add(record.id);
        return next;
      });
    },
    level,
    query,
    records,
    scope: activeScope,
    selectedActionId: input.selectedActionId,
    selectedSessionId: input.selectedSessionId,
    selectedSessionTitle: input.selectedSessionTitle,
    setLevel,
    setQuery,
    setScope,
  };
}
