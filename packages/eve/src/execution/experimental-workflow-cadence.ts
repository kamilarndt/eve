import type { ExperimentalWorkflowCadence } from "#shared/experimental-workflow-definition.js";

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_SAMPLE_WINDOW_MILLISECONDS = 36 * 60 * 60 * 1_000;
const OFFSET_SAMPLE_STEP_MILLISECONDS = 6 * 60 * 60 * 1_000;
// One hundred 365.25-day years: operationally ample and Date-safe around contemporary instants.
export const MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS = 3_155_760_000;

interface CalendarDate {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

interface LocalDateTime extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

interface DailyTime {
  readonly hour: number;
  readonly minute: number;
}

interface NextExperimentalWorkflowDueAtInput {
  readonly cadence: unknown;
  readonly completedAt: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidField(field: string, expectation: string): TypeError {
  return new TypeError(`Experimental workflow ${field} ${expectation}.`);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidField(field, "must be a finite number");
  }

  return value;
}

function requirePositiveSafeSeconds(value: unknown, field: string): number {
  const seconds = requireFiniteNumber(value, field);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS
  ) {
    throw invalidField(
      field,
      `must be a positive safe integer no greater than ${String(MAX_EXPERIMENTAL_WORKFLOW_DURATION_SECONDS)}`,
    );
  }
  return seconds;
}

/** Parse one persisted ISO instant, naming the boundary field in validation errors. */
export function parseExperimentalWorkflowIsoInstant(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw invalidField(field, "must be an ISO 8601 instant");
  }

  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw invalidField(field, "must be an ISO 8601 instant with a UTC offset");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw invalidField(field, "must be a valid ISO 8601 instant");
  }

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, millisecond);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    throw invalidField(field, "must be a valid ISO 8601 instant");
  }

  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMilliseconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60 * 1_000;
  const instant = localDate.getTime() - offsetMilliseconds;
  if (!Number.isFinite(instant)) {
    throw invalidField(field, "must be a representable ISO 8601 instant");
  }

  return instant;
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidField("cadence.timeZone", "must be a valid IANA time zone");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidField("cadence.timeZone", "must be a valid IANA time zone");
    }
    throw error;
  }

  return value;
}

function parseDailyTimes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidField("cadence.times", "must be a non-empty array of HH:mm values");
  }

  for (const [index, time] of value.entries()) {
    if (typeof time !== "string" || !DAILY_TIME_PATTERN.test(time)) {
      throw invalidField(`cadence.times[${index}]`, "must use 24-hour HH:mm format");
    }
  }

  return value;
}

/** Parse and validate cadence data loaded from an app-owned workflow record. */
export function parseExperimentalWorkflowCadence(value: unknown): ExperimentalWorkflowCadence {
  if (!isRecord(value)) {
    throw invalidField("cadence", "must be an object");
  }

  switch (value.kind) {
    case "after-completion": {
      rejectUnknownCadenceKeys(value, ["delaySeconds", "kind"]);
      const delaySeconds = requirePositiveSafeSeconds(value.delaySeconds, "cadence.delaySeconds");
      return { kind: value.kind, delaySeconds };
    }
    case "fixed-rate": {
      rejectUnknownCadenceKeys(value, ["anchorAt", "intervalSeconds", "kind", "missed"]);
      if (value.missed !== "skip") {
        throw invalidField("cadence.missed", 'must be "skip"');
      }
      if (typeof value.anchorAt !== "string") {
        throw invalidField("cadence.anchorAt", "must be an ISO 8601 instant");
      }
      parseExperimentalWorkflowIsoInstant(value.anchorAt, "cadence.anchorAt");
      const intervalSeconds = requirePositiveSafeSeconds(
        value.intervalSeconds,
        "cadence.intervalSeconds",
      );
      return {
        kind: value.kind,
        anchorAt: value.anchorAt,
        intervalSeconds,
        missed: value.missed,
      };
    }
    case "daily-times": {
      rejectUnknownCadenceKeys(value, ["kind", "missed", "times", "timeZone"]);
      if (value.missed !== "skip") {
        throw invalidField("cadence.missed", 'must be "skip"');
      }
      return {
        kind: value.kind,
        timeZone: validateTimeZone(value.timeZone),
        times: parseDailyTimes(value.times),
        missed: value.missed,
      };
    }
    default:
      throw invalidField(
        "cadence.kind",
        'must be "after-completion", "fixed-rate", or "daily-times"',
      );
  }
}

function rejectUnknownCadenceKeys(
  cadence: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
): void {
  const known = new Set(knownKeys);
  for (const key of Object.keys(cadence)) {
    if (!known.has(key)) {
      throw new TypeError(`Experimental workflow cadence has unknown key "${key}".`);
    }
  }
}

