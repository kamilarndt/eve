import { childSessionId, eventLogId, operationId, requestChildId } from "./ids.js";
import { EffectExhaustedError, runEffect } from "./effects.js";
import { appendEvent, idempotentRetry, replaceCheckpoint } from "./program-support.js";
import { appendUser, closeExchange, openExchange, resolveExchangeRequest } from "./transcript.js";
import type {
  ApprovalDelivery,
  ApprovalRequest,
  ChildHandle,
  EffectCall,
  EffectName,
  EffectOutput,
  GeneratedTurn,
  LoopBackend,
  LoopRequest,
  OpenExchange,
  RequestResult,
  SessionCheckpoint,
  SessionState,
  SubagentRequest,
  TerminalOutcome,
  TurnOutcome,
  TurnProgramInput,
  WireValue,
} from "./types.js";

export async function runTurn(backend: LoopBackend, input: TurnProgramInput): Promise<TurnOutcome> {
  assertLease(input.checkpoint, backend.executionId);

  let checkpoint = input.checkpoint;
  let state = checkpoint.state;

  try {
    const delivery = await runEffectAtState(backend, state, {
      id: operationId(state.sessionId, state.nextTurnOrdinal - 1, "deliver"),
      input: input.delivery,
      name: "deliver-input",
      retry: idempotentRetry(2),
    });

    if (delivery.kind === "message") {
      if (state.pending !== null) {
        throw new Error("A message delivery cannot resolve a pending approval.");
      }
      state = { ...state, history: appendUser(state.history, delivery.message) };
    } else {
      state = await resolveApproval(backend, state, delivery);
    }

    const result = await executeModelLoop(backend, state);
    state = result.state;

    const returned = replaceCheckpoint(checkpoint, input.parentExecutionId, {
      ...state,
      phase: result.kind === "terminal" ? "terminal" : "between-turns",
    });
    await backend.checkpoint(returned);

    if (result.kind === "waiting-approval") {
      return {
        checkpoint: returned,
        kind: "waiting-approval",
        requestId: result.requestId,
      };
    }

    if (result.kind === "terminal") {
      return { checkpoint: returned, kind: "task-terminal", terminal: result.terminal };
    }

    return {
      checkpoint: returned,
      kind: "conversation-replied",
      output: result.output,
    };
  } catch (error) {
    if (!(error instanceof TurnEffectExhaustedError)) throw error;
    const terminal: Extract<TerminalOutcome, { readonly kind: "failed" }> = {
      error: error.effectError.failure,
      kind: "failed",
    };
    const failureEvent = await appendEvent(
      backend,
      error.state,
      operationId(error.state.sessionId, error.state.nextTurnOrdinal - 1, "turn-failed"),
      {
        code: terminal.error.code,
        message: terminal.error.message,
        type: "turn.failed",
      },
    );
    const returned = replaceCheckpoint(checkpoint, input.parentExecutionId, {
      ...failureEvent,
      phase: "terminal",
    });
    await backend.checkpoint(returned);
    return { checkpoint: returned, kind: "task-terminal", terminal };
  }
}

type ModelLoopResult =
  | { readonly kind: "reply"; readonly output: WireValue; readonly state: SessionState }
  | { readonly kind: "waiting-approval"; readonly requestId: string; readonly state: SessionState }
  | { readonly kind: "terminal"; readonly state: SessionState; readonly terminal: TerminalOutcome };

async function executeModelLoop(
  backend: LoopBackend,
  initialState: SessionState,
): Promise<ModelLoopResult> {
  let state = initialState;
  let generationOrdinal = 0;

  while (true) {
    if (state.pending !== null) {
      throw new Error("Pending exchange must be resolved before generation.");
    }

    const generationOperation = operationId(
      state.sessionId,
      state.nextTurnOrdinal - 1,
      `generate:${String(generationOrdinal++)}`,
    );
    const generated = await runEffectAtState(backend, state, {
      id: generationOperation,
      input: { history: state.history, scenario: state.scenario },
      name: "generate",
      retry: idempotentRetry(2),
    });
    let exchange = openGeneratedExchange(generated);
    state = await appendEvent(backend, state, generationOperation, {
      requestCount: generated.requests.length,
      type: "model.generated",
    });

    const approval = generated.requests.find(
      (request): request is ApprovalRequest => request.kind === "approval",
    );
    if (approval !== undefined) {
      state = await appendEvent(
        backend,
        { ...state, pending: exchange },
        generationOperation,
        {
          requestId: approval.requestId,
          type: "approval.requested",
        },
        1,
      );
      return { kind: "waiting-approval", requestId: approval.requestId, state };
    }

    const immediate = await resolveImmediateRequests(backend, state, exchange);
    exchange = immediate.exchange;
    state = immediate.state;
    const history = closeExchange(state.history, exchange);
    if (history === null) throw new Error("Immediate requests did not close their exchange.");
    state = { ...state, history, pending: null };

    if (generated.finish === null) continue;

    state = await appendEvent(
      backend,
      state,
      generationOperation,
      {
        output: generated.finish.output,
        type: "assistant.reply",
      },
      1,
    );

    if (state.mode === "conversation") {
      return { kind: "reply", output: generated.finish.output, state };
    }

    return {
      kind: "terminal",
      state,
      terminal: { kind: "completed", output: generated.finish.output },
    };
  }
}

