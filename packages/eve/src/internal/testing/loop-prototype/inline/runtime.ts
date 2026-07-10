import { executionId } from "../ids.js";
import { runSession, runTurn } from "../programs.js";
import { DeclaredEffectFailure, MemoryPrototypeService } from "../service.js";
import type {
  AnyChildHandle,
  ChildHandle,
  ChildKind,
  ChildNotice,
  Delivery,
  EffectCall,
  EffectName,
  EffectResult,
  EventLogId,
  EventRecord,
  ExecutionId,
  LoopBackend,
  OperationId,
  PrototypeRun,
  PrototypeRuntime,
  ReceiveWait,
  SessionCheckpoint,
  SessionChildSpec,
  SessionId,
  SessionProgramInput,
  TerminalOutcome,
  TurnChildSpec,
} from "../types.js";
import { AsyncQueue, InlineRunStoppedError } from "./async-queue.js";

export { InlineRunStoppedError } from "./async-queue.js";

type ParentControl =
  | { readonly kind: "root" }
  | { readonly handle: InlineChildHandle<"turn">; readonly kind: "turn" };

interface StoppableQueue {
  stop(error: Error): void;
}

class InlineRunScope {
  readonly error = new InlineRunStoppedError();
  readonly #queues = new Set<StoppableQueue>();
  #stopped = false;

  assertRunning(): void {
    if (this.#stopped) throw this.error;
  }

  queue<Value>(): AsyncQueue<Value> {
    const queue = new AsyncQueue<Value>();
    this.#queues.add(queue);
    return queue;
  }

  release(queue: StoppableQueue): void {
    this.#queues.delete(queue);
  }

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.assertRunning();

    return await new Promise<Value>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        complete();
      };
      const stop = (): void => finish(() => reject(this.error));

