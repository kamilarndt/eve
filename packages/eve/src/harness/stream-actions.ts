import type { ContentPart, ToolSet, TypedToolCall } from "ai";

import { extractToolApprovalInputRequests } from "#harness/input-extraction.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import { createActionsRequestedEvent } from "#protocol/message.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";
import type { HarnessEmitFn, HarnessToolMap } from "#harness/types.js";

interface ActionEventCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * Coordinates one assistant message's local tool-call events.
 *
 * The stream observes individual tool calls as their arguments finish, while
 * `onLanguageModelCallEnd` receives the complete parsed model response before
 * the SDK starts any client-side executors. Waiting for both gives clients one
 * stable parallel batch without delaying pre-tool narration.
 */
export interface StreamActionBatch {
  readonly emittedActionCallIds: ReadonlySet<string>;
  observeToolCall(toolCall: TypedToolCall<ToolSet>): Promise<void>;
  onLanguageModelCallEnd(content: readonly ContentPart<ToolSet>[]): Promise<void>;
}

/** Creates the action batch for one streamed model call. */
export function createStreamActionBatch(input: {
  readonly emitFn: HarnessEmitFn;
  readonly excludedActionToolNames: ReadonlySet<string>;
  readonly state: ActionEventCoordinates;
  readonly tools: HarnessToolMap;
}): StreamActionBatch {
  const observedToolCallIds = new Set<string>();
  const emittedActionCallIds = new Set<string>();
  let actions: readonly RuntimeActionRequest[] | undefined;
  let emission: Promise<void> | undefined;
  let resolveEmission!: () => void;
  let rejectEmission!: (error: unknown) => void;
  const emitted = new Promise<void>((resolve, reject) => {
    resolveEmission = resolve;
    rejectEmission = reject;
  });

  const tryEmitBatch = (): Promise<void> | undefined => {
    if (actions === undefined || actions.length === 0) {
      return undefined;
    }
    if (emission !== undefined) {
      return emission;
    }
    if (!actions.every((action) => observedToolCallIds.has(action.callId))) {
      return undefined;
    }

    for (const action of actions) {
      emittedActionCallIds.add(action.callId);
    }
    emission = input.emitFn(
      createActionsRequestedEvent({
        actions,
        sequence: input.state.sequence,
        stepIndex: input.state.stepIndex,
        turnId: input.state.turnId,
      }),
    );
    void emission.then(resolveEmission, rejectEmission);
    return emission;
  };

  return {
    emittedActionCallIds,
    async observeToolCall(toolCall) {
      observedToolCallIds.add(toolCall.toolCallId);
      await tryEmitBatch();
    },
    async onLanguageModelCallEnd(content) {
      if (actions !== undefined) {
        return;
      }

      const approvalCallIds = new Set(
        extractToolApprovalInputRequests({ content }).map((request) => request.action.callId),
      );
      const actionCallIds = new Set<string>();
      const requestedActions: RuntimeActionRequest[] = [];
      for (const part of content) {
        if (
          part.type !== "tool-call" ||
          part.invalid === true ||
          part.providerExecuted === true ||
          approvalCallIds.has(part.toolCallId) ||
          input.excludedActionToolNames.has(part.toolName)
        ) {
          continue;
        }

        try {
          const action = createRuntimeActionRequestFromToolCall({
            toolCall: part,
            tools: input.tools,
          });
          if (actionCallIds.has(action.callId)) {
            continue;
          }
          actionCallIds.add(action.callId);
          requestedActions.push(action);
        } catch (error) {
          // A malformed tool call is marked invalid by the SDK before it can
          // execute. Leave its recovery to that path instead of failing the
          // entire step while projecting UI events.
          if (error instanceof TypeError) {
            continue;
          }
          throw error;
        }
      }

      actions = requestedActions;
      if (actions.length === 0) {
        return;
      }
      await (tryEmitBatch() ?? emitted);
    },
  };
}
