import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createTextWithFileContent } from "#client/file-parts.js";
import type { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import type { SendTurnInput, SendTurnPayload, SessionState } from "#client/types.js";
import type {
  AuthorizationRequiredStreamEvent,
  HandleMessageStreamEvent,
  TurnFailureStreamEvent,
} from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import {
  deriveResultStatus,
  extractCompletedMessage,
  extractInputRequests,
} from "#client/session-utils.js";
import { extractCompletedResult } from "#client/output-schema.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import type {
  EveEvalAuthorizationInput,
  EveEvalSession,
  EveEvalSessionResult,
  EveEvalTargetHandle,
  EveEvalToolCall,
  EveEvalTurn,
} from "#evals/types.js";

const AUTH_CALLBACK_RETRY_INTERVAL_MS = 100;
const AUTH_CALLBACK_TIMEOUT_MS = 10_000;

/**
 * Error thrown by {@link EveEvalTurn.expectOk} when a turn failed.
 */
export class EveEvalTurnFailedError extends Error {
  readonly event: TurnFailureStreamEvent | undefined;
  readonly turn: EveEvalTurn;

  constructor(turn: EveEvalTurn) {
    const event = turn.events.find(isTurnFailureEvent);
    const detail =
      event === undefined
        ? `turn ended with status "${turn.status}"`
        : `${event.type}: ${event.data.code} ${event.data.message}`.trim();
    super(`Eval turn failed: ${detail}`);
    this.name = "EveEvalTurnFailedError";
    this.event = event;
    this.turn = turn;
  }
}

export class EvalSessionDriver implements EveEvalSession {
  readonly #session: ClientSession;
  readonly #signal: AbortSignal | undefined;
  readonly #events: HandleMessageStreamEvent[] = [];
  #lastTurn: EvalTurn | undefined;
  #pendingInputRequests: readonly InputRequest[] = [];

  constructor(input: { readonly session: ClientSession; readonly signal?: AbortSignal }) {
    this.#session = input.session;
    this.#signal = input.signal;
  }

  get events(): readonly HandleMessageStreamEvent[] {
    return this.#events;
  }

  get lastTurn(): EveEvalTurn | undefined {
    return this.#lastTurn;
  }

  get pendingInputRequests(): readonly InputRequest[] {
    return this.#pendingInputRequests;
  }

  get sessionId(): string | undefined {
    return this.#session.state.sessionId ?? this.#lastTurn?.sessionId;
  }

  get state(): SessionState {
    return this.#session.state;
  }

  expectInputRequests(filter?: {
    readonly display?: InputRequest["display"];
    readonly toolName?: string;
  }): readonly InputRequest[] {
    if (this.#pendingInputRequests.length === 0) {
      throw new Error("Expected pending input requests, but the last turn did not park.");
    }

    const matching = this.#pendingInputRequests.filter((request) =>
      inputRequestMatches(request, filter),
    );
    if (matching.length === 0) {
      throw new Error(`No pending input requests matched ${formatInputRequestFilter(filter)}.`);
    }

