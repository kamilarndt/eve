declare const brand: unique symbol;
const balanced: unique symbol = Symbol("BalancedHistory");

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type ChildId = Brand<string, "ChildId">;
export type EventId = Brand<string, "EventId">;
export type EventLogId = Brand<string, "EventLogId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type OperationId = Brand<string, "OperationId">;
export type SessionId = Brand<string, "SessionId">;

export type WireValue =
  | null
  | boolean
  | number
  | string
  | readonly WireValue[]
  | { readonly [key: string]: WireValue };

export interface UserMessage {
  readonly content: string;
  readonly role: "user";
}

export interface AssistantMessage {
  readonly content: string;
  readonly requestIds: readonly string[];
  readonly role: "assistant";
}

export interface ToolMessage {
  readonly content: WireValue;
  readonly isError: boolean;
  readonly requestId: string;
  readonly role: "tool";
}

export type HistoryMessage = UserMessage | AssistantMessage | ToolMessage;

export type BalancedHistory = readonly HistoryMessage[] & { readonly [balanced]: true };

export function createBalancedHistory(messages: readonly HistoryMessage[]): BalancedHistory {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user") continue;
    if (message?.role === "tool") {
      throw new TypeError(`Tool result "${message.requestId}" has no preceding request.`);
    }
    if (message === undefined) throw new TypeError("History contains a missing message.");

    const requestIds = message.requestIds;
    if (new Set(requestIds).size !== requestIds.length) {
      throw new TypeError("Assistant history message contains duplicate request IDs.");
    }
    for (const [offset, requestId] of requestIds.entries()) {
      const result = messages[index + offset + 1];
      if (result?.role !== "tool" || result.requestId !== requestId) {
        throw new TypeError(`Assistant request "${requestId}" has no matching result.`);
      }
    }
    index += requestIds.length;
  }

  const history = Object.assign([...messages], { [balanced]: true as const });
  Object.defineProperty(history, balanced, { enumerable: false });
  return history;
}

export type LoopRequest = ToolRequest | ApprovalRequest | SubagentRequest;

export interface ToolRequest {
  readonly input: WireValue;
  readonly kind: "tool";
  readonly name: string;
  readonly requestId: string;
}

export interface ApprovalRequest {
  readonly input: WireValue;
  readonly kind: "approval";
  readonly name: string;
  readonly requestId: string;
}

export interface SubagentRequest {
  readonly delayMs: number;
  readonly kind: "subagent";
  readonly message: string;
  readonly requestId: string;
}

export interface RequestResult {
  readonly isError: boolean;
  readonly requestId: string;
  readonly value: WireValue;
}

export interface OpenExchange {
  readonly assistant: AssistantMessage;
  readonly requests: readonly LoopRequest[];
  readonly results: readonly (RequestResult | null)[];
}

export type Scenario =
  | { readonly delayMs?: number; readonly kind: "echo" }
  | { readonly kind: "tool" }
  | { readonly kind: "tool-fail" }
  | { readonly kind: "approval" }
  | {
      readonly children: readonly { readonly delayMs: number; readonly message: string }[];
      readonly kind: "children";
    }
  | { readonly kind: "retry-once" }
  | { readonly kind: "infrastructure-fail" }
  | { readonly kind: "fail" };

export interface SessionState {
  readonly bufferedDeliveries: readonly Delivery[];
  readonly continuationToken: string;
  readonly eventLogId: EventLogId;
  readonly history: BalancedHistory;
  readonly mode: "conversation" | "task";
  readonly nextEventSequence: number;
  readonly nextTurnOrdinal: number;
  readonly pending: OpenExchange | null;
  readonly phase: "between-turns" | "turn" | "terminal";
  readonly scenario: Scenario;
  readonly sessionId: SessionId;
}

export interface SessionCheckpoint {
  readonly leaseOwner: ExecutionId;
  readonly revision: number;
  readonly state: SessionState;
  readonly version: 1;
}

export interface SerializableFailure {
  readonly code: string;
  readonly message: string;
}

export type TerminalOutcome =
  | { readonly kind: "completed"; readonly output: WireValue }
  | { readonly error: SerializableFailure; readonly kind: "failed" };

export interface MessageDelivery {
  readonly deliveryId: string;
  readonly kind: "message";
  readonly message: string;
}

export interface ApprovalDelivery {
  readonly approved: boolean;
  readonly deliveryId: string;
  readonly kind: "approval";
  readonly requestId: string;
}

export type Delivery = MessageDelivery | ApprovalDelivery;

export type RetryPolicy =
  | { readonly idempotency: "required"; readonly maxAttempts: number }
  | { readonly idempotency: "none"; readonly maxAttempts: 1 };

export interface GeneratedTurn {
  readonly assistant: AssistantMessage;
  readonly finish: { readonly output: WireValue } | null;
  readonly requests: readonly LoopRequest[];
}

export interface EffectMap {
  readonly "deliver-input": { readonly input: Delivery; readonly output: Delivery };
  readonly "execute-tool": {
    readonly input: { readonly request: ApprovalRequest | ToolRequest };
    readonly output: RequestResult;
  };
  readonly "finalize-session": {
    readonly input: { readonly outcome: TerminalOutcome; readonly sessionId: SessionId };
    readonly output: { readonly recorded: true };
  };
  readonly generate: {
    readonly input: { readonly history: BalancedHistory; readonly scenario: Scenario };
    readonly output: GeneratedTurn;
  };
  readonly "initialize-session": {
    readonly input: { readonly continuationToken: string; readonly sessionId: SessionId };
    readonly output: { readonly continuationToken: string };
  };
}

