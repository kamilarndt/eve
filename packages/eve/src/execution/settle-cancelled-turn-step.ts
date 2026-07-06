import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { reconcileSessionContinuationToken } from "#execution/workflow-steps.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { clearPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { clearPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * In-process single-flight for {@link settleCancelledTurnStep}.
 *
 * A workflow wake that lands while the settle step is in flight can
 * re-dispatch it under the runtime's at-least-once execution
 * (https://github.com/vercel/workflow/issues/2780), and the racing
 * attempts share this process (wake replays run on the same event loop
 * as the in-flight attempt). Collapsing them onto one execution keeps
 * the epilogue single on the stream. A retry after a genuine failure
 * re-executes: rejected flights are evicted.
 *
 * Entries expire after {@link CANCELLED_TURN_FLIGHT_TTL_MS} — far past
 * any duplicate-dispatch window — so results do not accumulate.
 */
const cancelledTurnSettleFlights = new Map<string, Promise<CancelledTurnSettleResult>>();
const CANCELLED_TURN_FLIGHT_TTL_MS = 60_000;

function settleCancelledTurnOnce(
  key: string,
  run: () => Promise<CancelledTurnSettleResult>,
): Promise<CancelledTurnSettleResult> {
  const existing = cancelledTurnSettleFlights.get(key);
  if (existing !== undefined) return existing;

  const flight = run();
  cancelledTurnSettleFlights.set(key, flight);
  flight
    .then(() => {
      const timer = setTimeout(
        () => cancelledTurnSettleFlights.delete(key),
        CANCELLED_TURN_FLIGHT_TTL_MS,
      );
      timer.unref?.();
    })
    .catch(() => cancelledTurnSettleFlights.delete(key));
  return flight;
}

/**
 * Settles one cancelled turn: emits `turn.cancelled` → `session.waiting`
 * through the channel adapter and durable stream, drops pending
 * runtime-action state (replaying it next turn would re-dispatch the
 * actions; their tool-call exchange lives inside the batch and never
 * reached history), and persists the between-turns session.
 *
 * Runs in the *driver* run, not the turn's own run: queued cancel-payload
 * wakes can re-dispatch an in-flight step of the turn run (two attempts
 * race and would double-emit), while the driver's wake sources exclude
 * the cancel hook. For the same reason the cancel path inside `turnStep`
 * stays side-effect free. Durable history keeps exactly what previous
 * steps persisted — the aborted step itself settled nothing.
 */
export async function settleCancelledTurnStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<CancelledTurnSettleResult> {
  "use step";

  // Keyed by session + emission sequence: identical across re-dispatched
  // attempts of the same cancelled turn, unique across turns.
  const flightKey = `${input.sessionState.sessionId}:turn-cancelled:${String(
    input.sessionState.emissionState.sequence,
  )}`;
  return settleCancelledTurnOnce(flightKey, () => runSettleCancelledTurn(input));
}

async function runSettleCancelledTurn(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<CancelledTurnSettleResult> {
  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const bundle = ctx.require(BundleKey);
  const writer = input.parentWritable.getWriter();

  let emissionState;
  try {
    const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
      const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)));
    };
    emissionState = await emitCancelledTurn(emit, getHarnessEmissionState(durableSession.state));
  } finally {
    writer.releaseLock();
  }

  setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });

  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const cancelledSession = reconcileSessionContinuationToken(
    ctx,
    setHarnessEmissionState(
      clearPendingWorkflowInterrupt(clearPendingRuntimeActionBatch(session)),
      emissionState,
    ),
  );

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: cancelledSession }),
  };
}
