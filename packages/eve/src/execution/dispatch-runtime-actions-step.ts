/**
 * Starts every pending runtime action for the parked parent session.
 *
 * Each child run starts in task mode, emits a parent `subagent.called`
 * control-plane event, and then runs independently on its own child
 * stream. Records each child's continuation token on the parent
 * session and returns the updated snapshot-bearing state.
 */

import { buildAdapterContext } from "#channel/adapter-context.js";
import { readActiveHookOwner } from "#execution/active-hook-owner.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  LocalSubagentsOnlyKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  getPendingRuntimeActionBatch,
  recordPendingSubagentChild,
} from "#harness/runtime-actions.js";
import {
  createSubagentCalledEvent,
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import { hydrateDurableSession, mintSubagentContinuationToken } from "#execution/session.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime, workflowEntryReference } from "#execution/workflow-runtime.js";
import { cancelLocalSubagentChildren } from "#execution/cancel-local-subagent-children.js";
import { createLogger, logError } from "#internal/logging.js";
import { getRun } from "#internal/workflow/runtime.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  type DelegatedRuntimeActionRequest,
  getSubagentDelegationName,
  isSubagentDelegationAction,
  resolveSubagentDelegationLimit,
  type SubagentDelegationLimit,
} from "#harness/subagent-depth.js";

const log = createLogger("execution.dispatch-runtime-actions");
const CHILD_OWNER_HOOK_RETRY_ATTEMPTS = 300;
const CHILD_OWNER_HOOK_RETRY_DELAY_MS = 100;
const ABORTED_REPLAY_OWNER_PUBLICATION_TIMEOUT_MS = 30_000;

