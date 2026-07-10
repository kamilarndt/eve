import { lastUserMessage, resultsAfterLastUser } from "./transcript.js";
import { parseJsonWireValue } from "./wire.js";
import type {
  Delivery,
  EffectCall,
  EffectName,
  EffectOutput,
  GeneratedTurn,
  RequestResult,
  TerminalOutcome,
  WireValue,
} from "./types.js";

export type AnyEffectCall = {
  [K in EffectName]: EffectCall<K>;
}[EffectName];

export class EffectProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EffectProtocolError";
  }
}

export class DeclaredEffectFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeclaredEffectFailure";
  }
}

export interface EffectLedger {
  commitResult(call: AnyEffectCall, result: string): string;
  committedResult(call: AnyEffectCall): string | null;
  recordAttempt(call: AnyEffectCall): number;
  recordCallback(sessionId: string, outcome: TerminalOutcome): void;
  recordExecution(call: AnyEffectCall): void;
  recordVisibleEffect(call: AnyEffectCall): void;
}

export async function executeScriptedEffect<K extends EffectName>(
  ledger: EffectLedger,
  call: EffectCall<K>,
): Promise<EffectOutput<K>> {
  const effectCall = call as AnyEffectCall;
  const attempt = ledger.recordAttempt(effectCall);
  ledger.recordVisibleEffect(effectCall);
  const committed = ledger.committedResult(effectCall);
  if (committed !== null) return parseEffectOutput(call, committed);

  ledger.recordExecution(effectCall);
  const output = await evaluateScriptedEffect(ledger, effectCall);
  const result = ledger.commitResult(effectCall, stringifyEffectOutput(output));

  if (effectCall.name === "generate" && effectCall.input.scenario.kind === "retry-once") {
    if (attempt === 1) {
      throw new Error("Injected failure after the visible generation effect.");
    }
  }

  return parseEffectOutput(call, result);
}

async function evaluateScriptedEffect(
  ledger: EffectLedger,
  effectCall: AnyEffectCall,
): Promise<EffectOutput<EffectName>> {
  switch (effectCall.name) {
    case "initialize-session":
      return { continuationToken: effectCall.input.continuationToken };
    case "deliver-input":
      return effectCall.input;
    case "execute-tool": {
      if (effectCall.input.request.name === "fail") {
        throw new DeclaredEffectFailure("Injected terminal tool failure.");
      }
      const result: RequestResult = {
        isError: false,
        requestId: effectCall.input.request.requestId,
        value: effectCall.input.request.input,
      };
      return result;
    }
    case "finalize-session":
      ledger.recordCallback(effectCall.input.sessionId, effectCall.input.outcome);
      return { recorded: true };
    case "generate": {
      if (effectCall.input.scenario.kind === "infrastructure-fail") {
        throw new Error("Injected effect infrastructure failure.");
      }
      if (effectCall.input.scenario.kind === "fail") {
        throw new DeclaredEffectFailure("Injected terminal generation failure.");
      }
      if (
        effectCall.input.scenario.kind === "echo" &&
        (effectCall.input.scenario.delayMs ?? 0) > 0
      ) {
        await delay(effectCall.input.scenario.delayMs ?? 0);
      }
      return createGeneratedTurn(effectCall);
    }
  }
}

function parseEffectOutput<K extends EffectName>(
  call: EffectCall<K>,
  value: string,
): EffectOutput<K> {
  try {
    const parsed = parseJsonWireValue(value);
    assertEffectOutput(call as AnyEffectCall, parsed);
    return parsed as EffectOutput<K>;
  } catch (error) {
    if (error instanceof EffectProtocolError) throw error;
    throw new EffectProtocolError("Committed effect result is not valid JSON.", { cause: error });
  }
}

function assertEffectOutput(call: AnyEffectCall, value: WireValue): void {
  const record = isWireRecord(value) ? value : null;
  switch (call.name) {
    case "initialize-session":
      if (record?.continuationToken === call.input.continuationToken) return;
      break;
    case "deliver-input":
      if (matchesDelivery(value, call.input)) return;
      break;
    case "execute-tool":
      if (
        record !== null &&
        record.requestId === call.input.request.requestId &&
        typeof record.isError === "boolean" &&
        "value" in record
      ) {
        return;
      }
      break;
    case "finalize-session":
      if (record?.recorded === true) return;
      break;
    case "generate":
      if (isGeneratedTurn(value)) return;
      break;
  }
  throw new EffectProtocolError(`Committed "${call.name}" result does not match its effect call.`);
}

