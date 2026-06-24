import { describe, expect, it } from "vitest";

import { finalizeCancellationStep } from "#execution/cancellation-step.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("finalizeCancellationStep integration", () => {
  it("cancels a parked session without emitting a phantom turn boundary", async () => {
    const app = createTestRuntime({ agent: { name: "parked-session-cancellation" } });

    await app.run(async () => {
      const continuationToken = "http:parked-session-cancellation";
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const serializedContext = {
        "eve.auth": null,
        "eve.bundle": { source: compiledArtifactsSource },
        "eve.channel": { kind: "http", state: {} },
        "eve.continuationToken": continuationToken,
        "eve.mode": "conversation",
        "eve.sessionId": "session-1",
      };
      const state = createDurableSessionState({
        session: {
          agent: { modelReference: { id: "test" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          history: [],
          sessionId: "session-1",
          continuationToken,
        },
      });
      const chunks: Uint8Array[] = [];

      await finalizeCancellationStep({
        parentWritable: new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
        }),
        scope: "session",
        serializedContext,
        sessionState: state,
      });

      const events = new TextDecoder()
        .decode(concatChunks(chunks))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.map((event) => event.type)).toEqual(["session.cancelled"]);
    });
  });
});

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
