import {
  defineHook,
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";

import { executionId } from "../ids.js";
import { runSession, runTurn } from "../programs.js";
import { DeclaredEffectFailure, EffectProtocolError, SqlitePrototypeService } from "../service.js";
import type {
  AnyChildHandle,
  ChildHandle,
  ChildId,
  ChildNotice,
  Delivery,
  DriverUpdate,
  EffectCall,
  EffectName,
  EffectResult,
  EventRecord,
  ExecutionId,
  LoopBackend,
  ReceiveWait,
  SessionCheckpoint,
  SessionChildSpec,
  SessionProgramInput,
  TerminalOutcome,
  TurnChildSpec,
  TurnOutcome,
} from "../types.js";

export interface WorkflowEventEnvelope {
  readonly event: EventRecord;
  readonly kind: "prototype-event";
}

interface WorkflowSessionInput {
  readonly databasePath: string;
  readonly executionId: ExecutionId;
  readonly parent:
    | { readonly kind: "root" }
    | {
        readonly childId: SessionChildSpec["id"];
        readonly kind: "session-child";
        readonly noticeToken: string;
      };
  readonly programInput: SessionProgramInput;
  /**
   * Records the intended production routing policy in durable input. The local
   * World has one deployment, so it cannot prove that deployment routing.
   */
  readonly routingIntent: "pinned";
}

interface WorkflowTurnInput {
  readonly databasePath: string;
  readonly eventWritable: WritableStream<WorkflowEventEnvelope>;
  readonly executionId: ExecutionId;
  readonly parent: {
    readonly childId: TurnChildSpec["id"];
    readonly kind: "turn-child";
    readonly noticeToken: string;
  };
  readonly programInput: TurnChildSpec["input"];
  /**
   * Records the intended production routing policy in durable input. The local
   * World has one deployment, so it cannot prove that deployment routing.
   */
  readonly routingIntent: "latest-compatible";
}

type WorkflowParent = WorkflowSessionInput["parent"] | WorkflowTurnInput["parent"];

type WorkflowChildNotice =
  | {
      readonly ackToken: string;
      readonly backendRunId: string;
      readonly childId: TurnChildSpec["id"];
      readonly kind: "checkpoint";
      readonly update: DriverUpdate;
    }
  | {
      readonly backendRunId: string;
      readonly childId: ChildId;
      readonly kind: "settled";
    };

interface CheckpointAck {
  readonly childId: TurnChildSpec["id"];
  readonly kind: "checkpoint-ack";
  readonly revision: number;
}

interface ChildChannelBase {
  readonly hook: Hook<WorkflowChildNotice>;
  readonly iterator: AsyncIterator<WorkflowChildNotice>;
}

interface TurnChildChannel extends ChildChannelBase {
  readonly handle: ChildHandle<"turn">;
  readonly kind: "turn";
  readonly pendingAcks: Map<number, string>;
}

interface SessionChildChannel extends ChildChannelBase {
  readonly handle: ChildHandle<"session">;
  readonly kind: "session";
}

type ChildChannel = TurnChildChannel | SessionChildChannel;

const deliveryHook = defineHook<Delivery>();
const childNoticeHook = defineHook<WorkflowChildNotice>();
const checkpointAckHook = defineHook<CheckpointAck>();

export async function workflowSession(input: WorkflowSessionInput): Promise<TerminalOutcome> {
  "use workflow";

  const delivery = deliveryHook.create({ token: input.programInput.continuationToken });
  const deliveryIterator = delivery[Symbol.asyncIterator]();
  await claimHook(delivery);

  const backend = new WorkflowLoopBackend({
    backendRunId: getWorkflowMetadata().workflowRunId,
    databasePath: input.databasePath,
    delivery: { hook: delivery, iterator: deliveryIterator },
    eventWritable: getWritable<WorkflowEventEnvelope>(),
    executionId: input.executionId,
    parent: input.parent,
  });

  try {
    return await runSession(backend, input.programInput);
  } finally {
    if (input.parent.kind === "session-child") {
      await sendControlStep(input.parent.noticeToken, {
        backendRunId: getWorkflowMetadata().workflowRunId,
        childId: input.parent.childId,
        kind: "settled",
      });
    }
    await backend.dispose();
  }
}

export async function workflowTurn(input: WorkflowTurnInput): Promise<TurnOutcome> {
  "use workflow";

  const backend = new WorkflowLoopBackend({
    backendRunId: getWorkflowMetadata().workflowRunId,
    databasePath: input.databasePath,
    eventWritable: input.eventWritable,
    executionId: input.executionId,
    parent: input.parent,
  });

  try {
    return await runTurn(backend, input.programInput);
  } finally {
    await sendControlStep(input.parent.noticeToken, {
      backendRunId: getWorkflowMetadata().workflowRunId,
      childId: input.parent.childId,
      kind: "settled",
    });
    await backend.dispose();
  }
}

class WorkflowLoopBackend implements LoopBackend {
  readonly executionId: LoopBackend["executionId"];

  readonly #backendRunId: string;
  readonly #children = new Map<string, ChildChannel>();
  readonly #databasePath: string;
  readonly #delivery:
    | { readonly hook: Hook<Delivery>; readonly iterator: AsyncIterator<Delivery> }
    | undefined;
  readonly #eventWritable: WritableStream<WorkflowEventEnvelope>;
  readonly #parent: WorkflowParent;

  constructor(input: {
    readonly backendRunId: string;
    readonly databasePath: string;
    readonly delivery?: {
      readonly hook: Hook<Delivery>;
      readonly iterator: AsyncIterator<Delivery>;
    };
    readonly eventWritable: WritableStream<WorkflowEventEnvelope>;
    readonly executionId: LoopBackend["executionId"];
    readonly parent: WorkflowParent;
  }) {
    this.#backendRunId = input.backendRunId;
    this.#databasePath = input.databasePath;
    this.#delivery = input.delivery;
    this.#eventWritable = input.eventWritable;
    this.executionId = input.executionId;
    this.#parent = input.parent;
  }

  async acknowledgeChildUpdate(handle: ChildHandle<"turn">, revision: number): Promise<void> {
    const child = this.#requireTurnChild(handle);

    const token = child.pendingAcks.get(revision);
    if (token === undefined) {
      throw new Error(
        `Turn child "${child.handle.id}" has no pending checkpoint revision ${String(revision)}.`,
      );
    }

    await sendControlStep(token, {
      childId: child.handle.id,
      kind: "checkpoint-ack",
      revision,
    });
    child.pendingAcks.delete(revision);
  }

  async appendEvents(events: readonly EventRecord[]): Promise<void> {
    await appendEventsStep(this.#databasePath, this.#eventWritable, events);
  }

  async checkpoint(checkpoint: SessionCheckpoint): Promise<void> {
    await recordCheckpointStep(checkpoint);

    if (this.#parent.kind !== "turn-child") return;

    const ackToken = `${this.#backendRunId}:checkpoint:${String(checkpoint.revision)}:ack`;
    const ack = checkpointAckHook.create({ token: ackToken });
    await claimHook(ack);

    try {
      await sendControlStep(this.#parent.noticeToken, {
        ackToken,
        backendRunId: this.#backendRunId,
        childId: this.#parent.childId,
        kind: "checkpoint",
        update: { checkpoint, kind: "checkpoint" },
      });
      const received = await ack;
      if (
        received.kind !== "checkpoint-ack" ||
        received.childId !== this.#parent.childId ||
        received.revision !== checkpoint.revision
      ) {
        throw new Error(
          `Turn checkpoint revision ${String(checkpoint.revision)} received a bad ack.`,
        );
      }
    } finally {
      ack.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.#delivery !== undefined) {
      await closeHook(this.#delivery.hook, this.#delivery.iterator);
    }

    for (const child of this.#children.values()) {
      await closeHook(child.hook, child.iterator);
    }
    this.#children.clear();
  }

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>> {
    return await runEffectStep(this.#databasePath, call);
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {}

  async receive(_wait: ReceiveWait): Promise<Delivery> {
    if (this.#delivery === undefined) {
      throw new Error("Turn workflows do not own the public delivery hook.");
    }

    const next = await this.#delivery.iterator.next();
    if (next.done) throw new Error("Public delivery hook closed while the session was parked.");
    return next.value;
  }

  async startSessionChild(spec: SessionChildSpec): Promise<ChildHandle<"session">> {
    if (this.#parent.kind !== "turn-child") {
      throw new Error("Only a turn workflow can start a delegated session.");
    }

    const control = await this.#openChildControl(spec.id);
    try {
      const started = await startSessionChildStep({
        databasePath: this.#databasePath,
        executionId: executionId(spec.id),
        parent: {
          childId: spec.id,
          kind: "session-child",
          noticeToken: control.hook.token,
        },
        programInput: { ...spec.input, eventLogId: spec.eventLog.id },
        routingIntent: spec.version,
      });
      const handle: ChildHandle<"session"> = {
        backendRunId: started.backendRunId,
        id: spec.id,
        kind: "session",
      };
      this.#children.set(handle.backendRunId, {
        handle,
        hook: control.hook,
        iterator: control.iterator,
        kind: "session",
      });
      return handle;
    } catch (error) {
      await closeHook(control.hook, control.iterator);
      throw error;
    }
  }

  async startTurnChild(spec: TurnChildSpec): Promise<ChildHandle<"turn">> {
    if (this.#parent.kind === "turn-child") {
      throw new Error("A turn workflow cannot start another turn workflow.");
    }

    const control = await this.#openChildControl(spec.id);
    try {
      const started = await startTurnChildStep({
        databasePath: this.#databasePath,
        eventWritable: this.#eventWritable,
        executionId: executionId(spec.id),
        parent: {
          childId: spec.id,
          kind: "turn-child",
          noticeToken: control.hook.token,
        },
        programInput: spec.input,
        routingIntent: spec.version,
      });
      const handle: ChildHandle<"turn"> = {
        backendRunId: started.backendRunId,
        id: spec.id,
        kind: "turn",
      };
      this.#children.set(handle.backendRunId, {
        handle,
        hook: control.hook,
        iterator: control.iterator,
        kind: "turn",
        pendingAcks: new Map(),
      });
      return handle;
    } catch (error) {
      await closeHook(control.hook, control.iterator);
      throw error;
    }
  }

  async waitForChild(handle: ChildHandle<"session">): Promise<ChildNotice<"session">>;
  async waitForChild(handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">>;
  async waitForChild(
    handle: AnyChildHandle,
  ): Promise<ChildNotice<"session"> | ChildNotice<"turn">> {
    if (handle.kind === "turn") return await this.#waitForTurnChild(handle);
    return await this.#waitForSessionChild(handle);
  }

  async #waitForTurnChild(handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">> {
    const child = this.#requireTurnChild(handle);
    const notice = await this.#nextChildNotice(child);

    if (notice.kind === "checkpoint") {
      child.pendingAcks.set(notice.update.checkpoint.revision, notice.ackToken);
      return { kind: "update", update: notice.update };
    }

    try {
      return {
        kind: "terminal",
        output: await awaitTurnChildCompletionStep(handle.backendRunId),
      };
    } finally {
      await this.#closeChild(child);
    }
  }

  async #waitForSessionChild(handle: ChildHandle<"session">): Promise<ChildNotice<"session">> {
    const child = this.#requireSessionChild(handle);
    const notice = await this.#nextChildNotice(child);
    if (notice.kind === "checkpoint") {
      throw new Error(`Session child "${handle.id}" reported a borrowed checkpoint.`);
    }

    try {
      return {
        kind: "terminal",
        output: await awaitSessionChildCompletionStep(handle.backendRunId),
      };
    } finally {
      await this.#closeChild(child);
    }
  }

  async #nextChildNotice(child: ChildChannel): Promise<WorkflowChildNotice> {
    const next = await child.iterator.next();
    if (next.done) throw new Error(`Child "${child.handle.id}" closed its notice hook early.`);

    const notice = next.value;
    if (notice.childId !== child.handle.id || notice.backendRunId !== child.handle.backendRunId) {
      throw new Error(`Child "${child.handle.id}" sent a notice with mismatched identity.`);
    }
    return notice;
  }

  async #closeChild(child: ChildChannel): Promise<void> {
    this.#children.delete(child.handle.backendRunId);
    await closeHook(child.hook, child.iterator);
  }

  async #openChildControl(childId: ChildId): Promise<{
    readonly hook: Hook<WorkflowChildNotice>;
    readonly iterator: AsyncIterator<WorkflowChildNotice>;
  }> {
    const hook = childNoticeHook.create({
      token: `${this.#backendRunId}:child:${childId}:notices`,
    });
    const iterator = hook[Symbol.asyncIterator]();

    try {
      await claimHook(hook);
      return { hook, iterator };
    } catch (error) {
      await closeHook(hook, iterator);
      throw error;
    }
  }

  #requireTurnChild(handle: ChildHandle<"turn">): TurnChildChannel {
    const child = this.#children.get(handle.backendRunId);
    if (child === undefined || child.kind !== "turn" || child.handle.id !== handle.id) {
      throw new Error(`Unknown child "${handle.id}" with run "${handle.backendRunId}".`);
    }
    return child;
  }

  #requireSessionChild(handle: ChildHandle<"session">): SessionChildChannel {
    const child = this.#children.get(handle.backendRunId);
    if (child === undefined || child.kind !== "session" || child.handle.id !== handle.id) {
      throw new Error(`Unknown child "${handle.id}" with run "${handle.backendRunId}".`);
    }
    return child;
  }
}

