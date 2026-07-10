import type { ChildWorkflowHandle } from "@temporalio/workflow";
import {
  condition,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
} from "@temporalio/workflow";

import { executionId } from "../ids.js";
import type {
  AnyChildHandle,
  ChildHandle,
  ChildKind,
  ChildNotice,
  ChildOutput,
  Delivery,
  DriverUpdate,
  EffectCall,
  EffectName,
  EffectResult,
  EventRecord,
  ExecutionId,
  LoopBackend,
  ReceiveWait,
  SessionChildSpec,
  TerminalOutcome,
  TurnChildSpec,
} from "../types.js";
import {
  TEMPORAL_SESSION_WORKFLOW,
  TEMPORAL_TURN_WORKFLOW,
  temporalChildAcknowledgedSignal,
  temporalChildUpdateSignal,
  temporalDeliverySignal,
} from "./contracts.js";
import type {
  TemporalActivities,
  TemporalSessionWorkflow,
  TemporalTurnWorkflow,
} from "./contracts.js";

type TemporalBackendContext =
  | {
      readonly executionId: ExecutionId;
      readonly kind: "session";
      readonly taskQueue: string;
    }
  | {
      readonly executionId: ExecutionId;
      readonly kind: "turn";
      readonly parentWorkflowId: string;
      readonly taskQueue: string;
    };

type ChildTerminalState<Output> =
  | { readonly kind: "pending" }
  | { readonly kind: "resolved"; readonly output: Output }
  | { readonly error: unknown; readonly kind: "rejected" };

const temporalChildTracker: unique symbol = Symbol("temporal-child-tracker");

type TrackedChildWorkflow<Output> = ChildWorkflowHandle<() => Promise<Output>>;

class TemporalChildTracker<Output> {
  #terminal: ChildTerminalState<Output> = { kind: "pending" };
  readonly workflow: TrackedChildWorkflow<Output>;

  constructor(workflow: TrackedChildWorkflow<Output>) {
    this.workflow = workflow;
    void workflow.result().then(
      (output) => {
        this.#terminal = { kind: "resolved", output };
      },
      (error: unknown) => {
        this.#terminal = { error, kind: "rejected" };
      },
    );
  }

  get settled(): boolean {
    return this.#terminal.kind !== "pending";
  }

  result(): Output {
    switch (this.#terminal.kind) {
      case "pending":
        throw new Error(`Child Workflow "${this.workflow.workflowId}" has not completed.`);
      case "rejected":
        throw this.#terminal.error;
      case "resolved":
        return this.#terminal.output;
    }
  }
}

interface TemporalChildHandle<Kind extends ChildKind> extends ChildHandle<Kind> {
  readonly [temporalChildTracker]: TemporalChildTracker<ChildOutput<Kind>>;
}

export class TemporalLoopBackend implements LoopBackend {
  readonly #acknowledgedRevisions = new Set<number>();
  readonly #childUpdates = new Map<string, DriverUpdate[]>();
  readonly #context: TemporalBackendContext;
  readonly #deliveries: Delivery[] = [];
  readonly executionId: ExecutionId;

  constructor(context: TemporalBackendContext) {
    this.#context = context;
    this.executionId = context.executionId;

    setHandler(temporalDeliverySignal, (delivery) => {
      this.#deliveries.push(delivery);
    });
    setHandler(temporalChildUpdateSignal, ({ childWorkflowId, update }) => {
      const updates = this.#childUpdates.get(childWorkflowId) ?? [];
      updates.push(update);
      this.#childUpdates.set(childWorkflowId, updates);
    });
    setHandler(temporalChildAcknowledgedSignal, (revision) => {
      this.#acknowledgedRevisions.add(revision);
    });
  }

  async acknowledgeChildUpdate(handle: ChildHandle<"turn">, revision: number): Promise<void> {
    if (!isTemporalChildHandle(handle)) {
      throw new TypeError(`Child "${handle.id}" is not a Temporal child.`);
    }
    await handle[temporalChildTracker].workflow.signal(temporalChildAcknowledgedSignal, revision);
  }

  async appendEvents(events: readonly EventRecord[]): Promise<void> {
    await this.#activities(2).appendEvents(events);
  }

