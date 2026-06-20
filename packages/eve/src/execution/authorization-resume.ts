import type { DeliverPayload, HookPayload } from "#channel/types.js";
import {
  consumePendingAuthorization,
  getPendingAuthorization,
  type AuthorizationResult,
} from "#harness/authorization.js";
import type { HarnessSession } from "#harness/types.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";

export interface ResumedAuthorization {
  readonly authorization: ConnectionAuthorizationChallenge;
  readonly name: string;
}

export interface ResumedAuthorizationResult extends AuthorizationResult {
  readonly name: string;
}

export function consumeAuthorizationCallbacks(input: {
  readonly delivery: HookPayload | undefined;
  readonly session: HarnessSession;
}): {
  readonly authorizations: readonly ResumedAuthorization[];
  readonly delivery: HookPayload | undefined;
  readonly results: readonly ResumedAuthorizationResult[];
  readonly session: HarnessSession;
} {
  const pending = getPendingAuthorization(input.session.state);
  if (pending === undefined || input.delivery?.kind !== "deliver") {
    return { authorizations: [], delivery: input.delivery, results: [], session: input.session };
  }

  const results: ResumedAuthorizationResult[] = [];
  const remainingPayloads: DeliverPayload[] = [];
  const resumedNames = new Set<string>();
  for (const payload of input.delivery.payloads) {
    const callback = payload["authorizationCallback"] as
      | { connectionName: string; callback: AuthorizationCallback }
      | undefined;
    if (callback === undefined) {
      remainingPayloads.push(payload);
      continue;
    }

    const challenge = pending.challenges.find((entry) => entry.name === callback.connectionName);
    if (challenge === undefined || resumedNames.has(challenge.name)) continue;
    resumedNames.add(challenge.name);
    results.push({
      callback: callback.callback,
      hookUrl: challenge.hookUrl,
      name: challenge.name,
      resume: challenge.resume,
    });
  }

  if (results.length === 0) {
    return { authorizations: [], delivery: input.delivery, results: [], session: input.session };
  }

  const consumed = consumePendingAuthorization(
    input.session.state,
    results.map((result) => result.name),
  );
  const authorizations = consumed.consumed.map((entry) => ({
    authorization: entry.challenge,
    name: entry.name,
  }));
  const delivery =
    remainingPayloads.length > 0 ? { ...input.delivery, payloads: remainingPayloads } : undefined;
  const session =
    consumed.sessionState === input.session.state
      ? input.session
      : { ...input.session, state: consumed.sessionState };
  return { authorizations, delivery, results, session };
}