export async function runEffectStep<K extends EffectName>(
  databasePath: string,
  call: EffectCall<K>,
): Promise<EffectResult<K>> {
  "use step";

  const service = new SqlitePrototypeService(databasePath);
  try {
    return { kind: "succeeded", output: await service.effect(call) };
  } catch (error) {
    if (error instanceof EffectProtocolError) throw new FatalError(error.message);
    const attempt = getStepMetadata().attempt;
    if (error instanceof DeclaredEffectFailure) {
      if (call.retry.idempotency === "none" || attempt >= call.retry.maxAttempts) {
        return { error: effectFailure(error), kind: "exhausted" };
      }
      throw error;
    }
    if (attempt >= call.retry.maxAttempts) throw new FatalError(effectFailure(error).message);
    throw error;
  } finally {
    await service.close();
  }
}

function effectFailure(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: "EFFECT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function appendEventsStep(
  databasePath: string,
  writable: WritableStream<WorkflowEventEnvelope>,
  events: readonly EventRecord[],
): Promise<void> {
  "use step";

  const service = new SqlitePrototypeService(databasePath);
  try {
    await service.append(events);
  } finally {
    await service.close();
  }

  const writer = writable.getWriter();
  try {
    for (const event of events) {
      await writer.write({ event, kind: "prototype-event" });
    }
  } finally {
    writer.releaseLock();
  }
}

