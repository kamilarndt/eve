import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSignedSlackRequest as buildSignedRequest,
  fireSlackPost as firePost,
  parseSlackRequestBody,
  SLACK_TEST_SIGNING_SECRET as SIGNING_SECRET,
} from "#internal/testing/slack-channel-test-helpers.js";
import {
  buildHitlResponderBlockId,
  HITL_ACTION_PREFIX,
  HITL_FREEFORM_ACTION_PREFIX,
  HITL_FREEFORM_MODAL_ACTION_ID,
  HITL_FREEFORM_MODAL_BLOCK_ID,
  HITL_FREEFORM_MODAL_CALLBACK_ID,
  parseHitlResponderBinding,
} from "#public/channels/slack/hitl.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";

function buildSignedInteractionRequest(payload: Record<string, unknown>): Request {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return buildSignedRequest({
    body,
    contentType: "application/x-www-form-urlencoded",
  });
}

function makeResponderBinding(responderUserId: string, requestId: string) {
  const binding = parseHitlResponderBinding(
    buildHitlResponderBlockId({ requestId, responderUserId }),
  );
  if (!binding) throw new Error("Expected a valid responder binding.");
  return binding;
}

function buildHitlBlockActionPayload(input: {
  readonly actorUserId: string;
  readonly kind: "button" | "freeform";
  readonly responderUserId: string;
}): Record<string, unknown> {
  const requestId = input.kind === "button" ? "approval_abc123" : "call_abc123";
  const action =
    input.kind === "button"
      ? {
          action_id: `${HITL_ACTION_PREFIX}${requestId}:button:0`,
          block_id: buildHitlResponderBlockId({
            requestId,
            responderUserId: input.responderUserId,
          }),
          text: { type: "plain_text", text: "Approve" },
          value: "approve",
        }
      : {
          action_id: `${HITL_FREEFORM_ACTION_PREFIX}${requestId}`,
          block_id: buildHitlResponderBlockId({
            requestId,
            responderUserId: input.responderUserId,
          }),
          text: { type: "plain_text", text: "Type your answer" },
          value: requestId,
        };

  return {
    actions: [action],
    channel: { id: "C01" },
    message: {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Approve?" } }],
      thread_ts: "1700000000.000001",
      ts: "1700000000.000010",
    },
    team: { id: "T01" },
    trigger_id: "trigger-1",
    type: "block_actions",
    user: {
      id: input.actorUserId,
      name: "test-user",
      team_id: "T01",
      username: "test-user",
    },
  };
}

function buildFreeformSubmissionPayload(input: {
  readonly actorUserId: string;
  readonly responderUserId: string;
  readonly text: string;
}): Record<string, unknown> {
  return {
    team: { id: "T01" },
    type: "view_submission",
    user: {
      id: input.actorUserId,
      name: "test-user",
      team_id: "T01",
      username: "test-user",
    },
    view: {
      callback_id: HITL_FREEFORM_MODAL_CALLBACK_ID,
      private_metadata: JSON.stringify({
        channelId: "C01",
        continuationToken: "C01:1700000000.000001",
        messageTs: "1700000000.000010",
        requestId: "call_abc123",
        responderBinding: makeResponderBinding(input.responderUserId, "call_abc123"),
        threadTs: "1700000000.000001",
      }),
      state: {
        values: {
          [HITL_FREEFORM_MODAL_BLOCK_ID]: {
            [HITL_FREEFORM_MODAL_ACTION_ID]: { value: input.text },
          },
        },
      },
    },
  };
}