      this.#stopListeners.add(stop);
      operation().then(
        (value) =>
          finish(() => {
            this.#stopListeners.delete(stop);
            resolve(value);
          }),
        (error: unknown) =>
          finish(() => {
            this.#stopListeners.delete(stop);
            reject(error);
          }),
      );
    });
  }

  stop(): void {
    if (this.#stopped) return;

    this.#stopped = true;
    for (const queue of this.#queues) queue.stop(this.error);
    this.#queues.clear();
    for (const stop of this.#stopListeners) stop();
    this.#stopListeners.clear();
  }

  readonly #stopListeners = new Set<() => void>();
}

class InlineChildHandle<Kind extends ChildKind> implements ChildHandle<Kind> {
  readonly backendRunId: string;
  readonly id: ChildHandle<Kind>["id"];
  readonly kind: Kind;
  readonly #acknowledgements: AsyncQueue<number>;
  readonly #notices: AsyncQueue<ChildNotice<Kind>>;
  readonly #ownerExecutionId: ExecutionId;
  readonly #scope: InlineRunScope;

  constructor(input: {
    readonly backendRunId: string;
    readonly id: ChildHandle<Kind>["id"];
    readonly kind: Kind;
    readonly ownerExecutionId: ExecutionId;
    readonly scope: InlineRunScope;
  }) {
    this.backendRunId = input.backendRunId;
    this.id = input.id;
    this.kind = input.kind;
    this.#ownerExecutionId = input.ownerExecutionId;
    this.#scope = input.scope;
    this.#acknowledgements = input.scope.queue();
    this.#notices = input.scope.queue();
  }

  acknowledge(revision: number): void {
    this.#acknowledgements.push(revision);
  }

  assertOwner(execution: ExecutionId): void {
    if (this.#ownerExecutionId !== execution) {
      throw new Error(`Child "${this.id}" does not belong to execution "${execution}".`);
    }
  }

  complete(notice: ChildNotice<Kind>): void {
    this.#notices.push(notice);
  }

  fail(error: unknown): void {
    this.#notices.stop(toError(error));
  }

  release(): void {
    this.#scope.release(this.#acknowledgements);
    this.#scope.release(this.#notices);
  }

  async nextNotice(): Promise<ChildNotice<Kind>> {
    return await this.#notices.shift();
  }

  async publishCheckpoint(
    this: InlineChildHandle<"turn">,
    checkpoint: SessionCheckpoint,
  ): Promise<void> {
    this.#notices.push({ kind: "update", update: { checkpoint, kind: "checkpoint" } });
    const acknowledgedRevision = await this.#acknowledgements.shift();
    if (acknowledgedRevision !== checkpoint.revision) {
      throw new Error(
        `Child "${this.id}" checkpoint ${String(checkpoint.revision)} was acknowledged as ${String(acknowledgedRevision)}.`,
      );
    }
  }
}

class InlineLoopBackend implements LoopBackend {
  readonly executionId: ExecutionId;
  readonly #deliveries: AsyncQueue<Delivery>;
  readonly #nextBackendRunId: () => string;
  readonly #parent: ParentControl;
  readonly #scope: InlineRunScope;
  readonly #service: MemoryPrototypeService;
  #checkpoint: SessionCheckpoint | null = null;

  constructor(input: {
    readonly executionId: ExecutionId;
    readonly nextBackendRunId: () => string;
    readonly parent: ParentControl;
    readonly scope: InlineRunScope;
    readonly service: MemoryPrototypeService;
  }) {
    this.executionId = input.executionId;
    this.#deliveries = input.scope.queue();
    this.#nextBackendRunId = input.nextBackendRunId;
    this.#parent = input.parent;
    this.#scope = input.scope;
    this.#service = input.service;
  }

  async acknowledgeChildUpdate(handle: ChildHandle<"turn">, revision: number): Promise<void> {
    const child = inlineChildHandle(handle);
    child.assertOwner(this.executionId);
    this.#scope.assertRunning();
    child.acknowledge(revision);
  }

  async appendEvents(events: readonly EventRecord[]): Promise<void> {
    await this.#scope.run(async () => {
      await this.#service.append(events);
    });
  }

  async checkpoint(checkpoint: SessionCheckpoint): Promise<void> {
    this.#scope.assertRunning();

    if (this.#parent.kind === "turn") {
      await this.#parent.handle.publishCheckpoint(checkpoint);
      return;
    }

    this.#checkpoint = checkpoint;
  }

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>> {
    return await this.#scope.run(async () => {
      try {
        return { kind: "succeeded", output: await this.#service.effect(call) };
      } catch (error) {
        if (error instanceof DeclaredEffectFailure) {
          return { error: effectFailure(error), kind: "exhausted" };
        }
        throw error;
      }
    });
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {
    this.#scope.assertRunning();
    if (this.#checkpoint?.state.phase !== "terminal") {
      throw new Error("Inline session finished without a terminal checkpoint.");
    }
  }

  async receive(_wait: ReceiveWait): Promise<Delivery> {
    this.#scope.assertRunning();
    return await this.#deliveries.shift();
  }

  async startSessionChild(spec: SessionChildSpec): Promise<ChildHandle<"session">> {
    this.#scope.assertRunning();
    const handle = new InlineChildHandle<"session">({
      backendRunId: this.#nextBackendRunId(),
      id: spec.id,
      kind: "session",
      ownerExecutionId: this.executionId,
      scope: this.#scope,
    });
    const backend = this.#childBackend(executionId(spec.id), { kind: "root" });

    void runSession(backend, { ...spec.input, eventLogId: spec.eventLog.id })
      .then(
        (output) => handle.complete({ kind: "terminal", output }),
        (error: unknown) => handle.fail(error),
      )
      .finally(() => backend.dispose());
    return handle;
  }

  async startTurnChild(spec: TurnChildSpec): Promise<ChildHandle<"turn">> {
    this.#scope.assertRunning();
    const handle = new InlineChildHandle<"turn">({
      backendRunId: this.#nextBackendRunId(),
      id: spec.id,
      kind: "turn",
      ownerExecutionId: this.executionId,
      scope: this.#scope,
    });
    const backend = this.#childBackend(executionId(spec.id), { handle, kind: "turn" });

    void runTurn(backend, spec.input)
      .then(
        (output) => handle.complete({ kind: "terminal", output }),
        (error: unknown) => handle.fail(error),
      )
      .finally(() => backend.dispose());
    return handle;
  }

  async waitForChild(handle: ChildHandle<"session">): Promise<ChildNotice<"session">>;
  async waitForChild(handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">>;
  async waitForChild(
    handle: AnyChildHandle,
  ): Promise<ChildNotice<"session"> | ChildNotice<"turn">> {
    if (handle.kind === "turn") return await this.#waitForChild(handle);
    return await this.#waitForChild(handle);
  }

  async #waitForChild<Kind extends ChildKind>(
    handle: ChildHandle<Kind>,
  ): Promise<ChildNotice<Kind>> {
    const child = inlineChildHandle(handle);
    child.assertOwner(this.executionId);
    this.#scope.assertRunning();
    try {
      const notice = await child.nextNotice();
      if (notice.kind === "terminal") child.release();
      return notice;
    } catch (error) {
      child.release();
      throw error;
    }
  }

  deliver(delivery: Delivery): void {
    this.#scope.assertRunning();
    this.#deliveries.push(delivery);
  }

  dispose(): void {
    this.#scope.release(this.#deliveries);
  }

  #childBackend(execution: ExecutionId, parent: ParentControl): InlineLoopBackend {
    return new InlineLoopBackend({
      executionId: execution,
      nextBackendRunId: this.#nextBackendRunId,
      parent,
      scope: this.#scope,
      service: this.#service,
    });
  }
}

