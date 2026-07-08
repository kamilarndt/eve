import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { EveAttributeValue } from "#runtime/attributes/normalize.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const HARNESS_OBSERVABILITY_ISSUES_STATE_KEY = "eve.harness.observabilityIssues";

export type EveObservabilityIssueType =
  | "action_failed"
  | "action_rejected"
  | "session_failed"
  | "step_failed"
  | "turn_failed";

export interface EveObservabilityIssueSummary {
  readonly errorCount: number;
  readonly failedActionCount: number;
  readonly failedStepCount: number;
  readonly failedTurnCount: number;
  readonly issueCount: number;
  readonly lastIssueAt?: string;
  readonly lastIssueCode?: string;
  readonly lastIssueTool?: string;
  readonly lastIssueType?: EveObservabilityIssueType;
  readonly rejectedActionCount: number;
}

export interface EveObservabilityIssueState extends EveObservabilityIssueSummary {
  readonly seenIssueInTurn: boolean;
  readonly session: EveObservabilityIssueSummary;
  readonly turnId: string;
}

const EMPTY_SUMMARY: EveObservabilityIssueSummary = {
  errorCount: 0,
  failedActionCount: 0,
  failedStepCount: 0,
  failedTurnCount: 0,
  issueCount: 0,
  rejectedActionCount: 0,
};

export function getObservabilityIssueState(
  state: SessionStateMap | undefined,
): EveObservabilityIssueState | undefined {
  return state?.[HARNESS_OBSERVABILITY_ISSUES_STATE_KEY] as EveObservabilityIssueState | undefined;
}

export function setObservabilityIssueState(
  session: HarnessSession,
  next: EveObservabilityIssueState,
): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [HARNESS_OBSERVABILITY_ISSUES_STATE_KEY]: next,
    },
  };
}

export function accumulateObservabilityIssues(input: {
  readonly event: HandleMessageStreamEvent;
  readonly previous: EveObservabilityIssueState | undefined;
}): EveObservabilityIssueState {
  const turnId = getTurnId(input.event) || input.previous?.turnId || "";
  const previous =
    input.previous !== undefined && input.previous.turnId === turnId
      ? input.previous
      : {
          ...EMPTY_SUMMARY,
          seenIssueInTurn: false,
          session: input.previous?.session ?? EMPTY_SUMMARY,
          turnId,
        };

  const next = issueDelta(input.event, previous.seenIssueInTurn);
  if (next === null) {
    return previous;
  }

  const turn = addIssue(previous, next);
  return {
    ...turn,
    seenIssueInTurn: previous.seenIssueInTurn || next.countsAsIssue,
    session: addIssue(previous.session, next),
    turnId,
  };
}

export function observabilityIssueAttributes(
  summary: EveObservabilityIssueSummary,
): Record<string, EveAttributeValue> {
  return {
    "$eve.error_count": summary.errorCount,
    "$eve.failed_action_count": summary.failedActionCount,
    "$eve.failed_step_count": summary.failedStepCount,
    "$eve.failed_turn_count": summary.failedTurnCount,
    "$eve.issue_count": summary.issueCount,
    "$eve.last_issue_at": summary.lastIssueAt,
    "$eve.last_issue_code": summary.lastIssueCode,
    "$eve.last_issue_tool": summary.lastIssueTool,
    "$eve.last_issue_type": summary.lastIssueType,
    "$eve.rejected_action_count": summary.rejectedActionCount,
  };
}

interface IssueDelta {
  readonly code: string;
  readonly countsAsIssue: boolean;
  readonly countsAsError: boolean;
  readonly failedActionCount?: number;
  readonly failedStepCount?: number;
  readonly failedTurnCount?: number;
  readonly issueType: EveObservabilityIssueType;
  readonly rejectedActionCount?: number;
  readonly timestamp?: string;
  readonly tool?: string;
}

function issueDelta(event: HandleMessageStreamEvent, seenIssueInTurn: boolean): IssueDelta | null {
  if (event.type === "action.result") {
    if (event.data.status !== "failed" && event.data.status !== "rejected") {
      return null;
    }
    return {
      code: event.data.error?.code ?? actionFallbackCode(event.data.status),
      countsAsError: event.data.status === "failed",
      countsAsIssue: true,
      failedActionCount: event.data.status === "failed" ? 1 : 0,
      issueType: event.data.status === "failed" ? "action_failed" : "action_rejected",
      rejectedActionCount: event.data.status === "rejected" ? 1 : 0,
      timestamp: event.meta?.at ?? new Date().toISOString(),
      tool: actionResultName(event.data.result),
    };
  }

  if (event.type === "step.failed") {
    return {
      code: event.data.code,
      countsAsError: true,
      countsAsIssue: true,
      failedStepCount: 1,
      issueType: "step_failed",
      timestamp: event.meta?.at ?? new Date().toISOString(),
    };
  }

  if (event.type === "turn.failed") {
    return {
      code: event.data.code,
      countsAsError: !seenIssueInTurn,
      countsAsIssue: !seenIssueInTurn,
      failedTurnCount: 1,
      issueType: "turn_failed",
      timestamp: event.meta?.at ?? new Date().toISOString(),
    };
  }

  if (event.type === "session.failed" && !seenIssueInTurn) {
    return {
      code: event.data.code,
      countsAsError: true,
      countsAsIssue: true,
      issueType: "session_failed",
      timestamp: event.meta?.at ?? new Date().toISOString(),
    };
  }

  return null;
}

function addIssue<T extends EveObservabilityIssueSummary>(summary: T, delta: IssueDelta): T {
  return {
    ...summary,
    errorCount: summary.errorCount + (delta.countsAsError ? 1 : 0),
    failedActionCount: summary.failedActionCount + (delta.failedActionCount ?? 0),
    failedStepCount: summary.failedStepCount + (delta.failedStepCount ?? 0),
    failedTurnCount: summary.failedTurnCount + (delta.failedTurnCount ?? 0),
    issueCount: summary.issueCount + (delta.countsAsIssue ? 1 : 0),
    lastIssueAt: delta.countsAsIssue ? delta.timestamp : summary.lastIssueAt,
    lastIssueCode: delta.countsAsIssue ? delta.code : summary.lastIssueCode,
    lastIssueTool: delta.countsAsIssue ? delta.tool : summary.lastIssueTool,
    lastIssueType: delta.countsAsIssue ? delta.issueType : summary.lastIssueType,
    rejectedActionCount: summary.rejectedActionCount + (delta.rejectedActionCount ?? 0),
  };
}

function actionFallbackCode(status: "failed" | "rejected"): string {
  return status === "failed" ? "ACTION_RESULT_FAILED" : "ACTION_RESULT_REJECTED";
}

function actionResultName(
  result: Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): string | undefined {
  if (result.kind === "tool-result") {
    return result.toolName;
  }
  if (result.kind === "subagent-result") {
    return result.subagentName;
  }
  return result.name ?? "load_skill";
}

function getTurnId(event: HandleMessageStreamEvent): string {
  return "data" in event &&
    event.data !== undefined &&
    "turnId" in event.data &&
    typeof event.data.turnId === "string"
    ? event.data.turnId
    : "";
}
