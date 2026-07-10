import { defineSignal } from "@temporalio/workflow";

import type {
  Delivery,
  DriverUpdate,
  EffectCall,
  EffectName,
  EffectResult,
  EventRecord,
  ExecutionId,
  SessionProgramInput,
  TerminalOutcome,
  TurnOutcome,
  TurnProgramInput,
} from "../types.js";

export const TEMPORAL_SESSION_WORKFLOW = "temporalSessionWorkflow";
export const TEMPORAL_TURN_WORKFLOW = "temporalTurnWorkflow";

export const TEMPORAL_DELIVERY_SIGNAL = "eve.loop.delivery";
export const TEMPORAL_CHILD_UPDATE_SIGNAL = "eve.loop.child-update";
export const TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL = "eve.loop.child-acknowledged";

export const temporalDeliverySignal = defineSignal<[Delivery]>(TEMPORAL_DELIVERY_SIGNAL);
export const temporalChildUpdateSignal = defineSignal<
  [{ readonly childWorkflowId: string; readonly update: DriverUpdate }]
>(TEMPORAL_CHILD_UPDATE_SIGNAL);
export const temporalChildAcknowledgedSignal = defineSignal<[number]>(
  TEMPORAL_CHILD_ACKNOWLEDGED_SIGNAL,
);

export interface TemporalActivities {
  appendEvents(events: readonly EventRecord[]): Promise<void>;
  effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>>;
}

export interface TemporalSessionWorkflowInput {
  readonly executionId: ExecutionId;
  readonly input: SessionProgramInput;
  readonly kind: "session";
  readonly routingIntent: "pinned";
  readonly taskQueue: string;
}

export interface TemporalTurnWorkflowInput {
  readonly executionId: ExecutionId;
  readonly input: TurnProgramInput;
  readonly kind: "turn";
  readonly routingIntent: "latest-compatible";
  readonly taskQueue: string;
}

export type TemporalSessionWorkflow = (
  input: TemporalSessionWorkflowInput,
) => Promise<TerminalOutcome>;

export type TemporalTurnWorkflow = (input: TemporalTurnWorkflowInput) => Promise<TurnOutcome>;
