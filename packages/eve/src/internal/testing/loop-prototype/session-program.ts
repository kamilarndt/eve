import { childId, executionId, operationId } from "./ids.js";
import { runEffect } from "./effects.js";
import { appendEvent, idempotentRetry, replaceCheckpoint } from "./program-support.js";
import { emptyHistory } from "./transcript.js";
import type {
  ChildHandle,
  Delivery,
  DriverUpdate,
  LoopBackend,
  MessageDelivery,
  OpenExchange,
  SessionCheckpoint,
  SessionProgramInput,
  TerminalOutcome,
  TurnOutcome,
} from "./types.js";
import { stringifyCanonical } from "./wire.js";

export async function runSession(
  backend: LoopBackend,
  input: SessionProgramInput,
): Promise<TerminalOutcome> {
  const initialized = await runEffect(backend, {
    id: operationId(input.sessionId, 0, "initialize"),
    input: {
      continuationToken: input.continuationToken,
      sessionId: input.sessionId,
    },
    name: "initialize-session",
    retry: idempotentRetry(2),
  });
  let checkpoint: SessionCheckpoint = {
    leaseOwner: backend.executionId,
    revision: 0,
    state: {
      bufferedDeliveries: [],
      continuationToken: initialized.continuationToken,
      eventLogId: input.eventLogId,
      history: emptyHistory(),
      mode: input.mode,
      nextEventSequence: 0,
      nextTurnOrdinal: 0,
      pending: null,
      phase: "between-turns",
      scenario: input.scenario,
      sessionId: input.sessionId,
    },
    version: 1,
  };
  await backend.checkpoint(checkpoint);

  let initialDelivery: MessageDelivery | null = input.initialDelivery;

  while (true) {
    const deliveryResult = await nextDelivery(backend, checkpoint, initialDelivery);
    checkpoint = deliveryResult.checkpoint;
    initialDelivery = null;

    const turnOrdinal = checkpoint.state.nextTurnOrdinal;
    const turnChildId = childId(backend.executionId, turnOrdinal, "turn");
    const delegatedCheckpoint = replaceCheckpoint(checkpoint, executionId(turnChildId), {
      ...checkpoint.state,
      nextTurnOrdinal: turnOrdinal + 1,
      phase: "turn",
    });
    await backend.checkpoint(delegatedCheckpoint);

    const child = await backend.startTurnChild({
      eventLog: { kind: "borrow-parent" },
      id: turnChildId,
      input: {
        checkpoint: delegatedCheckpoint,
        delivery: deliveryResult.delivery,
        parentExecutionId: backend.executionId,
      },
      kind: "turn",
      version: "latest-compatible",
    });
    const turn = await waitForTurn(backend, child, delegatedCheckpoint);
    checkpoint = turn.checkpoint;

    if (turn.kind === "waiting-approval" || turn.kind === "conversation-replied") {
      continue;
    }

    return await finalizeSession(backend, checkpoint, turn.terminal);
  }
}

async function nextDelivery(
  backend: LoopBackend,
  checkpoint: SessionCheckpoint,
  initialDelivery: MessageDelivery | null,
): Promise<{ readonly checkpoint: SessionCheckpoint; readonly delivery: Delivery }> {
  if (initialDelivery !== null) return { checkpoint, delivery: initialDelivery };

  const pendingApproval = pendingApprovalRequestId(checkpoint.state.pending);
  const bufferedIndex = checkpoint.state.bufferedDeliveries.findIndex((delivery) =>
    pendingApproval === null
      ? delivery.kind === "message"
      : delivery.kind === "approval" && delivery.requestId === pendingApproval,
  );

  if (bufferedIndex !== -1) {
    const buffered = checkpoint.state.bufferedDeliveries[bufferedIndex];
    if (buffered === undefined) throw new Error("Buffered delivery disappeared.");
    const remaining = checkpoint.state.bufferedDeliveries.filter(
      (_, index) => index !== bufferedIndex,
    );
    const next = replaceCheckpoint(checkpoint, backend.executionId, {
      ...checkpoint.state,
      bufferedDeliveries: remaining,
    });
    await backend.checkpoint(next);
    return { checkpoint: next, delivery: buffered };
  }

  while (true) {
    const delivery = await backend.receive({
      continuationToken: checkpoint.state.continuationToken,
      pendingApprovalRequestId: pendingApproval,
    });

    if (
      (pendingApproval === null && delivery.kind === "message") ||
      (pendingApproval !== null &&
        delivery.kind === "approval" &&
        delivery.requestId === pendingApproval)
    ) {
      return { checkpoint, delivery };
    }

    if (pendingApproval === null) continue;

    checkpoint = replaceCheckpoint(checkpoint, backend.executionId, {
      ...checkpoint.state,
      bufferedDeliveries: [...checkpoint.state.bufferedDeliveries, delivery],
    });
    await backend.checkpoint(checkpoint);
  }
}