export async function dispatchRuntimeActionsStep(input: {
  readonly abortSignal?: AbortSignal;
  readonly callbackBaseUrl?: string;
  /** Internal hook that receives child completion and HITL payloads. */
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const batch = getPendingRuntimeActionBatch(durableSession.state);

  if (batch === undefined || batch.actions.length === 0) {
    return { results: [], sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });
  const adapter = ctx.require(ChannelKey);
  const auth = ctx.get(AuthKey) ?? null;
  const capabilities = ctx.get(CapabilitiesKey);
  const channelMetadata = ctx.get(ChannelInstrumentationKey);
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const localSubagentsOnly = ctx.get(LocalSubagentsOnlyKey) === true;
  const writer = input.parentWritable.getWriter();

  const adapterCtx = buildAdapterContext(adapter, ctx);
  const delegationLimit = resolveSubagentDelegationLimit(session);
  // Split the parent's remaining token quota across the batch's local
  // subagent calls, the children that actually receive an enforced cap.
  // Remote agents run on their own deployment under their own limits and
  // do not dilute the local shares.
  const fanoutSize = batch.actions.filter((action) => action.kind === "subagent-call").length;

  let nextSession = session;
  const results: RuntimeSubagentResultActionResult[] = [];
  const startedLocalChildren: Array<{
    readonly runtime: ReturnType<typeof createWorkflowRuntime>;
    readonly sessionId: string;
  }> = [];
  const mayStartMissingActions = input.abortSignal?.aborted !== true;
  const abortedReplayOwners = mayStartMissingActions
    ? undefined
    : await waitForAbortedReplayOwners(
        batch.actions.flatMap((action) =>
          action.kind === "subagent-call"
            ? [
                {
                  callId: action.callId,
                  continuationToken: mintSubagentContinuationToken(
                    `${session.sessionId}:${action.callId}`,
                  ),
                },
              ]
            : [],
        ),
      );

  // Once fan-out starts, finish and persist the whole short start batch. A
  // mid-loop abort would otherwise strand already-started children whose ids
  // never reach the durable parent cursor. On an already-aborted replay, only
  // adopt owners made visible by the lost attempt; do not start new work.
  try {
    for (const action of batch.actions) {
      if (delegationLimit.reached && isSubagentDelegationAction(action)) {
        log.warn("subagent depth limit reached; blocking delegated call", {
          callId: action.callId,
          currentDepth: delegationLimit.currentDepth,
          maxDepth: delegationLimit.maxDepth,
          nodeId: action.nodeId,
          subagentName: getSubagentDelegationName(action),
        });
        results.push(createSubagentDepthLimitResult({ action, delegationLimit }));
        continue;
      }
      if (localSubagentsOnly && action.kind === "remote-agent-call") {
        results.push({
          callId: action.callId,
          isError: true,
          kind: "subagent-result",
          output: {
            code: "PERSISTENT_WORKFLOW_REMOTE_AGENT_FORBIDDEN",
            message: "Persistent workflows may call only local subagents.",
          },
          subagentName: action.remoteAgentName,
        });
        continue;
      }

      let childSessionId: string;
      let name: string;
      let remote: { readonly url: string } | undefined;
      let toolName: string;

      switch (action.kind) {
        case "subagent-call": {
          const registered = bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
          const source: SubagentInputSource =
            registered?.definition.kind === "subagent"
              ? { description: registered.definition.description, type: "local" }
              : { type: "runtime" };
          const childRuntime = createWorkflowRuntime({
            compiledArtifactsSource: bundle.compiledArtifactsSource,
            localSubagentsOnly,
            nodeId: action.nodeId,
          });
          const { childContinuationToken, runInput } = buildSubagentRunInput({
            action,
            auth,
            batchEvent: batch.event,
            capabilities,
            channelMetadata,
            fanoutSize,
            initiatorAuth,
            parentContinuationToken: input.parentContinuationToken,
            session,
            source,
          });
          const activeOwner =
            abortedReplayOwners?.get(action.callId) ??
            (await readActiveHookOwner(childContinuationToken, "Local subagent continuation hook"));
          if (activeOwner !== null) {
            childSessionId = activeOwner.runId;
          } else {
            if (!mayStartMissingActions) continue;
            const handle = await childRuntime.run(runInput);
            childSessionId = handle.sessionId;
          }
          // Record the durably started candidate before owner discovery. The
          // lookup can still fail for an unrelated backend error; catch cleanup
          // must retain an address for every run already started by this step.
          startedLocalChildren.push({ runtime: childRuntime, sessionId: childSessionId });
          nextSession = recordPendingSubagentChild({
            callId: action.callId,
            childContinuationToken,
            childSessionId,
            session: nextSession,
          });
          if (activeOwner === null) {
            const ownerSessionId = await waitForLocalSubagentOwner({
              candidateRunId: childSessionId,
              continuationToken: childContinuationToken,
            });
            if (ownerSessionId !== childSessionId) {
              childSessionId = ownerSessionId;
              startedLocalChildren[startedLocalChildren.length - 1] = {
                runtime: childRuntime,
                sessionId: childSessionId,
              };
              nextSession = recordPendingSubagentChild({
                callId: action.callId,
                childContinuationToken,
                childSessionId,
                session: nextSession,
              });
            }
          }
          name = action.name;
          toolName = action.subagentName;
          break;
        }
        case "remote-agent-call": {
          if (!mayStartMissingActions) continue;
          let resolvedRemote;
          try {
            resolvedRemote = resolveRemoteAgentForAction({
              nodeId: action.nodeId,
              remoteAgentName: action.remoteAgentName,
              registry: bundle.subagentRegistry.subagentsByNodeId,
            });
            childSessionId = await startRemoteAgentSession({
              action,
              callbackBaseUrl: input.callbackBaseUrl,
              callbackToken: input.parentContinuationToken,
              remote: resolvedRemote,
              session,
            });
          } catch (error) {
            logError(log, "remote agent start failed", error, {
              remoteAgentName: action.remoteAgentName,
              nodeId: action.nodeId,
              callId: action.callId,
            });
            results.push(createRemoteAgentStartFailureResult({ action, error }));
            continue;
          }
          name = action.name;
          remote = { url: resolvedRemote.url };
          toolName = action.remoteAgentName;
          break;
        }
        default:
          throw new Error(`Unsupported runtime action kind "${action.kind}" in workflow runtime.`);
      }

      const parentEvent = await callAdapterEventHandler(
        adapter,
        createSubagentCalledEvent({
          callId: action.callId,
          childSessionId,
          name,
          remote,
          sequence: batch.event.sequence,
          sessionId: session.sessionId,
          toolName,
          turnId: batch.event.turnId,
          workflowId: workflowEntryReference.workflowId,
        }),
        adapterCtx,
      );
      await writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(parentEvent)));
    }
  } catch (error) {
    try {
      await cancelLocalSubagentChildren(
        startedLocalChildren.map((child) => ({
          cancel: () => child.runtime.cancel(child.sessionId),
          sessionId: child.sessionId,
        })),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Runtime action dispatch failed and local child cleanup did not complete: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  } finally {
    writer.releaseLock();
  }

  const nextState =
    nextSession === session
      ? input.sessionState
      : createDurableSessionState({ session: nextSession });

  return { results, sessionState: nextState };
}

async function waitForAbortedReplayOwners(
  children: readonly { readonly callId: string; readonly continuationToken: string }[],
): Promise<ReadonlyMap<string, { readonly runId: string }>> {
  const owners = new Map<string, { readonly runId: string }>();
  const pending = new Map(children.map((child) => [child.callId, child]));
  const deadline = Date.now() + ABORTED_REPLAY_OWNER_PUBLICATION_TIMEOUT_MS;

  while (pending.size > 0) {
    const observations = await Promise.all(
      [...pending.values()].map(async (child) => ({
        child,
        owner: await readActiveHookOwner(
          child.continuationToken,
          "Local subagent continuation hook",
        ),
      })),
    );
    for (const { child, owner } of observations) {
      if (owner === null) continue;
      owners.set(child.callId, owner);
      pending.delete(child.callId);
    }

    const remainingMs = deadline - Date.now();
    if (pending.size === 0 || remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CHILD_OWNER_HOOK_RETRY_DELAY_MS, remainingMs)),
    );
  }

  return owners;
}