  async checkpoint(checkpoint: Parameters<LoopBackend["checkpoint"]>[0]): Promise<void> {
    if (this.#context.kind === "session") return;

    const parent = getExternalWorkflowHandle(this.#context.parentWorkflowId);
    await parent.signal(temporalChildUpdateSignal, {
      childWorkflowId: this.executionId,
      update: { checkpoint, kind: "checkpoint" },
    });
    await condition(() => this.#acknowledgedRevisions.has(checkpoint.revision));
    this.#acknowledgedRevisions.delete(checkpoint.revision);
  }

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>> {
    return await this.#activities(call.retry.maxAttempts).effect(call);
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {}

  async receive(_wait: ReceiveWait): Promise<Delivery> {
    await condition(() => this.#deliveries.length > 0);
    const delivery = this.#deliveries.shift();
    if (delivery === undefined) throw new Error("Temporal delivery disappeared.");
    return delivery;
  }

  async startSessionChild(spec: SessionChildSpec): Promise<ChildHandle<"session">> {
    const workflow = await startChild<TemporalSessionWorkflow>(TEMPORAL_SESSION_WORKFLOW, {
      args: [
        {
          executionId: executionId(spec.id),
          input: { ...spec.input, eventLogId: spec.eventLog.id },
          kind: "session",
          routingIntent: spec.version,
          taskQueue: this.#context.taskQueue,
        },
      ],
      memo: { eveRoutingIntent: spec.version },
      taskQueue: this.#context.taskQueue,
      workflowId: spec.id,
    });
    return createTemporalChildHandle("session", spec.id, workflow);
  }

  async startTurnChild(spec: TurnChildSpec): Promise<ChildHandle<"turn">> {
    const workflow = await startChild<TemporalTurnWorkflow>(TEMPORAL_TURN_WORKFLOW, {
      args: [
        {
          executionId: executionId(spec.id),
          input: spec.input,
          kind: "turn",
          routingIntent: spec.version,
          taskQueue: this.#context.taskQueue,
        },
      ],
      memo: { eveRoutingIntent: spec.version },
      taskQueue: this.#context.taskQueue,
      workflowId: spec.id,
    });
    return createTemporalChildHandle("turn", spec.id, workflow);
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
    if (!isTemporalChildHandle(handle)) {
      throw new TypeError(`Child "${handle.id}" is not a Temporal child.`);
    }

    await condition(() => this.#hasChildUpdate(handle.id) || handle[temporalChildTracker].settled);
    const update = this.#takeChildUpdate(handle.id);
    if (update !== null) return { kind: "update", update };
    return { kind: "terminal", output: handle[temporalChildTracker].result() };
  }

  async #waitForSessionChild(handle: ChildHandle<"session">): Promise<ChildNotice<"session">> {
    if (!isTemporalChildHandle(handle)) {
      throw new TypeError(`Child "${handle.id}" is not a Temporal child.`);
    }

    await condition(() => this.#hasChildUpdate(handle.id) || handle[temporalChildTracker].settled);
    if (this.#takeChildUpdate(handle.id) !== null) {
      throw new Error(`Session child "${handle.id}" reported a borrowed checkpoint.`);
    }
    return { kind: "terminal", output: handle[temporalChildTracker].result() };
  }

  #activities(maximumAttempts: number): TemporalActivities {
    return proxyActivities<TemporalActivities>({
      retry: {
        backoffCoefficient: 1,
        initialInterval: "1 millisecond",
        maximumAttempts,
      },
      startToCloseTimeout: "30 seconds",
      taskQueue: this.#context.taskQueue,
    });
  }

  #hasChildUpdate(childWorkflowId: string): boolean {
    return (this.#childUpdates.get(childWorkflowId)?.length ?? 0) > 0;
  }

  #takeChildUpdate(childWorkflowId: string): DriverUpdate | null {
    const updates = this.#childUpdates.get(childWorkflowId);
    if (updates === undefined) return null;
    const update = updates.shift() ?? null;
    if (updates.length === 0) this.#childUpdates.delete(childWorkflowId);
    return update;
  }
}

function createTemporalChildHandle<Kind extends ChildKind>(
  kind: Kind,
  id: ChildHandle<Kind>["id"],
  workflow: TrackedChildWorkflow<ChildOutput<Kind>>,
): TemporalChildHandle<Kind> {
  return {
    [temporalChildTracker]: new TemporalChildTracker(workflow),
    backendRunId: workflow.firstExecutionRunId,
    id,
    kind,
  };
}

function isTemporalChildHandle<Kind extends ChildKind>(
  handle: ChildHandle<Kind>,
): handle is TemporalChildHandle<Kind> {
  return temporalChildTracker in handle;
}
