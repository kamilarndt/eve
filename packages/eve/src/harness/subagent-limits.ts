import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import type { AgentSubagentLimitsDefinition } from "#shared/agent-definition.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 4;
export const DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP = 4;

const SUBAGENT_LIMIT_STATE_KEY = "eve.runtime.subagentLimits";

interface SubagentLimitState {
  readonly depth?: number;
  readonly maxCallsPerStep?: number;
  readonly maxDepth?: number;
}

type DelegationAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

type SubagentLimitCode = "EVE_SUBAGENT_DEPTH_LIMIT_EXCEEDED" | "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED";

interface SubagentLimitRejection {
  readonly action: DelegationAction;
  readonly code: SubagentLimitCode;
  readonly message: string;
}

export interface ApplySubagentLimitsResult {
  readonly actions: readonly RuntimeActionRequest[];
  readonly rejectedResults: readonly RuntimeSubagentResultActionResult[];
}

export interface EffectiveSubagentLimits {
  readonly maxCallsPerStep: number;
  readonly maxDepth: number;
}

export function applySubagentLimits(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly session: HarnessSession;
}): ApplySubagentLimitsResult {
  const depth = getSubagentDepth(input.session.state);
  const limits = getEffectiveSubagentLimits(input.session.state);
  const requestedDelegationCalls = input.actions.filter(isDelegationAction).length;
  const actions: RuntimeActionRequest[] = [];
  const rejections: SubagentLimitRejection[] = [];
  let acceptedDelegationCalls = 0;

  for (const action of input.actions) {
    if (!isDelegationAction(action)) {
      actions.push(action);
      continue;
    }

    if (depth >= limits.maxDepth) {
      rejections.push({
        action,
        code: "EVE_SUBAGENT_DEPTH_LIMIT_EXCEEDED",
        message:
          "Maximum subagent depth reached. Do not retry this subagent call; complete the work in this session or return a partial result.",
      });
      continue;
    }

    if (acceptedDelegationCalls >= limits.maxCallsPerStep) {
      rejections.push({
        action,
        code: "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED",
        message: `This step requested ${requestedDelegationCalls} subagent calls, but eve allows ${limits.maxCallsPerStep}. The first ${limits.maxCallsPerStep} were started. Retry the remaining work in a later step with at most ${limits.maxCallsPerStep} subagent calls.`,
      });
      continue;
    }

    acceptedDelegationCalls++;
    actions.push(action);
  }

  return {
    actions,
    rejectedResults: rejections.map(createSubagentLimitResult),
  };
}

export function getChildSubagentDepth(session: HarnessSession): number {
  return getSubagentDepth(session.state) + 1;
}

export function resolveEffectiveSubagentLimits(input: {
  readonly authored?: AgentSubagentLimitsDefinition;
  readonly inherited?: AgentSubagentLimitsDefinition;
}): EffectiveSubagentLimits {
  if (input.inherited === undefined) {
    return {
      maxCallsPerStep:
        normalizePositiveInteger(input.authored?.maxCallsPerStep) ??
        DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP,
      maxDepth: normalizePositiveInteger(input.authored?.maxDepth) ?? DEFAULT_MAX_SUBAGENT_DEPTH,
    };
  }

  const inherited = normalizeEffectiveSubagentLimits(input.inherited);
  return {
    maxCallsPerStep:
      input.authored?.maxCallsPerStep === undefined
        ? inherited.maxCallsPerStep
        : Math.min(inherited.maxCallsPerStep, input.authored.maxCallsPerStep),
    maxDepth:
      input.authored?.maxDepth === undefined
        ? inherited.maxDepth
        : Math.min(inherited.maxDepth, input.authored.maxDepth),
  };
}

export function getEffectiveSubagentLimits(
  state: SessionStateMap | undefined,
): EffectiveSubagentLimits {
  const value = state?.[SUBAGENT_LIMIT_STATE_KEY];
  if (typeof value !== "object" || value === null) return DEFAULT_SUBAGENT_LIMITS;
  return normalizeEffectiveSubagentLimits(value as AgentSubagentLimitsDefinition);
}

export function setSubagentLimitState(input: {
  readonly depth: number | undefined;
  readonly limits: EffectiveSubagentLimits;
  readonly session: HarnessSession;
}): HarnessSession {
  const depth = normalizeDepth(input.depth);
  if (depth === 0 && isDefaultSubagentLimits(input.limits)) return input.session;

  const state = { ...input.session.state };
  state[SUBAGENT_LIMIT_STATE_KEY] = {
    depth: depth === 0 ? undefined : depth,
    maxCallsPerStep: input.limits.maxCallsPerStep,
    maxDepth: input.limits.maxDepth,
  } satisfies SubagentLimitState;
  return { ...input.session, state };
}

export function setSubagentDepth(input: {
  readonly depth: number | undefined;
  readonly session: HarnessSession;
}): HarnessSession {
  const depth = normalizeDepth(input.depth);
  if (depth === 0) return input.session;

  const limits = getEffectiveSubagentLimits(input.session.state);
  const state = { ...input.session.state };
  state[SUBAGENT_LIMIT_STATE_KEY] = {
    depth,
    maxCallsPerStep: limits.maxCallsPerStep,
    maxDepth: limits.maxDepth,
  } satisfies SubagentLimitState;
  return { ...input.session, state };
}

export function getSubagentDepth(state: SessionStateMap | undefined): number {
  const value = state?.[SUBAGENT_LIMIT_STATE_KEY];
  if (typeof value !== "object" || value === null) return 0;
  return normalizeDepth((value as SubagentLimitState).depth);
}

function createSubagentLimitResult(
  rejection: SubagentLimitRejection,
): RuntimeSubagentResultActionResult {
  return {
    callId: rejection.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: rejection.code,
      message: rejection.message,
    },
    subagentName: getDelegationActionName(rejection.action),
  };
}

function getDelegationActionName(action: DelegationAction): string {
  return action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
}

function isDelegationAction(action: RuntimeActionRequest): action is DelegationAction {
  return action.kind === "remote-agent-call" || action.kind === "subagent-call";
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isInteger(depth) || depth < 0) return 0;
  return depth;
}

const DEFAULT_SUBAGENT_LIMITS: EffectiveSubagentLimits = {
  maxCallsPerStep: DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP,
  maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
};

function normalizeEffectiveSubagentLimits(
  limits: AgentSubagentLimitsDefinition,
): EffectiveSubagentLimits {
  return {
    maxCallsPerStep:
      normalizePositiveInteger(limits.maxCallsPerStep) ?? DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP,
    maxDepth: normalizePositiveInteger(limits.maxDepth) ?? DEFAULT_MAX_SUBAGENT_DEPTH,
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value === undefined || !Number.isInteger(value) || value <= 0 ? undefined : value;
}

function isDefaultSubagentLimits(limits: EffectiveSubagentLimits): boolean {
  return (
    limits.maxCallsPerStep === DEFAULT_MAX_SUBAGENT_CALLS_PER_STEP &&
    limits.maxDepth === DEFAULT_MAX_SUBAGENT_DEPTH
  );
}
