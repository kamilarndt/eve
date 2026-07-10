import { describe, expect, it } from "vitest";

import { eventLogId, executionId, sessionId } from "./ids.js";
import { runSession, runTurn } from "./programs.js";
import { EffectProtocolError, MemoryPrototypeService } from "./service.js";
import { emptyHistory } from "./transcript.js";
import type {
  AnyChildHandle,
  ChildHandle,
  ChildNotice,
  Delivery,
  EffectCall,
  EffectName,
  EffectResult,
  EventLogId,
  EventRecord,
  LoopBackend,
  ReceiveWait,
  SessionCheckpoint,
  SessionChildSpec,
  SessionProgramInput,
  TerminalOutcome,
  TurnChildSpec,
  TurnProgramInput,
  WireValue,
} from "./types.js";

describe("loop program protocol", () => {
  it("rejects a terminal checkpoint the parent never acknowledged", async () => {
    const backend = new TurnProtocolBackend("unpersisted-terminal");
    const input = sessionInput();

    await expect(runSession(backend, input)).rejects.toThrow(
      "does not match the last acknowledged checkpoint",
    );
  });

  it("rejects a child checkpoint that replaces the parent session", async () => {
    const backend = new TurnProtocolBackend("cross-session-update");

    await expect(runSession(backend, sessionInput())).rejects.toThrow(
      "changed parent-owned session identity",
    );
  });

  it("rejects a child checkpoint that rolls back the event cursor", async () => {
    const backend = new TurnProtocolBackend("event-sequence-rollback");

    await expect(runSession(backend, sessionInput())).rejects.toThrow(
      "rolled back the event sequence",
    );
  });

  it("rejects another child update after ownership returned to the parent", async () => {
    const backend = new TurnProtocolBackend("post-return-update");

    await expect(runSession(backend, sessionInput())).rejects.toThrow(
      "reported an update after returning checkpoint ownership",
    );
  });

  it("re-acknowledges an exact duplicate checkpoint update", async () => {
    const backend = new TurnProtocolBackend("duplicate-update");

    await expect(runSession(backend, sessionInput())).resolves.toMatchObject({
      kind: "completed",
    });
    expect(backend.acknowledgedRevisions).toHaveLength(2);
    expect(new Set(backend.acknowledgedRevisions).size).toBe(1);
  });

  it("accepts distinct child-owned checkpoints before ownership returns", async () => {
    const backend = new TurnProtocolBackend("intermediate-update");

    await expect(runSession(backend, sessionInput())).resolves.toMatchObject({
      kind: "completed",
    });
    expect(new Set(backend.acknowledgedRevisions).size).toBe(2);
  });

  it("does not publish a terminal event when finalization exhausts", async () => {
    const backend = new TurnProtocolBackend("finalization-exhausted");
    const input = sessionInput();

    await expect(runSession(backend, input)).rejects.toThrow("finalization unavailable");
    const events = await backend.events(input.eventLogId);
    expect(
      events.some(
        (event) => isWireRecord(event.payload) && event.payload.type === "session.terminal",
      ),
    ).toBe(false);
  });

  it("does not translate checkpoint protocol failures into effect failures", async () => {
    const backend = new CheckpointFailureBackend();

    await expect(runTurn(backend, turnInput(backend.executionId))).rejects.toThrow(
      "checkpoint acknowledgement failed",
    );
  });

  it("does not translate effect protocol failures into domain failures", async () => {
    const backend = new CheckpointFailureBackend("effect-protocol");

    await expect(runTurn(backend, turnInput(backend.executionId))).rejects.toThrow(
      EffectProtocolError,
    );
  });

  it("preserves the backend failure code in a typed turn outcome", async () => {
    const backend = new CheckpointFailureBackend("effect-exhausted");

    await expect(runTurn(backend, turnInput(backend.executionId))).resolves.toMatchObject({
      kind: "task-terminal",
      terminal: {
        error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" },
        kind: "failed",
      },
    });
  });
});

