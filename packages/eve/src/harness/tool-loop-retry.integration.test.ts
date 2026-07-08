import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
} as const;

function createSession(overrides?: Partial<HarnessSession>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "retry-integration-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:retry-integration-session",
    history: [
      { content: "Complete the long task.", role: "user" },
      { content: "Prior work is complete.", role: "assistant" },
    ],
    sessionId: "retry-integration-session",
    ...overrides,
  };
}

function createEventCollector(): {
  emit: HarnessEmitFn;
  events: HandleMessageStreamEvent[];
} {
  const events: HandleMessageStreamEvent[] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function createConfig(
  model: LanguageModel,
  emit: HarnessEmitFn,
  overrides?: Partial<ToolLoopHarnessConfig>,
): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    mode: "task",
    resolveModel: vi.fn().mockResolvedValue(model),
    tools: new Map(),
    ...overrides,
  };
}

function enqueueOverload(
  controller: ReadableStreamDefaultController<StreamPart>,
  partialText?: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  if (partialText !== undefined) {
    controller.enqueue({ id: "partial", type: "text-start" });
    controller.enqueue({ delta: partialText, id: "partial", type: "text-delta" });
    controller.enqueue({ id: "partial", type: "text-end" });
  }
  controller.enqueue({
    error: { message: "Overloaded", type: "overloaded_error" },
    type: "error",
  });
  controller.close();
}

function enqueueTextSuccess(
  controller: ReadableStreamDefaultController<StreamPart>,
  text: string,
): void {
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ id: "answer", type: "text-start" });
  controller.enqueue({ delta: text, id: "answer", type: "text-delta" });
  controller.enqueue({ id: "answer", type: "text-end" });
  controller.enqueue({
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage,
  });
  controller.close();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool loop transient stream retries (real AI SDK)", () => {
  it("retries a partial overloaded stream with fresh hooks and preserves prior task work", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          if (attempt === 1) {
            enqueueOverload(controller, "Discard this partial response.");
            return;
          }
          enqueueTextSuccess(controller, "Recovered answer.");
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(result.next).toEqual({ done: true, output: "Recovered answer." });
    expect(result.session.history).toContainEqual({
      content: "Prior work is complete.",
      role: "assistant",
    });
    expect(JSON.stringify(result.session.history)).toContain("Recovered answer.");
    expect(JSON.stringify(result.session.history)).not.toContain("Discard this partial response.");
    expect(events.filter((event) => event.type === "step.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "step.completed")).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "message.completed" &&
          event.data.finishReason === "error" &&
          event.data.message === null,
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "step.failed")).toBe(false);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "session.failed")).toBe(false);
  });

  it("does not execute a discarded local tool proposal and closes it before retrying", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const execute = vi.fn(() => "tool-result");
    let attempt = 0;
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          attempt += 1;
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            input: JSON.stringify({ value: attempt }),
            toolCallId: `call-${attempt}`,
            toolName: "local_tool",
            type: "tool-call",
          });
          if (attempt === 1) {
            controller.enqueue({
              error: { message: "Overloaded", type: "overloaded_error" },
              type: "error",
            });
            controller.close();
            return;
          }
          controller.enqueue({
            finishReason: { raw: undefined, unified: "tool-calls" },
            type: "finish",
            usage,
          });
          controller.close();
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const tools: ToolLoopHarnessConfig["tools"] = new Map([
      [
        "local_tool",
        {
          description: "Local tool",
          execute,
          inputSchema: jsonSchema({
            properties: { value: { type: "number" } },
            required: ["value"],
            type: "object",
          }),
          name: "local_tool",
        },
      ],
    ]);
    const session = createSession({
      agent: {
        modelReference: { id: "retry-integration-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Local tool",
            inputSchema: {
              properties: { value: { type: "number" } },
              required: ["value"],
              type: "object",
            },
            name: "local_tool",
          },
        ],
      },
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit, { tools }))(session, {
      message: "Use the tool.",
    });

    expect(doStream).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.next).toBeTypeOf("function");
    const firstCallResult = events.find((event) => {
      if (event.type !== "action.result") return false;
      return event.data.result.callId === "call-1";
    });
    expect(firstCallResult?.type).toBe("action.result");
    if (firstCallResult?.type === "action.result") {
      expect(firstCallResult.data).toMatchObject({
        result: {
          callId: "call-1",
          isError: true,
          output: {
            code: "MODEL_CALL_RETRIED",
          },
        },
        status: "failed",
      });
    }
    const secondCallResult = events.find((event) => {
      if (event.type !== "action.result") return false;
      return event.data.result.callId === "call-2";
    });
    expect(secondCallResult?.type).toBe("action.result");
    if (secondCallResult?.type === "action.result") {
      expect(secondCallResult.data.status).toBe("completed");
    }
  });

  it("does not replay an overloaded attempt after provider-executed activity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            input: JSON.stringify({ query: "weather" }),
            providerExecuted: true,
            toolCallId: "provider-call",
            toolName: "web_search",
            type: "tool-call",
          });
          controller.enqueue({
            error: { message: "Overloaded", type: "overloaded_error" },
            type: "error",
          });
          controller.close();
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Search.",
    });

    expect(doStream).toHaveBeenCalledTimes(1);
    expect(result.next).toMatchObject({ done: true, isError: true, output: "Overloaded" });
  });

  it("fails a task once after three overloaded attempts are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          enqueueOverload(controller);
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createConfig(model, emit))(createSession(), {
      message: "Continue.",
    });

    expect(doStream).toHaveBeenCalledTimes(3);
    expect(result.next).toMatchObject({ done: true, isError: true, output: "Overloaded" });
    expect(events.filter((event) => event.type === "step.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session.failed")).toHaveLength(1);
  });

  it("interrupts retry backoff when the turn is cancelled", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();
    vi.spyOn(console, "warn").mockImplementation((line) => {
      if (String(line).includes("model call failed transiently")) {
        abortController.abort(cancellation);
      }
    });

    const doStream = vi.fn(async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          enqueueOverload(controller);
        },
      }),
    }));
    const model = new MockLanguageModelV3({
      doStream,
      modelId: "retry-integration-model",
      provider: "eve-integration-mock",
    });
    const { emit, events } = createEventCollector();
    const run = createToolLoopHarness(
      createConfig(model, emit, { abortSignal: abortController.signal }),
    );

    await expect(run(createSession(), { message: "Continue." })).rejects.toBe(cancellation);

    expect(doStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "step.failed")).toBe(false);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "session.failed")).toBe(false);
  });
});