    return matching;
  }

  async respond(...responses: InputResponse[]): Promise<EveEvalTurn> {
    if (responses.length === 0) {
      throw new Error("respond() requires at least one input response.");
    }

    return await this.send({ inputResponses: responses });
  }

  async respondAll(optionId: string): Promise<EveEvalTurn> {
    const requests = this.expectInputRequests();
    for (const request of requests) {
      assertRequestHasOption(request, optionId);
    }

    return await this.respond(
      ...requests.map((request) => ({
        optionId,
        requestId: request.requestId,
      })),
    );
  }

  async authorize(
    input: SendTurnInput,
    authorizations: readonly EveEvalAuthorizationInput[],
    target: Pick<EveEvalTargetHandle, "fetch" | "url">,
  ): Promise<EveEvalTurn> {
    if (authorizations.length === 0) {
      throw new Error("authorize() requires at least one expected authorization.");
    }

    const pending = buildExpectedAuthorizationMap(authorizations);
    const response = await this.#session.send(attachSignal(input, this.#signal));
    const events: HandleMessageStreamEvent[] = [];
    let callbacksStarted = false;
    let callbacksDone = false;
    let callbacksPromise: Promise<void> | undefined;
    const iterator = response[Symbol.asyncIterator]();
    let nextEvent = iterator.next();

    const recordTurn = (): EveEvalTurn =>
      this.#recordTurn({
        data: extractCompletedResult(events),
        events,
        inputRequests: extractInputRequests(events),
        message: extractCompletedMessage(events),
        sessionId: response.sessionId,
        status: deriveResultStatus(events),
      });

    try {
      while (true) {
        const result = await raceEventAndCallbacks(nextEvent, callbacksPromise, callbacksDone);

        if (result.kind === "callbacks") {
          callbacksDone = true;
          continue;
        }

        const { value, done } = result.next;
        if (done === true) break;
        nextEvent = iterator.next();
        events.push(value);

        if (!callbacksStarted && value.type === "authorization.required") {
          recordAuthorizationEvent(pending, value);
          if (allExpectedAuthorizationsReady(pending)) {
            callbacksStarted = true;
            callbacksPromise = completeExpectedAuthorizations(pending, target);
          }
        }
      }
    } catch (error) {
      if (events.length > 0) {
        recordTurn();
      }
      throw error;
    }

    if (!callbacksStarted) {
      recordTurn();
      const failure = events.find(isTurnFailureEvent);
      if (failure !== undefined) {
        throw new Error(
          `Expected authorization.required events for ${authorizationNames(
            authorizations,
          )}, but the turn failed before they were all observed: ${failure.type}: ${failure.data.code} ${failure.data.message}`,
        );
      }
      throw new Error(
        `Expected authorization.required events for ${authorizationNames(
          authorizations,
        )}, but the turn ended before they were all observed.`,
      );
    }

    await callbacksPromise;

    return recordTurn();
  }

  async send(input: SendTurnInput): Promise<EveEvalTurn> {
    const response = await this.#session.send(attachSignal(input, this.#signal));
    const result = await response.result();
    return this.#recordTurn({
      data: result.data,
      events: result.events,
      inputRequests: result.inputRequests,
      message: result.message,
      sessionId: result.sessionId,
      status: result.status,
    });
  }

  async sendFile(text: string, filePath: string, mediaType?: string): Promise<EveEvalTurn> {
    const bytes = await readFile(filePath);
    const message = createTextWithFileContent({
      bytes,
      filename: basename(filePath),
      mediaType: mediaType ?? inferMediaType(filePath),
      text,
    });
    return await this.send({ message });
  }

  async readTurn(options?: { readonly startIndex?: number }): Promise<EveEvalTurn> {
    const sessionId = this.sessionId;
    const events: HandleMessageStreamEvent[] = [];
    let sawBoundary = false;

    for await (const event of this.#session.stream({
      signal: this.#signal,
      startIndex: options?.startIndex,
    })) {
      events.push(event);

      if (isCurrentTurnBoundaryEvent(event)) {
        sawBoundary = true;
        break;
      }
    }

    if (!sawBoundary) {
      throw new Error(
        `Stream for session "${this.sessionId ?? "(unknown)"}" closed before a turn boundary.`,
      );
    }

    return this.#recordTurn({
      data: extractCompletedResult(events),
      events,
      inputRequests: extractInputRequests(events),
      message: extractCompletedMessage(events),
      sessionId,
      status: deriveResultStatus(events),
    });
  }

  snapshot(primary: boolean): EveEvalSessionResult {
    const sessionId = this.sessionId;
    return {
      derived: deriveRunFacts(this.#events, { sessionId }),
      events: [...this.#events],
      primary,
      sessionId,
      state: this.#session.state,
    };
  }

  #recordTurn(input: {
    readonly data: unknown;
    readonly events: readonly HandleMessageStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly sessionId: string | undefined;
    readonly status: "completed" | "failed" | "waiting";
  }): EveEvalTurn {
    this.#events.push(...input.events);
    this.#pendingInputRequests = input.status === "waiting" ? input.inputRequests : [];

    const derived = deriveRunFacts(input.events, { sessionId: input.sessionId });
    const turn = new EvalTurn({
      data: input.data,
      events: input.events,
      inputRequests: input.inputRequests,
      message: input.message,
      sessionId: input.sessionId ?? this.sessionId ?? "",
      status: input.status,
      toolCalls: derived.toolCalls,
    });
    this.#lastTurn = turn;
    return turn;
  }
}