class TurnProtocolBackend implements LoopBackend {
  readonly executionId = executionId("protocol:root");
  readonly failure:
    | "cross-session-update"
    | "duplicate-update"
    | "event-sequence-rollback"
    | "finalization-exhausted"
    | "intermediate-update"
    | "post-return-update"
    | "unpersisted-terminal";
  readonly #service = new MemoryPrototypeService();
  readonly acknowledgedRevisions: number[] = [];
  #notices: ChildNotice<"turn">[] = [];

  constructor(
    failure:
      | "cross-session-update"
      | "duplicate-update"
      | "event-sequence-rollback"
      | "finalization-exhausted"
      | "intermediate-update"
      | "post-return-update"
      | "unpersisted-terminal",
  ) {
    this.failure = failure;
  }

  async acknowledgeChildUpdate(_handle: ChildHandle<"turn">, revision: number): Promise<void> {
    this.acknowledgedRevisions.push(revision);
  }

  async appendEvents(events: readonly EventRecord[]): Promise<void> {
    await this.#service.append(events);
  }

  async checkpoint(): Promise<void> {}

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>> {
    if (this.failure === "finalization-exhausted" && call.name === "finalize-session") {
      return {
        error: { code: "FINALIZATION_UNAVAILABLE", message: "finalization unavailable" },
        kind: "exhausted",
      };
    }
    return { kind: "succeeded", output: await this.#service.effect(call) };
  }

  async events(logId: EventLogId): Promise<readonly EventRecord[]> {
    return await this.#service.read(logId);
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {}

  async receive(_wait: ReceiveWait): Promise<Delivery> {
    throw new Error("Test did not expect public input.");
  }

  async startSessionChild(_spec: SessionChildSpec): Promise<ChildHandle<"session">> {
    throw new Error("Test did not expect a session child.");
  }

  async startTurnChild(spec: TurnChildSpec): Promise<ChildHandle<"turn">> {
    const childExecutionId = executionId(spec.id);
    const intermediate = checkpoint(spec.input.checkpoint, childExecutionId, 1);
    const valid =
      this.failure === "intermediate-update"
        ? checkpoint(intermediate, this.executionId, 1)
        : checkpoint(spec.input.checkpoint, this.executionId, 1);
    let acknowledged = valid;
    if (this.failure === "cross-session-update") {
      acknowledged = {
        ...valid,
        state: { ...valid.state, sessionId: sessionId("different-session") },
      };
    }
    if (this.failure === "event-sequence-rollback") {
      acknowledged = {
        ...valid,
        state: { ...valid.state, nextEventSequence: -1 },
      };
    }
    const terminalCheckpoint =
      this.failure === "unpersisted-terminal"
        ? checkpoint(acknowledged, this.executionId, 1)
        : acknowledged;
    const terminal = {
      kind: "terminal" as const,
      output: {
        checkpoint: terminalCheckpoint,
        kind: "task-terminal" as const,
        terminal: { kind: "completed" as const, output: "unpersisted" },
      },
    };
    this.#notices = [{ kind: "update", update: { checkpoint: acknowledged, kind: "checkpoint" } }];
    if (this.failure === "intermediate-update") {
      this.#notices.unshift({
        kind: "update",
        update: { checkpoint: intermediate, kind: "checkpoint" },
      });
    }
    if (this.failure === "duplicate-update") {
      this.#notices.push({
        kind: "update",
        update: { checkpoint: acknowledged, kind: "checkpoint" },
      });
    }
    if (this.failure === "post-return-update") {
      const second = checkpoint(acknowledged, this.executionId, 1);
      this.#notices.push({
        kind: "update",
        update: { checkpoint: second, kind: "checkpoint" },
      });
    }
    this.#notices.push(terminal);
    return { backendRunId: "protocol:turn-run", id: spec.id, kind: "turn" };
  }

  async waitForChild(_handle: ChildHandle<"session">): Promise<ChildNotice<"session">>;
  async waitForChild(_handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">>;
  async waitForChild(
    handle: AnyChildHandle,
  ): Promise<ChildNotice<"session"> | ChildNotice<"turn">> {
    if (handle.kind === "session") throw new Error("Test did not expect a session child notice.");
    const notice = this.#notices.shift();
    if (notice === undefined) throw new Error("Test child notice queue exhausted.");
    return notice;
  }
}