function openGeneratedExchange(generated: GeneratedTurn): OpenExchange {
  if (generated.finish === null && generated.requests.length === 0) {
    throw new Error("Generation returned neither a terminal output nor a request.");
  }
  if (generated.finish !== null && generated.requests.length > 0) {
    throw new Error("Generation returned terminal output together with unresolved requests.");
  }
  const approvalCount = generated.requests.filter((request) => request.kind === "approval").length;
  if (approvalCount > 0 && (approvalCount !== 1 || generated.requests.length !== 1)) {
    throw new Error("Generation mixed an approval with another unresolved request.");
  }
  return openExchange({ assistant: generated.assistant, requests: generated.requests });
}

async function resolveImmediateRequests(
  backend: LoopBackend,
  initialState: SessionState,
  initialExchange: OpenExchange,
): Promise<{ readonly exchange: OpenExchange; readonly state: SessionState }> {
  let state = initialState;
  let exchange = initialExchange;
  const subagents: {
    readonly child: ChildHandle<"session">;
    readonly request: SubagentRequest;
  }[] = [];

  for (const request of exchange.requests) {
    if (request.kind === "approval") continue;

    if (request.kind === "tool") {
      const executed = await executeTool(backend, state, request);
      state = executed.state;
      exchange = resolveExchangeRequest(exchange, executed.result);
      continue;
    }

    const childSession = childSessionId(state.sessionId, request.requestId);
    const logicalId = requestChildId(backend.executionId, request.requestId);
    const child = await backend.startSessionChild({
      eventLog: { id: eventLogId(`${childSession}:events`), kind: "own" },
      id: logicalId,
      input: {
        continuationToken: `${childSession}:input`,
        initialDelivery: {
          deliveryId: `${request.requestId}:delivery`,
          kind: "message",
          message: request.message,
        },
        mode: "task",
        scenario: { delayMs: request.delayMs, kind: "echo" },
        sessionId: childSession,
      },
      kind: "session",
      version: "pinned",
    });
    state = await appendEvent(
      backend,
      state,
      operationId(state.sessionId, state.nextTurnOrdinal - 1, `child-started:${request.requestId}`),
      {
        childId: child.id,
        requestId: request.requestId,
        type: "child.started",
      },
    );
    subagents.push({ child, request });
  }

  for (const { child, request } of subagents) {
    const terminal = await waitForTerminal(backend, child);
    state = await appendEvent(
      backend,
      state,
      operationId(state.sessionId, state.nextTurnOrdinal - 1, `child-result:${request.requestId}`),
      {
        childId: child.id,
        outcome: terminal.kind,
        requestId: request.requestId,
        type: "child.result",
      },
    );
    exchange = resolveExchangeRequest(exchange, {
      isError: terminal.kind === "failed",
      requestId: request.requestId,
      value: terminal.kind === "completed" ? terminal.output : terminal.error.message,
    });
  }

  return { exchange, state };
}

async function executeTool(
  backend: LoopBackend,
  state: SessionState,
  request: ApprovalRequest | Extract<LoopRequest, { readonly kind: "tool" }>,
): Promise<{ readonly result: RequestResult; readonly state: SessionState }> {
  const operation = operationId(
    state.sessionId,
    state.nextTurnOrdinal - 1,
    `tool:${request.requestId}`,
  );
  const result = await runEffectAtState(backend, state, {
    id: operation,
    input: { request },
    name: "execute-tool",
    retry: idempotentRetry(2),
  });
  const nextState = await appendEvent(backend, state, operation, {
    requestId: request.requestId,
    type: "tool.completed",
  });
  return { result, state: nextState };
}

async function resolveApproval(
  backend: LoopBackend,
  state: SessionState,
  delivery: ApprovalDelivery,
): Promise<SessionState> {
  const exchange = state.pending;
  if (exchange === null) throw new Error("Approval delivery has no pending exchange.");

  const request = exchange.requests.find(
    (candidate): candidate is ApprovalRequest =>
      candidate.kind === "approval" && candidate.requestId === delivery.requestId,
  );
  if (request === undefined) {
    throw new Error(`Approval delivery does not match request "${delivery.requestId}".`);
  }

  const executed = delivery.approved
    ? await executeTool(backend, state, request)
    : {
        result: { isError: true, requestId: request.requestId, value: "denied" as const },
        state,
      };
  const result = executed.result;
  const resolved = resolveExchangeRequest(exchange, result);
  const history = closeExchange(executed.state.history, resolved);
  if (history === null) throw new Error("Approval did not close its exchange.");

  return { ...executed.state, history, pending: null };
}

async function waitForTerminal(
  backend: LoopBackend,
  child: ChildHandle<"session">,
): Promise<TerminalOutcome> {
  return (await backend.waitForChild(child)).output;
}

function assertLease(
  checkpoint: SessionCheckpoint,
  expected: SessionCheckpoint["leaseOwner"],
): void {
  if (checkpoint.leaseOwner !== expected) {
    throw new Error(`Checkpoint lease belongs to "${checkpoint.leaseOwner}", not "${expected}".`);
  }
}

class TurnEffectExhaustedError extends Error {
  readonly effectError: EffectExhaustedError;
  readonly state: SessionState;

  constructor(state: SessionState, effectError: EffectExhaustedError) {
    super(effectError.message, { cause: effectError });
    this.effectError = effectError;
    this.name = "TurnEffectExhaustedError";
    this.state = state;
  }
}

async function runEffectAtState<K extends EffectName>(
  backend: LoopBackend,
  state: SessionState,
  call: EffectCall<K>,
): Promise<EffectOutput<K>> {
  try {
    return await runEffect(backend, call);
  } catch (error) {
    if (!(error instanceof EffectExhaustedError)) throw error;
    throw new TurnEffectExhaustedError(state, error);
  }
}