describe("slackChannel() HITL interaction pipeline", () => {
  const ORIGINAL_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  const ORIGINAL_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: "1700000001.000001" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    if (ORIGINAL_SIGNING_SECRET === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = ORIGINAL_SIGNING_SECRET;
    }
    if (ORIGINAL_BOT_TOKEN === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = ORIGINAL_BOT_TOKEN;
    }
  });

  it("resumes HITL button answers with the approving Slack user auth", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "block_actions",
        team: { id: "T01" },
        user: {
          id: "U_APPROVER",
          username: "ada",
          name: "ada",
          team_id: "T01",
        },
        channel: { id: "C01" },
        message: {
          ts: "1700000000.000010",
          thread_ts: "1700000000.000001",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Approve?" } }],
        },
        actions: [
          {
            action_id: `${HITL_ACTION_PREFIX}approval_abc123:button:0`,
            block_id: buildHitlResponderBlockId({
              requestId: "approval_abc123",
              responderUserId: "U_APPROVER",
            }),
            text: { type: "plain_text", text: "Approve" },
            value: "approve",
          },
        ],
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "approval_abc123" }],
    });
    expect(options).toMatchObject({
      auth: {
        attributes: {
          author_type: "user",
          channel_id: "C01",
          team_id: "T01",
          thread_ts: "1700000000.000001",
          user_id: "U_APPROVER",
          user_name: "ada",
        },
        authenticator: "slack-webhook",
        issuer: "slack:T01",
        principalId: "slack:T01:U_APPROVER",
        principalType: "user",
      },
      continuationToken: "C01:1700000000.000001",
      state: {
        channelId: "C01",
        teamId: "T01",
        threadTs: "1700000000.000001",
        triggeringUserId: "U_APPROVER",
      },
    });
  });

  it("rejects HITL button answers from a different Slack user", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest(
        buildHitlBlockActionPayload({
          actorUserId: "U_INTRUDER",
          kind: "button",
          responderUserId: "U_OWNER",
        }),
      ),
    );

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postEphemeral");
    expect(parseSlackRequestBody(init as RequestInit)).toMatchObject({
      channel: "C01",
      thread_ts: "1700000000.000001",
      user: "U_INTRUDER",
    });
  });

  it("explains that an unbound HITL card must be recreated", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const payload = buildHitlBlockActionPayload({
      actorUserId: "U_OWNER",
      kind: "button",
      responderUserId: "U_OWNER",
    });
    const action = (payload.actions as Array<Record<string, unknown>>)[0];
    if (!action) throw new Error("Expected an interaction action.");
    action.block_id = "legacy-actions";

    const { send } = await firePost(channel, buildSignedInteractionRequest(payload));

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postEphemeral");
    expect(parseSlackRequestBody(init as RequestInit)).toMatchObject({
      channel: "C01",
      markdown_text:
        "This prompt is no longer valid. Start a new request so it can be bound to your Slack identity.",
      thread_ts: "1700000000.000001",
      user: "U_OWNER",
    });
  });

  it("does not open a freeform modal for a different Slack user", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest(
        buildHitlBlockActionPayload({
          actorUserId: "U_INTRUDER",
          kind: "freeform",
          responderUserId: "U_OWNER",
        }),
      ),
    );

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://slack.com/api/chat.postEphemeral");
  });

  it("opens a freeform modal for the bound Slack user", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest(
        buildHitlBlockActionPayload({
          actorUserId: "U_OWNER",
          kind: "freeform",
          responderUserId: "U_OWNER",
        }),
      ),
    );

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/views.open");
    const requestBody = JSON.parse(String((init as RequestInit).body)) as {
      view: { private_metadata: string };
    };
    const metadata = JSON.parse(requestBody.view.private_metadata) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      requestId: "call_abc123",
      responderBinding: makeResponderBinding("U_OWNER", "call_abc123"),
    });
    expect(metadata).not.toHaveProperty("responderUserId");
  });

  it("resumes freeform modal answers with the submitting Slack user auth", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "view_submission",
        team: { id: "T01" },
        user: {
          id: "U_SUBMITTER",
          username: "grace",
          name: "grace",
          team_id: "T01",
        },
        view: {
          callback_id: HITL_FREEFORM_MODAL_CALLBACK_ID,
          private_metadata: JSON.stringify({
            channelId: "C01",
            continuationToken: "C01:1700000000.000001",
            messageTs: "1700000000.000010",
            requestId: "call_abc123",
            responderBinding: makeResponderBinding("U_SUBMITTER", "call_abc123"),
            threadTs: "1700000000.000001",
          }),
          state: {
            values: {
              [HITL_FREEFORM_MODAL_BLOCK_ID]: {
                [HITL_FREEFORM_MODAL_ACTION_ID]: { value: "approved with context" },
              },
            },
          },
        },
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toEqual({
      inputResponses: [{ requestId: "call_abc123", text: "approved with context" }],
    });
    expect(options).toMatchObject({
      auth: {
        attributes: {
          author_type: "user",
          channel_id: "C01",
          team_id: "T01",
          thread_ts: "1700000000.000001",
          user_id: "U_SUBMITTER",
          user_name: "grace",
        },
        authenticator: "slack-webhook",
        issuer: "slack:T01",
        principalId: "slack:T01:U_SUBMITTER",
        principalType: "user",
      },
      continuationToken: "C01:1700000000.000001",
      state: {
        channelId: "C01",
        teamId: "T01",
        threadTs: "1700000000.000001",
        triggeringUserId: "U_SUBMITTER",
      },
    });
  });

  it("rejects freeform modal answers from a different Slack user", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest(
        buildFreeformSubmissionPayload({
          actorUserId: "U_INTRUDER",
          responderUserId: "U_OWNER",
          text: "delete it",
        }),
      ),
    );

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://slack.com/api/chat.postEphemeral");
    expect(parseSlackRequestBody(init as RequestInit)).toMatchObject({
      channel: "C01",
      thread_ts: "1700000000.000001",
      user: "U_INTRUDER",
    });
  });
});