class CheckpointFailureBackend implements LoopBackend {
  readonly executionId = executionId("checkpoint-failure:turn");
  readonly failure: "checkpoint" | "effect-exhausted" | "effect-protocol";
  readonly #service = new MemoryPrototypeService();
  #failed = false;

  constructor(failure: "checkpoint" | "effect-exhausted" | "effect-protocol" = "checkpoint") {
    this.failure = failure;
  }

  async acknowledgeChildUpdate(_handle: ChildHandle<"turn">, _revision: number): Promise<void> {
    throw new Error("Test did not expect a child acknowledgement.");
  }

  async appendEvents(events: readonly EventRecord[]): Promise<void> {
    await this.#service.append(events);
  }

  async checkpoint(): Promise<void> {
    if (this.failure !== "checkpoint") return;
    if (this.#failed) return;
    this.#failed = true;
    throw new Error("checkpoint acknowledgement failed");
  }

  async effect<K extends EffectName>(call: EffectCall<K>): Promise<EffectResult<K>> {
    if (this.failure === "effect-protocol") {
      throw new EffectProtocolError("conflicting operation identity");
    }
    if (this.failure === "effect-exhausted") {
      return {
        error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" },
        kind: "exhausted",
      };
    }
    return { kind: "succeeded", output: await this.#service.effect(call) };
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {}

  async receive(_wait: ReceiveWait): Promise<Delivery> {
    throw new Error("Test did not expect public input.");
  }

  async startSessionChild(_spec: SessionChildSpec): Promise<ChildHandle<"session">> {
    throw new Error("Test did not expect a session child.");
  }

  async startTurnChild(_spec: TurnChildSpec): Promise<ChildHandle<"turn">> {
    throw new Error("Test did not expect a turn child.");
  }

  async waitForChild(_handle: ChildHandle<"session">): Promise<ChildNotice<"session">>;
  async waitForChild(_handle: ChildHandle<"turn">): Promise<ChildNotice<"turn">>;
  async waitForChild(
    _handle: AnyChildHandle,
  ): Promise<ChildNotice<"session"> | ChildNotice<"turn">> {
    throw new Error("Test did not expect a child notice.");
  }
}

function sessionInput(): SessionProgramInput {
  return {
    continuationToken: "protocol:input",
    eventLogId: eventLogId("protocol:events"),
    initialDelivery: {
      deliveryId: "protocol:initial",
      kind: "message",
      message: "hello",
    },
    mode: "task",
    scenario: { kind: "echo" },
    sessionId: sessionId("protocol"),
  };
}

function turnInput(execution: SessionCheckpoint["leaseOwner"]): TurnProgramInput {
  const id = sessionId("checkpoint-failure");
  return {
    checkpoint: {
      leaseOwner: execution,
      revision: 1,
      state: {
        bufferedDeliveries: [],
        continuationToken: "checkpoint-failure:input",
        eventLogId: eventLogId("checkpoint-failure:events"),
        history: emptyHistory(),
        mode: "task",
        nextEventSequence: 0,
        nextTurnOrdinal: 1,
        pending: null,
        phase: "turn",
        scenario: { kind: "echo" },
        sessionId: id,
      },
      version: 1,
    },
    delivery: {
      deliveryId: "checkpoint-failure:initial",
      kind: "message",
      message: "hello",
    },
    parentExecutionId: executionId("checkpoint-failure:root"),
  };
}

function checkpoint(
  previous: SessionCheckpoint,
  leaseOwner: SessionCheckpoint["leaseOwner"],
  revisionIncrement: number,
): SessionCheckpoint {
  return {
    ...previous,
    leaseOwner,
    revision: previous.revision + revisionIncrement,
  };
}

function isWireRecord(value: WireValue): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