function toIsoString(instant: number, field: string): string {
  if (!Number.isFinite(instant)) {
    throw invalidField(field, "must produce a representable instant");
  }

  try {
    return new Date(instant).toISOString();
  } catch (error) {
    if (error instanceof RangeError) {
      throw invalidField(field, "must produce a representable instant");
    }
    throw error;
  }
}

function createZonedDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function getPart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  const part = parts.find((candidate) => candidate.type === type);
  if (part === undefined) {
    throw new Error(`Intl.DateTimeFormat did not return a ${type} part.`);
  }
  return Number(part.value);
}

function getLocalDateTime(formatter: Intl.DateTimeFormat, instant: number): LocalDateTime {
  const parts = formatter.formatToParts(new Date(instant));
  return {
    year: getPart(parts, "year"),
    month: getPart(parts, "month"),
    day: getPart(parts, "day"),
    hour: getPart(parts, "hour"),
    minute: getPart(parts, "minute"),
    second: getPart(parts, "second"),
  };
}

function toUtcCalendarMilliseconds(value: LocalDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, 0);
  return date.getTime();
}

function getTimeZoneOffset(formatter: Intl.DateTimeFormat, instant: number): number {
  return toUtcCalendarMilliseconds(getLocalDateTime(formatter, instant)) - instant;
}

function isSameWallTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function getWallTimeInstants(
  formatter: Intl.DateTimeFormat,
  wallTime: LocalDateTime,
): readonly number[] {
  const wallTimeAsUtc = toUtcCalendarMilliseconds(wallTime);
  const offsets = new Set<number>();
  for (
    let sample = wallTimeAsUtc - OFFSET_SAMPLE_WINDOW_MILLISECONDS;
    sample <= wallTimeAsUtc + OFFSET_SAMPLE_WINDOW_MILLISECONDS;
    sample += OFFSET_SAMPLE_STEP_MILLISECONDS
  ) {
    offsets.add(getTimeZoneOffset(formatter, sample));
  }

  const instants = new Set<number>();
  for (const offset of offsets) {
    const instant = wallTimeAsUtc - offset;
    if (isSameWallTime(getLocalDateTime(formatter, instant), wallTime)) {
      instants.add(instant);
    }
  }

  return [...instants].sort((left, right) => left - right);
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const next = new Date(0);
  next.setUTCFullYear(date.year, date.month - 1, date.day + days);
  next.setUTCHours(0, 0, 0, 0);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function parseDailyTime(value: string): DailyTime {
  const match = DAILY_TIME_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Validated daily time ${value} is invalid.`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function getNextDailyDueAt(
  cadence: Extract<ExperimentalWorkflowCadence, { kind: "daily-times" }>,
  completedAt: number,
): number {
  const formatter = createZonedDateTimeFormatter(cadence.timeZone);
  const completedLocal = getLocalDateTime(formatter, completedAt);
  const firstDate: CalendarDate = {
    year: completedLocal.year,
    month: completedLocal.month,
    day: completedLocal.day,
  };
  const times = cadence.times
    .map(parseDailyTime)
    .sort((left, right) => left.hour - right.hour || left.minute - right.minute);

  // Some time-zone transitions make a wall time, or even a local date,
  // nonexistent. Bound the search while leaving several later dates to skip.
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const date = addCalendarDays(firstDate, dayOffset);
    for (const time of times) {
      const [instant] = getWallTimeInstants(formatter, {
        ...date,
        ...time,
        second: 0,
      });
      if (instant !== undefined && instant > completedAt) {
        return instant;
      }
    }
  }

  throw new RangeError(
    `Experimental workflow cadence did not produce a daily occurrence within seven days.`,
  );
}

/** Compute the next non-replayed occurrence after an iteration terminates. */
export function getNextExperimentalWorkflowDueAt({
  cadence: cadenceInput,
  completedAt: completedAtInput,
}: NextExperimentalWorkflowDueAtInput): string {
  const cadence = parseExperimentalWorkflowCadence(cadenceInput);
  const completedAt = parseExperimentalWorkflowIsoInstant(completedAtInput, "completedAt");

  switch (cadence.kind) {
    case "after-completion":
      return toIsoString(completedAt + cadence.delaySeconds * 1_000, "cadence.delaySeconds");
    case "fixed-rate": {
      const anchorAt = parseExperimentalWorkflowIsoInstant(cadence.anchorAt, "cadence.anchorAt");
      const interval = cadence.intervalSeconds * 1_000;
      const elapsed = completedAt - anchorAt;
      const elapsedSlots = elapsed < 0 ? 0 : Math.floor(elapsed / interval) + 1;
      return toIsoString(anchorAt + elapsedSlots * interval, "cadence.intervalSeconds");
    }
    case "daily-times":
      return toIsoString(getNextDailyDueAt(cadence, completedAt), "cadence.times");
    default: {
      const exhaustive: never = cadence;
      return exhaustive;
    }
  }
}