function matchesDelivery(value: WireValue, expected: Delivery): boolean {
  if (!isWireRecord(value) || typeof value.deliveryId !== "string") return false;
  if (value.kind === "message") {
    return (
      expected.kind === "message" &&
      value.deliveryId === expected.deliveryId &&
      value.message === expected.message
    );
  }
  return (
    value.kind === "approval" &&
    expected.kind === "approval" &&
    value.deliveryId === expected.deliveryId &&
    value.approved === expected.approved &&
    value.requestId === expected.requestId
  );
}

function isGeneratedTurn(value: WireValue): boolean {
  if (!isWireRecord(value)) return false;
  const assistant = value.assistant;
  if (assistant === undefined || !isWireRecord(assistant)) return false;
  const requestIds = assistant.requestIds;
  const requests = value.requests;
  if (
    assistant.role !== "assistant" ||
    typeof assistant.content !== "string" ||
    !isStringArray(requestIds) ||
    !Array.isArray(requests) ||
    !requests.every(isLoopRequest) ||
    requestIds.length !== requests.length ||
    requestIds.some((requestId, index) => {
      const request = requests[index];
      return !isWireRecord(request) || request.requestId !== requestId;
    })
  ) {
    return false;
  }
  const finish = value.finish;
  if (finish === null) return requests.length > 0;
  return (
    requests.length === 0 && finish !== undefined && isWireRecord(finish) && "output" in finish
  );
}

function isLoopRequest(value: WireValue): boolean {
  if (!isWireRecord(value) || typeof value.requestId !== "string") return false;
  if (value.kind === "subagent") {
    return typeof value.delayMs === "number" && typeof value.message === "string";
  }
  return (
    (value.kind === "tool" || value.kind === "approval") &&
    typeof value.name === "string" &&
    "input" in value
  );
}

function isStringArray(value: WireValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWireRecord(value: WireValue): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyEffectOutput(output: EffectOutput<EffectName>): string {
  const value = JSON.stringify(output);
  if (value === undefined) {
    throw new EffectProtocolError("Scripted effect returned a non-JSON result.");
  }
  return value;
}

function createGeneratedTurn(
  call: Extract<AnyEffectCall, { readonly name: "generate" }>,
): GeneratedTurn {
  const message = lastUserMessage(call.input.history);
  const results = resultsAfterLastUser(call.input.history);
  const scenario = call.input.scenario;

  if (scenario.kind === "fail") {
    throw new Error("Failure scenarios cannot produce a successful generated turn.");
  }
  if (scenario.kind === "infrastructure-fail") {
    throw new Error("Infrastructure failure scenarios cannot produce a generated turn.");
  }

  if ((scenario.kind === "tool" || scenario.kind === "tool-fail") && results.length === 0) {
    const requestId = `${call.id}:tool`;
    return {
      assistant: { content: "Calling the echo tool.", requestIds: [requestId], role: "assistant" },
      finish: null,
      requests: [
        {
          input: message,
          kind: "tool",
          name: scenario.kind === "tool-fail" ? "fail" : "echo",
          requestId,
        },
      ],
    };
  }

  if (scenario.kind === "approval" && results.length === 0) {
    const requestId = `${call.id}:approval`;
    return {
      assistant: {
        content: "Waiting for approval to call the echo tool.",
        requestIds: [requestId],
        role: "assistant",
      },
      finish: null,
      requests: [{ input: message, kind: "approval", name: "echo", requestId }],
    };
  }

  if (scenario.kind === "children" && results.length === 0) {
    const requests = scenario.children.map((child, index) => ({
      delayMs: child.delayMs,
      kind: "subagent" as const,
      message: child.message,
      requestId: `${call.id}:child:${String(index)}`,
    }));
    return {
      assistant: {
        content: "Delegating child work.",
        requestIds: requests.map((request) => request.requestId),
        role: "assistant",
      },
      finish: null,
      requests,
    };
  }

  const output = resolveOutput(scenario.kind, message, results);
  return {
    assistant: { content: String(output), requestIds: [], role: "assistant" },
    finish: { output },
    requests: [],
  };
}

function resolveOutput(
  scenario: "approval" | "children" | "echo" | "retry-once" | "tool" | "tool-fail",
  message: string,
  results: readonly RequestResult[],
): WireValue {
  switch (scenario) {
    case "echo":
      return `echo:${message}`;
    case "retry-once":
      return `retry:${message}`;
    case "tool":
    case "tool-fail":
      return results[0]?.value ?? "missing tool result";
    case "approval":
      return results[0]?.isError === true ? "approval:denied" : (results[0]?.value ?? null);
    case "children":
      return results.map((result) => result.value);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
