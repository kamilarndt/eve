import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { parseSlackRequestBody } from "#internal/testing/slack-channel-test-helpers.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { buildHitlResponderBlockId, HITL_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import {
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_SECTION_TEXT_MAX_LENGTH,
} from "#public/channels/slack/limits.js";
import { defaultSlackAuth } from "#public/channels/slack/index.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

function getAdapter(channel: unknown): ChannelAdapter<any> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel.adapter;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Record<string, unknown>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

const stubAlsContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    sessionId: "test-session",
    auth: { current: null, initiator: null },
    turn: { id: "test-turn", sequence: 0 },
  });
  return ctx;
})();

function callEvent(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: any,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

/**
 * Accessor whose `set` writes are captured so tests can assert on
 * `setContinuationToken` flowing through the SessionHandle. Returns
 * undefined for unset keys (matching the real `ContextContainer`
 * behavior), while seeding the current continuation token so
 * SessionHandle can preserve the runtime namespace.
 */
function captureAccessor(initialContinuationToken: string): {
  accessor: any;
  writes: Array<[string, unknown]>;
} {
  const writes: Array<[string, unknown]> = [];
  let continuationToken = initialContinuationToken;
  return {
    writes,
    accessor: {
      get: (key: { name: string }) =>
        key.name === "eve.continuationToken" ? continuationToken : undefined,
      set: (key: { name: string }, value: unknown | ((current: unknown) => unknown)) => {
        const next =
          typeof value === "function" ? (value as (current: unknown) => unknown)(undefined) : value;
        if (key.name === "eve.continuationToken") {
          continuationToken = String(next);
        }
        writes.push([key.name, next]);
        return next;
      },
    },
  };
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { type, data } as HandleMessageStreamEvent;
}

const THREAD_STATE = {
  channelId: "C01",
  threadTs: "1700000000.000001",
  teamId: "T01",
  triggeringUserId: "U_REQUESTER",
};

describe("slackChannel() default event handlers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("message.completed posts the agent message via Slack API", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Hello from the agent",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel: "C01",
      thread_ts: "1700000000.000001",
      markdown_text: "Hello from the agent",
    });
  });

  it("message.completed skips post when finishReason is tool-calls", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "tool-calls",
        message: "Should not post",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("input.requested posts an approval card with Slack-unique button action ids", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: {
              callId: "call_abc123",
              input: { operation: "deleteMany" },
              kind: "tool-call",
              toolName: "mongodb-mutate",
            },
            display: "confirmation",
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve tool call: mongodb-mutate",
            requestId: "approval_abc123",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
    const body = parseSlackRequestBody(init as RequestInit) as {
      blocks: Array<{ elements?: Array<{ action_id: string; value: string }> }>;
      channel: string;
      text: string;
      thread_ts: string;
    };
    expect(body).toMatchObject({
      channel: "C01",
      text: "Approve tool call: mongodb-mutate",
      thread_ts: "1700000000.000001",
    });

    const actions = body.blocks.find((block) => Array.isArray(block.elements));
    expect(actions).toMatchObject({
      block_id: buildHitlResponderBlockId({
        requestId: "approval_abc123",
        responderUserId: "U_REQUESTER",
      }),
    });
    const actionIds = actions?.elements?.map((element) => element.action_id) ?? [];
    expect(actionIds).toEqual([
      `${HITL_ACTION_PREFIX}approval_abc123:button:0`,
      `${HITL_ACTION_PREFIX}approval_abc123:button:1`,
    ]);
    expect(new Set(actionIds).size).toBe(actionIds.length);
  });

  it("input.requested caps section and fallback text so Slack does not reject the post", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const longPrompt = "x".repeat(SLACK_SECTION_TEXT_MAX_LENGTH + 500);

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: {
              callId: "call_long",
              input: {},
              kind: "tool-call",
              toolName: "ask_question",
            },
            display: "text",
            prompt: longPrompt,
            requestId: "call_long",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = parseSlackRequestBody(init as RequestInit) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
      text: string;
    };
    const promptSection = body.blocks.find((block) => block.type === "section");
    expect(promptSection?.text?.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX_LENGTH);
    expect(promptSection?.text?.text.endsWith("...")).toBe(true);
    expect(body.text.length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_MAX_LENGTH);
  });

  it("turn.started calls assistant.threads.setStatus", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("turn.started", { sequence: 0, stepIndex: 0, turnId: "t1" }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/assistant.threads.setStatus");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel_id: "C01",
      thread_ts: "1700000000.000001",
      status: "Working...",
      loading_messages: ["Working..."],
    });
  });

  it("reasoning.appended calls assistant.threads.setStatus with a truncated snippet", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const longReasoning =
      "Need to inspect the implementation and verify the Slack typing status behavior before editing.";

    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: longReasoning,
        reasoningSoFar: `${longReasoning}\nThen continue.`,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/assistant.threads.setStatus");
    const body = parseSlackRequestBody(init as RequestInit);
    expect(body).toMatchObject({
      channel_id: "C01",
      thread_ts: "1700000000.000001",
    });
    expect((body.status as string).length).toBeLessThanOrEqual(50);
    expect((body.status as string).endsWith("...")).toBe(true);
    expect(body.loading_messages).toEqual([body.status]);
    expect(ctx.state.lastReasoningTypingStatus).toBe(body.status);
  });

  it("reasoning.appended immediately publishes progressive extensions of four characters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const reasoningEvent = (reasoningDelta: string, reasoningSoFar: string) =>
      makeEvent("reasoning.appended", {
        reasoningDelta,
        reasoningSoFar,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      });

    await callEvent(adapter, reasoningEvent("I", "I"), ctx);
    await callEvent(adapter, reasoningEvent(" ca", "I ca"), ctx);
    await callEvent(adapter, reasoningEvent("n", "I can"), ctx);

    const statuses = fetchMock.mock.calls.map(
      ([, init]) => parseSlackRequestBody(init as RequestInit).status,
    );
    expect(statuses).toEqual(["I", "I can"]);
  });

  it("reasoning.appended requires a matching prefix and four new characters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());
    const reasoningEvent = (reasoningSoFar: string) =>
      makeEvent("reasoning.appended", {
        reasoningDelta: reasoningSoFar,
        reasoningSoFar,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      });

    await callEvent(adapter, reasoningEvent("Need"), ctx);
    vi.setSystemTime(new Date("2026-06-18T12:00:01Z"));
    await callEvent(adapter, reasoningEvent("Need to"), ctx);
    await callEvent(adapter, reasoningEvent("Check something else"), ctx);
    vi.setSystemTime(new Date("2026-06-18T12:00:05Z"));
    await callEvent(adapter, reasoningEvent("Need to"), ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statuses = fetchMock.mock.calls.map(
      ([, init]) => parseSlackRequestBody(init as RequestInit).status,
    );
    expect(statuses).toEqual(["Need", "Need to"]);
  });

  it("turn.started resets reasoning status throttling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T12:00:00Z"));
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: "Need to inspect the repo.",
        reasoningSoFar: "Need to inspect the repo.",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );
    vi.setSystemTime(new Date("2026-06-18T12:00:01Z"));
    await callEvent(
      adapter,
      makeEvent("turn.started", { sequence: 0, stepIndex: 0, turnId: "t2" }),
      ctx,
    );
    await callEvent(
      adapter,
      makeEvent("reasoning.appended", {
        reasoningDelta: "Fresh turn reasoning.",
        reasoningSoFar: "Fresh turn reasoning.",
        sequence: 1,
        stepIndex: 0,
        turnId: "t2",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const statuses = fetchMock.mock.calls.map(
      ([, init]) => parseSlackRequestBody(init as RequestInit).status,
    );
    expect(statuses).toEqual(["Need to inspect the repo.", "Working...", "Fresh turn reasoning."]);
  });

  it("session.failed posts a terminal markdown message with error hint and id", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("session.failed", {
        code: "internal",
        details: { errorId: "abc-123", name: "WorkflowExecutionFailed" },
        message: "boom",
        sessionId: "s1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(body.markdown_text).toContain("couldn't recover");
    expect(body.markdown_text).toContain("Start a new thread");
    expect(body.markdown_text).toContain("WorkflowExecutionFailed");
    expect(body.markdown_text).toContain("abc-123");
  });

  it("actions.requested typing indicator is truncated to Slack's length cap", async () => {
    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      THREAD_STATE,
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    const longTool = "search_internal_documentation_for_relevant_passages";

    await callEvent(
      adapter,
      makeEvent("actions.requested", {
        actions: [
          { kind: "tool-call", toolName: longTool, callId: "c1", input: {} },
          { kind: "tool-call", toolName: longTool, callId: "c2", input: {} },
          { kind: "tool-call", toolName: longTool, callId: "c3", input: {} },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect((body.status as string).length).toBeLessThanOrEqual(50);
    expect((body.status as string).endsWith("...")).toBe(true);
  });
});

describe("rebuildSlackContext", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("seeds ctx.slack with state channelId / threadTs / teamId", () => {
    const adapter = withState(getAdapter(slackChannel()), THREAD_STATE);
    const ctx = buildAdapterContext(adapter, stubAccessor());
    expect(ctx.slack.channelId).toBe("C01");
    expect(ctx.slack.threadTs).toBe("1700000000.000001");
    expect(ctx.slack.teamId).toBe("T01");
    expect(ctx.session).toBeDefined();
    expect("threadId" in ctx.thread).toBe(false);
    expect("id" in ctx.thread).toBe(false);
  });

  it("falls back to empty strings when state has no thread", () => {
    const adapter = withState(getAdapter(slackChannel()), {
      channelId: null,
      threadTs: null,
      teamId: null,
    });
    const ctx = buildAdapterContext(adapter, stubAccessor());
    expect(ctx.slack.channelId).toBe("");
    expect(ctx.slack.threadTs).toBe("");
    expect("threadId" in ctx.thread).toBe(false);
  });

  it("auto-anchors state.threadTs and re-keys the session on the first post", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1800000000.123456" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = withState(
      getAdapter(slackChannel({ credentials: { botToken: "xoxb-test" } })),
      {
        channelId: "C01",
        threadTs: null,
        teamId: null,
      },
    );
    const { accessor, writes } = captureAccessor("slack:C01:");
    const ctx = buildAdapterContext(adapter, accessor);

    // Fire message.completed → default handler posts the agent message.
    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Daily digest",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = parseSlackRequestBody(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(firstBody.thread_ts).toBeUndefined();
    expect((adapter.state as { threadTs: string | null }).threadTs).toBe("1800000000.123456");

    // The anchor moment wrote the new continuation token to context
    // via `session.setContinuationToken(...)`. The workflow body picks
    // this up via `reconcileSessionContinuationToken` after the step.
    const tokenWrites = writes.filter(([key]) => key === "eve.continuationToken");
    expect(tokenWrites).toEqual([["eve.continuationToken", "slack:C01:1800000000.123456"]]);

    // A follow-up message.completed now threads under the anchor.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, ts: "1800000000.999999" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Follow-up detail",
        sequence: 1,
        stepIndex: 1,
        turnId: "t2",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = parseSlackRequestBody(fetchMock.mock.calls[1]![1] as RequestInit);
    expect(secondBody.thread_ts).toBe("1800000000.123456");

    // Once anchored, setContinuationToken does not fire again — the
    // raw token is unchanged across subsequent posts.
    const allTokenWrites = writes.filter(([key]) => key === "eve.continuationToken");
    expect(allTokenWrites).toHaveLength(1);
  });
});

describe("defaultSlackAuth", () => {
  it("is exported from the public Slack entry point", () => {
    const auth = defaultSlackAuth(
      {
        attachments: [],
        author: {
          fullName: undefined,
          isBot: false,
          isMe: false,
          userId: "U01",
          userName: "ada",
        },
        channelId: "C01",
        markdown: "hello",
        raw: {},
        teamId: "T01",
        text: "hello",
        threadTs: "1700000000.000001",
        ts: "1700000000.000002",
      },
      {
        slack: { channelId: "C01", threadTs: "1700000000.000001", teamId: "T01" } as never,
        thread: {} as never,
      },
    );

    expect(auth).toMatchObject({
      attributes: {
        channel_id: "C01",
        thread_ts: "1700000000.000001",
        user_id: "U01",
        user_name: "ada",
      },
      authenticator: "slack-webhook",
      principalId: "slack:T01:U01",
      principalType: "user",
    });
  });
});
