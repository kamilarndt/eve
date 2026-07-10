import type { HandleMessageStreamEvent } from "#protocol/message.js";

let WARNED_ABOUT_REPORT_FAILURE = false;

type EveObservabilityIssueEvent = {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly meta?: {
    readonly at?: string;
  };
};

function sanitizeIssueRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of ["code", "errorCode", "name", "type"]) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      sanitized[key] = field;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeActionResult(event: HandleMessageStreamEvent): EveObservabilityIssueEvent | null {
  if (event.type !== "action.result") {
    return null;
  }
  if (event.data.status !== "failed" && event.data.status !== "rejected") {
    return null;
  }

  const result = event.data.result as Record<string, unknown>;
  const sanitizedResult: Record<string, unknown> = {};
  for (const key of [
    "callId",
    "id",
    "kind",
    "name",
    "remoteAgentName",
    "subagentKind",
    "subagentName",
    "toolCallId",
    "toolName",
  ]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      sanitizedResult[key] = value;
    }
  }
  const output = sanitizeIssueRecord(result.output);
  if (output) {
    sanitizedResult.output = output;
  }

  const data: Record<string, unknown> = {
    result: sanitizedResult,
    sequence: event.data.sequence,
    status: event.data.status,
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
  };
  const error = sanitizeIssueRecord(event.data.error);
  if (error) {
    data.error = error;
  }

  return { type: event.type, data, meta: event.meta };
}

function sanitizeFailureEvent(event: HandleMessageStreamEvent): EveObservabilityIssueEvent | null {
  if (
    event.type !== "step.failed" &&
    event.type !== "turn.failed" &&
    event.type !== "session.failed"
  ) {
    return null;
  }

  const data: Record<string, unknown> = {};
  for (const key of ["code", "sequence", "sessionId", "stepIndex", "turnId"]) {
    const value = event.data[key as keyof typeof event.data];
    if (
      (typeof value === "string" && value.trim()) ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      data[key] = value;
    }
  }

  return { type: event.type, data, meta: event.meta };
}

function toIssueSourceEvent(event: HandleMessageStreamEvent): EveObservabilityIssueEvent | null {
  const actionResult = sanitizeActionResult(event);
  if (actionResult) {
    return actionResult;
  }

  const failure = sanitizeFailureEvent(event);
  if (failure) {
    return failure;
  }

  if (event.type === "subagent.event") {
    const child = toIssueSourceEvent(event.data.event);
    if (!child) {
      return null;
    }
    return {
      type: event.type,
      data: {
        callId: event.data.callId,
        subagentName: event.data.subagentName,
        event: child,
      },
      meta: event.meta,
    };
  }

  return null;
}

export async function reportEveObservabilityEvent(event: HandleMessageStreamEvent): Promise<void> {
  const issueEvent = toIssueSourceEvent(event);
  if (!issueEvent) {
    return;
  }

  try {
    const workflowCore = await import("#compiled/@workflow/core/index.js");
    const report = (
      workflowCore as {
        experimental_reportObservabilityEvent?: (
          event: EveObservabilityIssueEvent,
        ) => Promise<void> | void;
      }
    ).experimental_reportObservabilityEvent;
    await report?.(issueEvent);
  } catch (error) {
    if (!WARNED_ABOUT_REPORT_FAILURE) {
      WARNED_ABOUT_REPORT_FAILURE = true;
      console.warn(
        "[eve] reportEveObservabilityEvent failed; suppressing further warnings this process.",
        {
          type: event.type,
          error: (error as Error).message,
        },
      );
    }
  }
}
