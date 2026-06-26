import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Cancels every remote child recorded on the turn's pending runtime-action batch. */
export async function cancelPendingRemoteAgentTurnsStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);
  if (batch?.remoteAgentSessions === undefined) return;

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);

  await Promise.all(
    Object.entries(batch.remoteAgentSessions).map(async ([callId, identity]) => {
      const action = batch.actions.find((candidate) => candidate.callId === callId);
      if (action?.kind !== "remote-agent-call") {
        throw new Error(`Missing pending remote-agent action for call "${callId}".`);
      }

      const remote = resolveRemoteAgentForAction({
        nodeId: action.nodeId,
        registry: bundle.subagentRegistry.subagentsByNodeId,
        remoteAgentName: action.remoteAgentName,
      });
      await cancelRemoteAgentTurn({
        continuationToken: identity.continuationToken,
        remote,
        sessionId: identity.sessionId,
      });
    }),
  );
}