export async function recordCheckpointStep(checkpoint: SessionCheckpoint): Promise<void> {
  "use step";

  if (checkpoint.version !== 1) {
    throw new FatalError(`Unsupported checkpoint version "${String(checkpoint.version)}".`);
  }
}

export async function startSessionChildStep(input: WorkflowSessionInput): Promise<{
  readonly backendRunId: string;
}> {
  "use step";

  const run = await start(workflowSession, [input]);
  return { backendRunId: run.runId };
}

export async function startTurnChildStep(input: WorkflowTurnInput): Promise<{
  readonly backendRunId: string;
}> {
  "use step";

  const run = await start(workflowTurn, [input]);
  return { backendRunId: run.runId };
}

export async function awaitSessionChildCompletionStep(
  backendRunId: string,
): Promise<TerminalOutcome> {
  "use step";

  return await getRun<TerminalOutcome>(backendRunId).returnValue;
}

export async function awaitTurnChildCompletionStep(backendRunId: string): Promise<TurnOutcome> {
  "use step";

  return await getRun<TurnOutcome>(backendRunId).returnValue;
}

export async function sendControlStep(
  token: string,
  payload: CheckpointAck | WorkflowChildNotice,
): Promise<void> {
  "use step";

  try {
    await resumeHook(token, payload);
  } catch (error) {
    if (getStepMetadata().attempt > 1 && isHookNotFoundError(error)) return;
    throw error;
  }
}

function isHookNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "HookNotFoundError"
  );
}

async function claimHook(hook: Hook<unknown>): Promise<void> {
  const conflict = await hook.getConflict();
  if (conflict !== null) {
    throw new Error(`Hook "${hook.token}" is already owned by run "${conflict.runId}".`);
  }
}

async function closeHook<T>(hook: Hook<T>, iterator: AsyncIterator<T>): Promise<void> {
  if (typeof iterator.return === "function") await iterator.return(undefined);
  hook.dispose();
}