export type EffectName = keyof EffectMap;
export type EffectInput<K extends EffectName> = EffectMap[K]["input"];
export type EffectOutput<K extends EffectName> = EffectMap[K]["output"];

export type EffectResult<K extends EffectName> =
  | { readonly kind: "succeeded"; readonly output: EffectOutput<K> }
  | { readonly error: SerializableFailure; readonly kind: "exhausted" };

export interface EffectCall<K extends EffectName = EffectName> {
  readonly id: OperationId;
  readonly input: EffectInput<K>;
  readonly name: K;
  readonly retry: RetryPolicy;
}

export interface EventRecord {
  readonly id: EventId;
  readonly logId: EventLogId;
  readonly operationId: OperationId;
  readonly payload: WireValue;
  readonly sequence: number;
}

export interface SessionProgramInput {
  readonly continuationToken: string;
  readonly eventLogId: EventLogId;
  readonly initialDelivery: MessageDelivery;
  readonly mode: "conversation" | "task";
  readonly scenario: Scenario;
  readonly sessionId: SessionId;
}

export interface TurnProgramInput {
  readonly checkpoint: SessionCheckpoint;
  readonly delivery: Delivery;
  readonly parentExecutionId: ExecutionId;
}

export type TurnOutcome =
  | {
      readonly checkpoint: SessionCheckpoint;
      readonly kind: "conversation-replied";
      readonly output: WireValue;
    }
  | {
      readonly checkpoint: SessionCheckpoint;
      readonly kind: "waiting-approval";
      readonly requestId: string;
    }
  | {
      readonly checkpoint: SessionCheckpoint;
      readonly kind: "task-terminal";
      readonly terminal: TerminalOutcome;
    };

export interface TurnChildSpec {
  readonly eventLog: { readonly kind: "borrow-parent" };
  readonly id: ChildId;
  readonly input: TurnProgramInput;
  readonly kind: "turn";
  readonly version: "latest-compatible";
}

export interface SessionChildSpec {
  readonly eventLog: { readonly id: EventLogId; readonly kind: "own" };
  readonly id: ChildId;
  readonly input: Omit<SessionProgramInput, "eventLogId">;
  readonly kind: "session";
  readonly version: "pinned";
}

export interface ChildOutputMap {
  readonly session: TerminalOutcome;
  readonly turn: TurnOutcome;
}

export type ChildKind = keyof ChildOutputMap;
export type ChildOutput<Kind extends ChildKind> = ChildOutputMap[Kind];

export interface ChildHandle<Kind extends ChildKind> {
  readonly backendRunId: string;
  readonly id: ChildId;
  readonly kind: Kind;
}

export type AnyChildHandle = {
  readonly [Kind in ChildKind]: ChildHandle<Kind>;
}[ChildKind];

export type DriverUpdate = {
  readonly checkpoint: SessionCheckpoint;
  readonly kind: "checkpoint";
};

export interface ChildNoticeMap {
  readonly session: { readonly kind: "terminal"; readonly output: TerminalOutcome };
  readonly turn:
    | { readonly kind: "update"; readonly update: DriverUpdate }
    | { readonly kind: "terminal"; readonly output: TurnOutcome };
}

export type ChildNotice<Kind extends ChildKind> = ChildNoticeMap[Kind];

export interface ReceiveWait {
  readonly continuationToken: string;
  readonly pendingApprovalRequestId: string | null;
}

export interface LoopBackend {
  readonly executionId: ExecutionId;

  acknowledgeChildUpdate(handle: ChildHandle<"turn">, revision: number): Promise<void>;
  appendEvents(events: readonly EventRecord[]): Promise<void>;
  checkpoint(checkpoint: SessionCheckpoint): Promise<void>;
  effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>>;
  finish(outcome: TerminalOutcome): Promise<void>;
  receive(wait: ReceiveWait): Promise<Delivery>;
  startSessionChild(spec: SessionChildSpec): Promise<ChildHandle<"session">>;
  startTurnChild(spec: TurnChildSpec): Promise<ChildHandle<"turn">>;
  waitForChild(handle: ChildHandle<"session">): Promise<ChildNotice<"session">>;
  waitForChild(handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">>;
}

export interface PrototypeEventStore {
  append(events: readonly EventRecord[]): Promise<void>;
  read(logId: EventLogId): Promise<readonly EventRecord[]>;
}

export interface PrototypeRun {
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;

  deliver(delivery: Delivery): Promise<void>;
  events(): Promise<readonly EventRecord[]>;
  stop(): Promise<void>;
}

export interface PrototypeRuntime {
  readonly kind: "inline" | "temporal" | "workflow";

  attemptCount(operationId: OperationId): Promise<number>;
  callback(sessionId: SessionId): Promise<TerminalOutcome | null>;
  close(): Promise<void>;
  events(logId: EventLogId): Promise<readonly EventRecord[]>;
  executionCount(operationId: OperationId): Promise<number>;
  start(input: SessionProgramInput): Promise<PrototypeRun>;
  visibleEffectCount(operationId: OperationId): Promise<number>;
}