interface PendingAuthorizationExpectation {
  readonly input: EveEvalAuthorizationInput;
  event?: AuthorizationRequiredStreamEvent;
}

function buildExpectedAuthorizationMap(
  authorizations: readonly EveEvalAuthorizationInput[],
): Map<string, PendingAuthorizationExpectation> {
  const pending = new Map<string, PendingAuthorizationExpectation>();
  for (const input of authorizations) {
    if (pending.has(input.name)) {
      throw new Error(`authorize() received duplicate authorization name "${input.name}".`);
    }
    pending.set(input.name, { input });
  }
  return pending;
}

function recordAuthorizationEvent(
  pending: Map<string, PendingAuthorizationExpectation>,
  event: AuthorizationRequiredStreamEvent,
): void {
  const entry = pending.get(event.data.name);
  if (entry === undefined) return;
  entry.event = event;
}

function allExpectedAuthorizationsReady(
  pending: Map<string, PendingAuthorizationExpectation>,
): boolean {
  return [...pending.values()].every((entry) => entry.event !== undefined);
}

async function raceEventAndCallbacks(
  nextEvent: Promise<IteratorResult<HandleMessageStreamEvent>>,
  callbacksPromise: Promise<void> | undefined,
  callbacksDone: boolean,
): Promise<
  | { readonly kind: "event"; readonly next: IteratorResult<HandleMessageStreamEvent> }
  | { readonly kind: "callbacks" }
> {
  if (callbacksPromise === undefined || callbacksDone) {
    return { kind: "event", next: await nextEvent };
  }

  return await Promise.race([
    nextEvent.then((next) => ({ kind: "event", next }) as const),
    callbacksPromise.then(() => ({ kind: "callbacks" }) as const),
  ]);
}

async function completeExpectedAuthorizations(
  pending: Map<string, PendingAuthorizationExpectation>,
  target: Pick<EveEvalTargetHandle, "fetch" | "url">,
): Promise<void> {
  await Promise.all(
    [...pending.values()].map((entry) => completeExpectedAuthorizationEvent(entry, target)),
  );
}

async function completeExpectedAuthorizationEvent(
  entry: PendingAuthorizationExpectation,
  target: Pick<EveEvalTargetHandle, "fetch" | "url">,
): Promise<void> {
  const event = entry.event;
  if (event === undefined) {
    throw new Error(`Missing authorization.required event for "${entry.input.name}".`);
  }

  const webhookUrl = event.data.webhookUrl;
  if (webhookUrl === undefined) {
    throw new Error(`authorization.required for "${entry.input.name}" did not include webhookUrl.`);
  }

  await completeExpectedAuthorization(entry, target, webhookUrl);
}

async function completeExpectedAuthorization(
  entry: PendingAuthorizationExpectation,
  target: Pick<EveEvalTargetHandle, "fetch" | "url">,
  webhookUrl: string,
): Promise<void> {
  const callbackPath = callbackPathFromWebhookUrl(webhookUrl, target.url, entry.input.params);
  const deadline = Date.now() + AUTH_CALLBACK_TIMEOUT_MS;

  while (true) {
    const response = await target.fetch(callbackPath, { method: "GET" });
    if (response.ok) return;

    const body = await response.text().catch(() => "");
    if (!shouldRetryAuthorizationCallback(response, body) || Date.now() >= deadline) {
      throw new Error(
        `Authorization callback for "${entry.input.name}" failed: ${response.status} ${response.statusText}` +
          (body.trim().length > 0 ? `, ${body.trim()}` : ""),
      );
    }

    await sleep(AUTH_CALLBACK_RETRY_INTERVAL_MS);
  }
}

function shouldRetryAuthorizationCallback(response: Response, body: string): boolean {
  return response.status === 404 && body.includes("Connection callback not pending");
}

function authorizationNames(authorizations: readonly EveEvalAuthorizationInput[]): string {
  return authorizations.map((entry) => JSON.stringify(entry.name)).join(", ");
}

