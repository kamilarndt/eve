import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { ContinuationTokenKey } from "#context/keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  emitCancelledTurn,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { hydrateDurableSession } from "#execution/session.js";
import { encodeMessageStreamEvent, timestampHandleMessageStreamEvent } from "#protocol/message.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export interface FinalizedCancelledTurn {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Emits and checkpoints the cancellation epilogue after active work settles. */
export async function finalizeCancelledTurnStep(
  input: Pick<TurnStepInput, "parentWritable" | "serializedContext" | "sessionState">,
): Promise<FinalizedCancelledTurn> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);

  try {
    const { getWorkflowMetadata } = await import("#compiled/@workflow/core/index.js");
    const metadata = getWorkflowMetadata();
    if (typeof metadata.url === "string") {
      ctx.set(CallbackBaseUrlKey, metadata.url.replace(/\/$/, ""));
    }
  } catch {
    // Outside a workflow context (e.g. tests) — getHookUrl will return undefined.
  }

  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.parentWritable.getWriter();
  const hookRegistry = bundle.hookRegistry;
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];

  const emit = async (event: HandleMessageStreamEvent): Promise<HandleMessageStreamEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(toEmit)));
    return toEmit;
  };

  const handleEvent = async (event: HandleMessageStreamEvent): Promise<void> => {
    const emitted = await emit(event);
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: dynamicToolResolvers,
      event: emitted,
      messages: [],
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: dynamicSkillResolvers,
      event: emitted,
      messages: [],
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: dynamicInstructionsResolvers,
      event: emitted,
      messages: [],
    });
  };

  try {
    const result = await runStep(ctx, initialSession, async (enrichedSession) => {
      const emissionState = await emitCancelledTurn(
        handleEvent,
        resolveCancellationEmissionState(input.sessionState.emissionState),
      );
      return {
        next: null,
        session: setHarnessEmissionState(
          {
            ...enrichedSession,
            outputSchema: undefined,
          },
          emissionState,
        ),
      };
    });
    const cancelledSession = reconcileContinuationToken(ctx, result.session);

    return {
      serializedContext: serializeContext(ctx),
      sessionState: createDurableSessionState({ session: cancelledSession }),
    };
  } finally {
    writer.releaseLock();
  }
}

function resolveCancellationEmissionState(state: HarnessEmissionState): HarnessEmissionState {
  if (state.turnId.length > 0) {
    return state;
  }

  // A rejected first step cannot return the post-preamble session state. Turn
  // ids are sequence-derived, so reconstruct the state whose events were
  // already written before the abort reached the model or tool.
  return {
    sessionStarted: true,
    sequence: state.sequence,
    stepIndex: 0,
    turnId: `turn_${String(state.sequence)}`,
  };
}

function reconcileContinuationToken(
  ctx: Awaited<ReturnType<typeof deserializeContext>>,
  session: HarnessSession,
): HarnessSession {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}