async function waitForTurn(
  backend: LoopBackend,
  child: ChildHandle<"turn">,
  delegatedCheckpoint: SessionCheckpoint,
): Promise<TurnOutcome> {
  let latestCheckpoint = delegatedCheckpoint;
  let lastAcknowledged: SessionCheckpoint | null = null;

  while (true) {
    const notice = await backend.waitForChild(child);

    if (notice.kind === "terminal") {
      assertTerminalCheckpoint(notice.output.checkpoint, lastAcknowledged, backend.executionId);
      return notice.output;
    }

    if (notice.update.checkpoint.revision === latestCheckpoint.revision) {
      if (stringifyCanonical(notice.update.checkpoint) !== stringifyCanonical(latestCheckpoint)) {
        throw new Error(`Child "${child.id}" redelivered a checkpoint with different bytes.`);
      }
      await backend.acknowledgeChildUpdate(child, latestCheckpoint.revision);
      continue;
    }

    const next = validateUpdate(notice.update, latestCheckpoint, child, backend.executionId);
    await backend.checkpoint(next);
    await backend.acknowledgeChildUpdate(child, next.revision);
    latestCheckpoint = next;
    lastAcknowledged = next;
  }
}

function assertTerminalCheckpoint(
  terminal: SessionCheckpoint,
  acknowledged: SessionCheckpoint | null,
  parentExecutionId: SessionCheckpoint["leaseOwner"],
): void {
  if (acknowledged === null || stringifyCanonical(terminal) !== stringifyCanonical(acknowledged)) {
    throw new Error("Turn terminal checkpoint does not match the last acknowledged checkpoint.");
  }
  if (terminal.leaseOwner !== parentExecutionId) {
    throw new Error("Turn terminal checkpoint did not return its lease to the parent.");
  }
}

function validateUpdate(
  update: DriverUpdate,
  previous: SessionCheckpoint,
  child: ChildHandle<"turn">,
  parentExecutionId: SessionCheckpoint["leaseOwner"],
): SessionCheckpoint {
  const next = update.checkpoint;
  const childExecutionId = executionId(child.id);
  if (previous.leaseOwner !== childExecutionId) {
    throw new Error(`Child "${child.id}" reported an update after returning checkpoint ownership.`);
  }
  if (next.revision <= previous.revision) {
    throw new Error(`Child "${child.id}" reported a non-monotonic checkpoint revision.`);
  }
  if (next.version !== previous.version) {
    throw new Error(`Child "${child.id}" changed the checkpoint version.`);
  }
  if (next.leaseOwner !== childExecutionId && next.leaseOwner !== parentExecutionId) {
    throw new Error(`Child "${child.id}" assigned checkpoint ownership to another execution.`);
  }

  const prior = previous.state;
  const state = next.state;
  if (state.nextEventSequence < prior.nextEventSequence) {
    throw new Error(`Child "${child.id}" rolled back the event sequence.`);
  }
  if (
    state.sessionId !== prior.sessionId ||
    state.eventLogId !== prior.eventLogId ||
    state.mode !== prior.mode ||
    state.continuationToken !== prior.continuationToken ||
    state.nextTurnOrdinal !== prior.nextTurnOrdinal ||
    stringifyCanonical(state.scenario) !== stringifyCanonical(prior.scenario) ||
    stringifyCanonical(state.bufferedDeliveries) !== stringifyCanonical(prior.bufferedDeliveries)
  ) {
    throw new Error(`Child "${child.id}" changed parent-owned session identity.`);
  }
  return next;
}

async function finalizeSession(
  backend: LoopBackend,
  checkpoint: SessionCheckpoint,
  outcome: TerminalOutcome,
): Promise<TerminalOutcome> {
  const operation = operationId(
    checkpoint.state.sessionId,
    checkpoint.state.nextTurnOrdinal,
    "finalize",
  );
  await runEffect(backend, {
    id: operation,
    input: { outcome, sessionId: checkpoint.state.sessionId },
    name: "finalize-session",
    retry: idempotentRetry(2),
  });
  let state = await appendEvent(backend, checkpoint.state, operation, {
    outcome: outcome.kind,
    type: "session.terminal",
  });
  state = { ...state, phase: "terminal" };
  const terminalCheckpoint = replaceCheckpoint(checkpoint, backend.executionId, state);
  await backend.checkpoint(terminalCheckpoint);
  await backend.finish(outcome);
  return outcome;
}

function pendingApprovalRequestId(exchange: OpenExchange | null): string | null {
  if (exchange === null) return null;
  return exchange.requests.find((request) => request.kind === "approval")?.requestId ?? null;
}
