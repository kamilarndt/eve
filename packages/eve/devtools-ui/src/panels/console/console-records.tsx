import { EmptyState } from "@ui/components/empty-state";
import type { ConsoleRecord as ConsoleRecordModel } from "@ui/model/devtools-model";
import { ConsoleRecord } from "@ui/panels/console/console-record";

interface ConsoleRecordsProps {
  readonly compact?: boolean;
  readonly records: readonly ConsoleRecordModel[];
}

export function ConsoleRecords({ compact = false, records }: ConsoleRecordsProps) {
  if (records.length === 0) {
    return (
      <EmptyState description="No output matches the current filters." title="No Console Records" />
    );
  }
  return (
    <div
      aria-label="Console records"
      className="console-records"
      data-compact={compact || undefined}
      role="table"
    >
      {!compact && (
        <div className="console-header" role="row">
          <span role="columnheader">Level</span>
          <span role="columnheader">Time</span>
          <span role="columnheader">Message</span>
          <span role="columnheader">Stream</span>
          <span role="columnheader">Session</span>
          <span role="columnheader">Source</span>
        </div>
      )}
      {records.map((record) => (
        <ConsoleRecord key={record.id} record={record} />
      ))}
    </div>
  );
}
