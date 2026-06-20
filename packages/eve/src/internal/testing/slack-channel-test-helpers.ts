import { createHmac } from "node:crypto";

import { vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { decodeSlackApiBody } from "#public/channels/slack/api-encoding.js";

export const SLACK_TEST_SIGNING_SECRET = "test-signing-secret";

/** Decodes a captured form-encoded Slack API request for assertions. */
export function parseSlackRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  const contentType = init.headers ? new Headers(init.headers).get("content-type") : null;
  return decodeSlackApiBody(init.body, contentType) as Record<string, unknown>;
}

/** Builds a Slack-signed POST request for channel route tests. */
export function buildSignedSlackRequest(input: {
  readonly body: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly timestamp?: number;
  readonly signingSecret?: string;
}): Request {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = input.signingSecret ?? SLACK_TEST_SIGNING_SECRET;
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${input.body}`)
    .digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    method: "POST",
    headers: {
      "content-type": input.contentType ?? "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
      ...input.headers,
    },
    body: input.body,
  });
}

/** Invokes and drains the Slack channel POST route in a unit test. */
export async function fireSlackPost(
  channel: unknown,
  request: Request,
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected slack channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ id: "s1", continuationToken: "ct" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    send,
    waitUntil,
    getSession: vi.fn() as any,
    params: {},
    requestIp: null,
  } as any);

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}