function callbackPathFromWebhookUrl(
  webhookUrl: string,
  targetUrl: string,
  params: Readonly<Record<string, string>> | undefined,
): string {
  const callback = new URL(webhookUrl);
  for (const [key, value] of Object.entries(params ?? { code: "authorized" })) {
    callback.searchParams.set(key, value);
  }

  const base = new URL(targetUrl);
  const basePath = trimTrailingSlash(base.pathname);
  let pathname = callback.pathname;
  if (basePath.length > 0 && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  }

  return `${pathname}${callback.search}`;
}

function trimTrailingSlash(value: string): string {
  return value === "/" || !value.endsWith("/") ? (value === "/" ? "" : value) : value.slice(0, -1);
}

class EvalTurn implements EveEvalTurn {
  readonly data: unknown;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "waiting";
  readonly toolCalls: readonly EveEvalToolCall[];

  constructor(input: {
    readonly data: unknown;
    readonly events: readonly HandleMessageStreamEvent[];
    readonly inputRequests: readonly InputRequest[];
    readonly message: string | undefined;
    readonly sessionId: string;
    readonly status: "completed" | "failed" | "waiting";
    readonly toolCalls: readonly EveEvalToolCall[];
  }) {
    this.data = input.data;
    this.events = input.events;
    this.inputRequests = input.inputRequests;
    this.message = input.message;
    this.sessionId = input.sessionId;
    this.status = input.status;
    this.toolCalls = input.toolCalls;
  }

  expectOk(): this {
    if (this.status !== "failed") return this;
    throw new EveEvalTurnFailedError(this);
  }
}

export class EvalSessionManager {
  readonly #client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #sessions: EvalSessionDriver[] = [];
  #primary: EvalSessionDriver | undefined;

  constructor(input: { readonly client: Client; readonly signal?: AbortSignal }) {
    this.#client = input.client;
    this.#signal = input.signal;
  }

  get primary(): EvalSessionDriver {
    this.#primary ??= this.#createSession();
    return this.#primary;
  }

  newSession(): EvalSessionDriver {
    return this.#createSession();
  }

  async attachSession(
    sessionId: string,
    options?: { readonly startIndex?: number },
  ): Promise<EvalSessionDriver> {
    const session = new EvalSessionDriver({
      session: this.#client.session({ sessionId, streamIndex: options?.startIndex ?? 0 }),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    await session.readTurn(options);
    return session;
  }

  snapshots(): readonly EveEvalSessionResult[] {
    return this.#sessions.map((session) => session.snapshot(session === this.#primary));
  }

  lastTurnSession(): EvalSessionDriver | undefined {
    if (this.#primary?.lastTurn !== undefined) {
      return this.#primary;
    }

    return this.#sessions.find((session) => session.lastTurn !== undefined);
  }

  #createSession(): EvalSessionDriver {
    const session = new EvalSessionDriver({
      session: this.#client.session(),
      signal: this.#signal,
    });
    this.#sessions.push(session);
    return session;
  }
}

function attachSignal(input: SendTurnInput, signal: AbortSignal | undefined): SendTurnInput {
  if (signal === undefined) return input;

  if (typeof input === "string") {
    return { message: input, signal };
  }

  const payload = input as SendTurnPayload;
  return payload.signal === undefined ? { ...payload, signal } : payload;
}

function inputRequestMatches(
  request: InputRequest,
  filter: { readonly display?: InputRequest["display"]; readonly toolName?: string } | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.display !== undefined && request.display !== filter.display) return false;
  if (filter.toolName !== undefined) {
    return request.action.kind === "tool-call" && request.action.toolName === filter.toolName;
  }
  return true;
}

function formatInputRequestFilter(
  filter: { readonly display?: InputRequest["display"]; readonly toolName?: string } | undefined,
): string {
  if (filter === undefined) return "{}";
  return JSON.stringify(filter);
}

function assertRequestHasOption(request: InputRequest, optionId: string): void {
  if (request.options === undefined || request.options.length === 0) {
    throw new Error(`Input request "${request.requestId}" has no selectable options.`);
  }

  if (!request.options.some((option) => option.id === optionId)) {
    throw new Error(`Input request "${request.requestId}" does not offer option "${optionId}".`);
  }
}

function inferMediaType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
