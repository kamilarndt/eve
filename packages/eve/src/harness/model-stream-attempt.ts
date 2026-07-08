import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import type { HarnessToolMap } from "#harness/types.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { toError } from "#shared/errors.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type InlineToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/** Result of consuming one model attempt's full stream. */
export interface EmittedStreamContent {
  readonly emittedActionCallIds: ReadonlySet<string>;
  readonly handledInlineToolResultCallIds: ReadonlySet<string>;
  readonly invalidInputToolCallIds: ReadonlySet<string>;
  readonly inlineAuthorizationResults: readonly TypedToolResult<ToolSet>[];
  readonly inlineToolResultParts: readonly InlineToolResultPart[];
  readonly trailingInlineToolResultParts: readonly InlineToolResultPart[];
}

export interface StreamActionEmissionOptions {
  readonly excludedActionToolNames: ReadonlySet<string>;
  readonly tools: HarnessToolMap;
}

/** Attempt-local state retained when a model error aborts a stream. */
export interface ModelStreamFailureState {
  readonly pendingLocalActionRequests: readonly RuntimeToolCallActionRequest[];
  readonly providerExecutedActionObserved: boolean;
  readonly reasoningObserved: boolean;
  readonly textObserved: boolean;
}

const modelStreamFailureStates = new WeakMap<Error, ModelStreamFailureState>();

/** Preserves a plain provider payload as the normalized error's cause. */
export function normalizeModelStreamError(raw: unknown): Error {
  const error = toError(raw);
  if (error === raw) return error;

  Object.defineProperty(error, "cause", {
    configurable: true,
    value: raw,
  });
  return error;
}

/** Records attempt-local state on the error consumed by the retry layer. */
export function setModelStreamFailureState(error: Error, state: ModelStreamFailureState): void {
  modelStreamFailureStates.set(error, state);
}

/** Returns attempt-local stream state attached to a normalized model error. */
export function getModelStreamFailureState(error: unknown): ModelStreamFailureState | undefined {
  return error instanceof Error ? modelStreamFailureStates.get(error) : undefined;
}
