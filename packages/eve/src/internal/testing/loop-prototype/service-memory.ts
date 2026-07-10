import type { PrototypeService } from "./service-contract.js";
import {
  type AnyEffectCall,
  type EffectLedger,
  EffectProtocolError,
  executeScriptedEffect,
} from "./service-effects.js";
import type {
  EffectCall,
  EffectName,
  EffectOutput,
  EventLogId,
  EventRecord,
  TerminalOutcome,
} from "./types.js";

export class MemoryPrototypeService implements PrototypeService, EffectLedger {
  readonly #attempts = new Map<string, number>();
  readonly #callbacks = new Map<string, TerminalOutcome>();
  readonly #effectResults = new Map<string, string>();
  readonly #events = new Map<string, EventRecord>();
  readonly #executions = new Map<string, number>();
  readonly #visibleEffects = new Map<string, string>();

  async append(events: readonly EventRecord[]): Promise<void> {
    for (const event of events) appendEvent(this.#events, event);
  }

  attemptCount(operationId: string): number {
    return this.#attempts.get(operationId) ?? 0;
  }

  callback(sessionId: string): TerminalOutcome | null {
    return this.#callbacks.get(sessionId) ?? null;
  }

  commitResult(call: AnyEffectCall, result: string): string {
    const committed = this.#effectResults.get(call.id);
    if (committed !== undefined) {
      if (committed !== result) {
        throw new EffectProtocolError(
          `Effect result "${call.id}" was retried with different bytes.`,
        );
      }
      return committed;
    }
    this.#effectResults.set(call.id, result);
    return result;
  }

  committedResult(call: AnyEffectCall): string | null {
    return this.#effectResults.get(call.id) ?? null;
  }

  async close(): Promise<void> {}

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectOutput<K>> {
    return await executeScriptedEffect(this, call);
  }

  executionCount(operationId: string): number {
    return this.#executions.get(operationId) ?? 0;
  }

  recordAttempt(call: AnyEffectCall): number {
    const count = (this.#attempts.get(call.id) ?? 0) + 1;
    this.#attempts.set(call.id, count);
    return count;
  }

  recordCallback(sessionId: string, outcome: TerminalOutcome): void {
    const existing = this.#callbacks.get(sessionId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(outcome)) {
      throw new EffectProtocolError(`Conflicting callback for session "${sessionId}".`);
    }
    this.#callbacks.set(sessionId, outcome);
  }

  recordExecution(call: AnyEffectCall): void {
    this.#executions.set(call.id, this.executionCount(call.id) + 1);
  }

  recordVisibleEffect(call: AnyEffectCall): void {
    const value = JSON.stringify({ input: call.input, name: call.name });
    const existing = this.#visibleEffects.get(call.id);
    if (existing !== undefined && existing !== value) {
      throw new EffectProtocolError(`Conflicting visible effect for operation "${call.id}".`);
    }
    this.#visibleEffects.set(call.id, value);
  }

  async read(logId: EventLogId): Promise<readonly EventRecord[]> {
    return [...this.#events.values()]
      .filter((event) => event.logId === logId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  visibleEffectCount(operationId: string): number {
    return this.#visibleEffects.has(operationId) ? 1 : 0;
  }
}

function appendEvent(events: Map<string, EventRecord>, event: EventRecord): void {
  const existing = events.get(event.id);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`Event "${event.id}" was retried with different bytes.`);
    }
    return;
  }

  for (const current of events.values()) {
    if (current.logId === event.logId && current.sequence === event.sequence) {
      throw new Error(
        `Event log "${event.logId}" already contains sequence ${String(event.sequence)}.`,
      );
    }
  }
  events.set(event.id, event);
}