async function waitForLocalSubagentOwner(input: {
  readonly candidateRunId: string;
  readonly continuationToken: string;
}): Promise<string> {
  for (let attempt = 0; attempt < CHILD_OWNER_HOOK_RETRY_ATTEMPTS; attempt += 1) {
    const owner = await readActiveHookOwner(
      input.continuationToken,
      "Local subagent continuation hook",
    );
    if (owner !== null) return owner.runId;

    let status: Awaited<ReturnType<typeof getRun>["status"]> | undefined;
    try {
      status = await getRun(input.candidateRunId).status;
    } catch (error) {
      if (!WorkflowRunNotFoundError.is(error)) throw error;
    }
    if (status === "cancelled" || status === "completed" || status === "failed") {
      return input.candidateRunId;
    }
    if (attempt === CHILD_OWNER_HOOK_RETRY_ATTEMPTS - 1) {
      // The start itself is already durable. Keep the candidate addressable in
      // parent state so a later result or cancellation can still settle it even
      // when hook publication is delayed beyond this step's bounded wait.
      return input.candidateRunId;
    }
    await new Promise((resolve) => setTimeout(resolve, CHILD_OWNER_HOOK_RETRY_DELAY_MS));
  }
  return input.candidateRunId;
}

function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentResultActionResult {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "REMOTE_AGENT_START_FAILED",
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}

function createSubagentDepthLimitResult(input: {
  readonly action: DelegatedRuntimeActionRequest;
  readonly delegationLimit: SubagentDelegationLimit;
}): RuntimeSubagentResultActionResult {
  const subagentName = getSubagentDelegationName(input.action);
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "SUBAGENT_DEPTH_LIMIT_REACHED",
      currentDepth: input.delegationLimit.currentDepth,
      maxDepth: input.delegationLimit.maxDepth,
      message: `Subagent depth limit reached (${input.delegationLimit.maxDepth}); "${subagentName}" was not called.`,
    },
    subagentName,
  };
}
