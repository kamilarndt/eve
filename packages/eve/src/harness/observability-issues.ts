import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  EVE_ATTRIBUTE_VALUE_MAX_BYTES,
  type EveAttributeValue,
} from "#runtime/attributes/normalize.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const HARNESS_OBSERVABILITY_ISSUES_STATE_KEY = "eve.harness.observabilityIssues";

export type EveObservabilityIssueType =
  | "action_failed"
  | "action_rejected"
  | "session_failed"
  | "step_failed"
  | "turn_failed";

export type EveObservabilityIssueSource =
  | "remote_subagent"
  | "skill"
  | "subagent"
  | "tool"
  | "workflow";

export interface EveObservabilityIssue {
  readonly at?: string;
  readonly code: string;
  readonly source: EveObservabilityIssueSource;
  readonly tool?: string;
  readonly toolCallId?: string;
  readonly turnId?: string;
  readonly type: EveObservabilityIssueType;
}

export interface EveObservabilityIssueState {
  readonly issue: EveObservabilityIssue;
  readonly seenIssueInTurn: boolean;
  readonly turnId: string;
}

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

export function preserveObservabilityIssueState(
  source: HarnessSession,
  target: HarnessSession,
): HarnessSession {
  const state = getObservabilityIssueState(source.state);
  if (state === undefined) {
    return target;
  }
  return setObservabilityIssueState(target, state);
}

export function accumulateObservabilityIssues(input: {
  readonly event: HandleMessageStreamEvent;
  readonly previous: EveObservabilityIssueState | undefined;
}): EveObservabilityIssueState | undefined {
  const turnId = getTurnId(input.event) || input.previous?.turnId || "";
  const previous =
    input.previous !== undefined && input.previous.turnId === turnId ? input.previous : undefined;

  const next = issueFromEvent(input.event, previous?.seenIssueInTurn ?? false);
  if (next === null) {
    return previous ?? input.previous;
  }

  return {
    issue: next,
    seenIssueInTurn: true,
    turnId,
  };
}

export function observabilityIssueAttributes(
  state: EveObservabilityIssueState,
): Record<string, EveAttributeValue> {
  return {
    "$eve.issue": serializeIssue(state.issue),
  };
}

function issueFromEvent(
  event: HandleMessageStreamEvent,
  seenIssueInTurn: boolean,
): EveObservabilityIssue | null {
  if (event.type === "action.result") {
    if (event.data.status !== "failed" && event.data.status !== "rejected") {
      return null;
    }
    return {
      at: event.meta?.at ?? new Date().toISOString(),
      code: event.data.error?.code ?? actionFallbackCode(event.data.status),
      source: actionResultSource(event.data.result),
      tool: actionResultName(event.data.result),
      toolCallId: event.data.result.callId,
      turnId: event.data.turnId,
      type: event.data.status === "failed" ? "action_failed" : "action_rejected",
    };
  }

  if (event.type === "step.failed" && !seenIssueInTurn) {
    return {
      at: event.meta?.at ?? new Date().toISOString(),
      code: event.data.code,
      source: "workflow",
      turnId: event.data.turnId,
      type: "step_failed",
    };
  }

  if (event.type === "turn.failed" && !seenIssueInTurn) {
    return {
      at: event.meta?.at ?? new Date().toISOString(),
      code: event.data.code,
      source: "workflow",
      turnId: event.data.turnId,
      type: "turn_failed",
    };
  }

  if (event.type === "session.failed" && !seenIssueInTurn) {
    return {
      at: event.meta?.at ?? new Date().toISOString(),
      code: event.data.code,
      source: "workflow",
      type: "session_failed",
    };
  }

  return null;
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

function actionResultSource(
  result: Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): EveObservabilityIssueSource {
  if (result.kind === "tool-result") {
    return "tool";
  }
  if (result.kind === "subagent-result") {
    return result.subagentKind === "remote" ? "remote_subagent" : "subagent";
  }
  return "skill";
}

function getTurnId(event: HandleMessageStreamEvent): string {
  return "data" in event &&
    event.data !== undefined &&
    "turnId" in event.data &&
    typeof event.data.turnId === "string"
    ? event.data.turnId
    : "";
}

type SerializedIssue = {
  readonly at?: string;
  readonly c: string;
  readonly call?: string;
  readonly s: EveObservabilityIssueSource;
  readonly t: EveObservabilityIssueType;
  readonly tool?: string;
  readonly turn?: string;
  readonly v: 1;
};

function compactIssue(issue: EveObservabilityIssue): SerializedIssue {
  return {
    at: issue.at,
    c: issue.code,
    call: issue.toolCallId,
    s: issue.source,
    t: issue.type,
    tool: issue.tool,
    turn: issue.turnId,
    v: 1,
  };
}

function omitUndefined(issue: SerializedIssue): Record<string, string | number> {
  const compact: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(issue)) {
    if (value !== undefined && value !== "") {
      compact[key] = value;
    }
  }
  return compact;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function serializeIssue(issue: EveObservabilityIssue): string {
  const payload: Record<string, string | number> = omitUndefined(compactIssue(issue));
  const shrinkable = ["tool", "turn", "call", "at", "c"];

  while (true) {
    const json = JSON.stringify(payload);
    if (byteLength(json) <= EVE_ATTRIBUTE_VALUE_MAX_BYTES) {
      return json;
    }

    const key = shrinkable.find(
      (candidate) => typeof payload[candidate] === "string" && payload[candidate].length > 16,
    );
    if (key) {
      payload[key] = String(payload[key]).slice(0, Math.max(8, String(payload[key]).length - 16));
      continue;
    }

    const optionalKey = shrinkable
      .filter((candidate) => candidate !== "c")
      .find((candidate) => candidate in payload);
    if (optionalKey) {
      delete payload[optionalKey];
      continue;
    }

    const minimal = { c: String(payload.c ?? issue.code), s: issue.source, t: issue.type, v: 1 };
    const minimalJson = JSON.stringify(minimal);
    if (byteLength(minimalJson) <= EVE_ATTRIBUTE_VALUE_MAX_BYTES) {
      return minimalJson;
    }

    const maxCodeChars = Math.max(0, String(minimal.c).length - 16);
    payload.c = String(minimal.c).slice(0, maxCodeChars);
  }
}
