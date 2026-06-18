import { randomUUID } from "node:crypto";

import {
  DEVTOOLS_OBSERVATION_VERSION,
  type DevToolsObservationRecord,
} from "#internal/devtools/protocol.js";

const DEFAULT_OBSERVATION_CAPACITY = 1_000;
const DEFAULT_MAX_ENCODED_RECORD_BYTES = 1024 * 1024;

export interface DevObservationSink {
  emit<TData>(type: string, createData: () => TData): boolean;
}

export function createDevObservationSink(input: {
  readonly capacity?: number;
  readonly enabled: boolean;
  readonly maxEncodedRecordBytes?: number;
  readonly runtimeInstanceId: string;
  readonly warn?: (message: string) => void;
  readonly writeLine: (line: string) => void | Promise<void>;
}): DevObservationSink {
  const capacity = input.capacity ?? DEFAULT_OBSERVATION_CAPACITY;
  const maxEncodedRecordBytes = input.maxEncodedRecordBytes ?? DEFAULT_MAX_ENCODED_RECORD_BYTES;
  const queue: string[] = [];
  let dropped = 0;
  let flushing = false;
  let sequence = 0;
  let warned = false;

  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    input.warn?.(message);
  };

  const enqueueLine = (line: string): boolean => {
    if (Buffer.byteLength(line, "utf8") > maxEncodedRecordBytes) {
      dropped += 1;
      return false;
    }

    if (queue.length >= capacity) {
      dropped += 1;
      return false;
    }

    queue.push(line);
    scheduleFlush();
    return true;
  };

  const createRecordLine = (type: string, data: unknown): string =>
    JSON.stringify({
      at: new Date().toISOString(),
      data,
      recordId: randomUUID(),
      runtimeInstanceId: input.runtimeInstanceId,
      schemaVersion: DEVTOOLS_OBSERVATION_VERSION,
      sequence: sequence++,
      type,
    } satisfies DevToolsObservationRecord);

  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;

    try {
      while (queue.length > 0 || dropped > 0) {
        if (queue.length === 0 && dropped > 0) {
          const droppedCount = dropped;
          dropped = 0;
          queue.push(createRecordLine("observation.dropped", { dropped: droppedCount }));
        }

        const line = queue.shift();
        if (line === undefined) {
          continue;
        }

        try {
          await input.writeLine(line);
        } catch (error) {
          warnOnce(
            `DevTools observation transport failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      flushing = false;
      if (queue.length > 0 || dropped > 0) {
        scheduleFlush();
      }
    }
  };

  const scheduleFlush = () => {
    if (flushing) return;
    queueMicrotask(() => {
      void flush();
    });
  };

  return {
    emit(type, createData) {
      if (!input.enabled) {
        return false;
      }

      let data: unknown;
      try {
        data = createData();
      } catch (error) {
        warnOnce(
          `DevTools observation record construction failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }

      return enqueueLine(createRecordLine(type, data));
    },
  };
}