class InlinePrototypeRun implements PrototypeRun {
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;
  readonly #backend: InlineLoopBackend;
  readonly #eventLogId: EventLogId;
  readonly #scope: InlineRunScope;
  readonly #service: MemoryPrototypeService;
  #settled = false;
  #stopped = false;

  constructor(input: {
    readonly backend: InlineLoopBackend;
    readonly backendRunId: string;
    readonly eventLogId: EventLogId;
    readonly result: Promise<TerminalOutcome>;
    readonly scope: InlineRunScope;
    readonly service: MemoryPrototypeService;
    readonly sessionId: SessionId;
  }) {
    this.#backend = input.backend;
    this.backendRunId = input.backendRunId;
    this.#eventLogId = input.eventLogId;
    this.result = input.result.finally(() => {
      this.#settled = true;
      this.#backend.dispose();
    });
    this.#scope = input.scope;
    this.#service = input.service;
    this.sessionId = input.sessionId;
  }

  async deliver(delivery: Delivery): Promise<void> {
    if (this.#stopped) throw this.#scope.error;
    if (this.#settled) throw new Error(`Inline run "${this.backendRunId}" is terminal.`);
    this.#backend.deliver(delivery);
  }

  async events(): Promise<readonly EventRecord[]> {
    return await this.#service.read(this.#eventLogId);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#scope.stop();
    try {
      await this.result;
    } catch (error) {
      if (error !== this.#scope.error) throw error;
    }
  }
}

export class InlinePrototypeRuntime implements PrototypeRuntime {
  readonly kind = "inline";
  readonly #runs = new Set<InlinePrototypeRun>();
  readonly #service = new MemoryPrototypeService();
  #closed = false;
  #nextRunOrdinal = 0;

  async attemptCount(id: OperationId): Promise<number> {
    return this.#service.attemptCount(id);
  }

  async callback(id: SessionId): Promise<TerminalOutcome | null> {
    return this.#service.callback(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;

    this.#closed = true;
    await Promise.all([...this.#runs].map(async (run) => await run.stop()));
    await this.#service.close();
  }

  async events(logId: EventLogId): Promise<readonly EventRecord[]> {
    return await this.#service.read(logId);
  }

  async executionCount(id: OperationId): Promise<number> {
    return this.#service.executionCount(id);
  }

  async start(input: SessionProgramInput): Promise<PrototypeRun> {
    if (this.#closed) throw new Error("Inline prototype runtime is closed.");

    const ordinal = this.#nextRunOrdinal++;
    const backendRunId = `inline:${String(ordinal)}`;
    const scope = new InlineRunScope();
    const backend = new InlineLoopBackend({
      executionId: executionId(`${input.sessionId}:execution:${String(ordinal)}`),
      nextBackendRunId: () => `inline:${String(this.#nextRunOrdinal++)}`,
      parent: { kind: "root" },
      scope,
      service: this.#service,
    });
    const result = runSession(backend, input);
    const run = new InlinePrototypeRun({
      backend,
      backendRunId,
      eventLogId: input.eventLogId,
      result,
      scope,
      service: this.#service,
      sessionId: input.sessionId,
    });
    this.#runs.add(run);
    void result.then(
      () => this.#runs.delete(run),
      () => this.#runs.delete(run),
    );
    return run;
  }

  async visibleEffectCount(id: OperationId): Promise<number> {
    return this.#service.visibleEffectCount(id);
  }
}

export function createInlinePrototypeRuntime(): Promise<PrototypeRuntime> {
  return Promise.resolve(new InlinePrototypeRuntime());
}

function effectFailure(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: "EFFECT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function inlineChildHandle<Kind extends ChildKind>(
  handle: ChildHandle<Kind>,
): InlineChildHandle<Kind> {
  if (!isInlineChildHandle(handle)) {
    throw new Error(`Child "${handle.id}" was not created by the inline backend.`);
  }
  return handle;
}

function isInlineChildHandle<Kind extends ChildKind>(
  handle: ChildHandle<Kind>,
): handle is InlineChildHandle<Kind> {
  return handle instanceof InlineChildHandle;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
