import { describe, expect, it } from "vitest";

import { eventId, eventLogId, operationId, sessionId } from "./ids.js";
import {
  EffectProtocolError,
  MemoryPrototypeService,
  type PrototypeService,
  SqlitePrototypeService,
} from "./service.js";
import { appendUser, emptyHistory } from "./transcript.js";

const serviceFactories = [
  { create: () => new MemoryPrototypeService(), name: "memory" },
  { create: () => new SqlitePrototypeService(":memory:"), name: "SQLite" },
] satisfies readonly { readonly create: () => PrototypeService; readonly name: string }[];

describe("prototype service", () => {
  it("deduplicates identical events and rejects an ID with different bytes", async () => {
    const service = new MemoryPrototypeService();
    const operation = operationId(sessionId("session-1"), 0, "event");
    const log = eventLogId("session-1:events");
    const event = {
      id: eventId(operation, 0),
      logId: log,
      operationId: operation,
      payload: { type: "test" },
      sequence: 0,
    } as const;

    await service.append([event]);
    await service.append([event]);

    expect(await service.read(log)).toEqual([event]);
    await expect(service.append([{ ...event, payload: { type: "different" } }])).rejects.toThrow(
      "different bytes",
    );
  });

  it("records one visible effect under repeated operation IDs", async () => {
    const service = new MemoryPrototypeService();
    const id = operationId(sessionId("session-1"), 0, "initialize");
    const call = {
      id,
      input: { continuationToken: "input-1", sessionId: sessionId("session-1") },
      name: "initialize-session",
      retry: { idempotency: "required", maxAttempts: 2 },
    } as const;

    await service.effect(call);
    await service.effect(call);

    expect(service.attemptCount(id)).toBe(2);
    expect(service.executionCount(id)).toBe(1);
    expect(service.visibleEffectCount(id)).toBe(1);
  });

  for (const { create, name } of serviceFactories) {
    it(`reuses a result committed before ambiguous completion in ${name}`, async () => {
      const service = create();
      const id = operationId(sessionId("session-1"), 0, "generate");
      const call = {
        id,
        input: {
          history: appendUser(emptyHistory(), "eventual"),
          scenario: { kind: "retry-once" },
        },
        name: "generate",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;

      try {
        await expect(service.effect(call)).rejects.toThrow(
          "Injected failure after the visible generation effect.",
        );
        expect(service.attemptCount(id)).toBe(1);
        expect(service.executionCount(id)).toBe(1);

        await expect(service.effect(call)).resolves.toEqual({
          assistant: { content: "retry:eventual", requestIds: [], role: "assistant" },
          finish: { output: "retry:eventual" },
          requests: [],
        });
        expect(service.attemptCount(id)).toBe(2);
        expect(service.executionCount(id)).toBe(1);
        expect(service.visibleEffectCount(id)).toBe(1);
      } finally {
        await service.close();
      }
    });

    it(`rejects conflicting committed result bytes in ${name}`, async () => {
      const service = create();
      const call = {
        id: operationId(sessionId("session-1"), 0, "initialize"),
        input: { continuationToken: "input-1", sessionId: sessionId("session-1") },
        name: "initialize-session",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;
      const first = JSON.stringify({ continuationToken: "input-1" });

      try {
        expect(service.commitResult(call, first)).toBe(first);
        expect(service.commitResult(call, first)).toBe(first);
        expect(() =>
          service.commitResult(call, JSON.stringify({ continuationToken: "different" })),
        ).toThrow("different bytes");
      } finally {
        await service.close();
      }
    });

    it(`rejects a malformed committed result in ${name}`, async () => {
      const service = create();
      const call = {
        id: operationId(sessionId("session-1"), 0, "initialize-malformed"),
        input: { continuationToken: "input-1", sessionId: sessionId("session-1") },
        name: "initialize-session",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;

      try {
        service.commitResult(call, "null");
        await expect(service.effect(call)).rejects.toThrow(EffectProtocolError);
      } finally {
        await service.close();
      }
    });

    it(`rejects shape-valid cached results that do not match their call in ${name}`, async () => {
      const service = create();
      const initialize = {
        id: operationId(sessionId("session-1"), 0, "initialize-mismatch"),
        input: { continuationToken: "input-1", sessionId: sessionId("session-1") },
        name: "initialize-session",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;
      const delivery = {
        id: operationId(sessionId("session-1"), 0, "delivery-mismatch"),
        input: { deliveryId: "delivery-1", kind: "message", message: "expected" },
        name: "deliver-input",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;
      const tool = {
        id: operationId(sessionId("session-1"), 0, "tool-mismatch"),
        input: {
          request: { input: null, kind: "tool", name: "echo", requestId: "request-1" },
        },
        name: "execute-tool",
        retry: { idempotency: "required", maxAttempts: 2 },
      } as const;

      try {
        service.commitResult(initialize, JSON.stringify({ continuationToken: "other" }));
        service.commitResult(
          delivery,
          JSON.stringify({ deliveryId: "delivery-2", kind: "message", message: "other" }),
        );
        service.commitResult(
          tool,
          JSON.stringify({ isError: false, requestId: "request-2", value: null }),
        );

        await expect(service.effect(initialize)).rejects.toThrow(EffectProtocolError);
        await expect(service.effect(delivery)).rejects.toThrow(EffectProtocolError);
        await expect(service.effect(tool)).rejects.toThrow(EffectProtocolError);
      } finally {
        await service.close();
      }
    });
  }

  it("does not alias semantic ID tuples containing delimiters", () => {
    const first = operationId(sessionId("s"), 0, "p:turn:1:q");
    const second = operationId(sessionId("s:turn:0:p"), 1, "q");

    expect(first).not.toBe(second);
  });
});
