import type {
  EffectCall,
  EffectName,
  EffectOutput,
  PrototypeEventStore,
  TerminalOutcome,
} from "./types.js";

export interface PrototypeService extends PrototypeEventStore {
  attemptCount(operationId: string): number;
  callback(sessionId: string): TerminalOutcome | null;
  close(): Promise<void>;
  effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectOutput<K>>;
  executionCount(operationId: string): number;
  visibleEffectCount(operationId: string): number;
}
