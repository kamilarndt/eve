import { describe, expect, it } from "vitest";

import { mergeChatMessages, projectChatMessages } from "@ui/controllers/live/chat-projection";
import type { LiveLogEntry, LiveRun, LiveRunEvent } from "@ui/controllers/live/live-types";
import {
  classifyFrameSource,
  createLiveScenario,
  projectAgent,
  projectLog,
  projectPause,
  projectRun,
  projectTimelineEvent,
  mergeTimelineEvents,
} from "@ui/controllers/live/projections";

describe("live DevTools projections", () => {
  it("preserves pending action state on projected sessions", () => {
    const run: LiveRun = {
      createdAt: "2026-06-20T10:00:00.000Z",
      eventCount: 2,
      pendingAction: { kind: "question", name: "ask_question" },
      retainedEventCount: 2,
      sessionId: "session-1",
      status: "waiting",
      title: "Pick a city",
      updatedAt: "2026-06-20T10:00:00.000Z",
    };

    expect(projectRun(run)).toMatchObject({
      label: "Pick a city",
      pendingAction: { kind: "question", name: "ask_question" },
      status: "waiting",
    });
    expect(projectRun({ ...run, title: undefined }).label).toBe("Untitled session");
  });

  it("projects the resolved agent payload into the Agent tree", () => {
    const definitions = projectAgent({
      agent: {
        agentRoot: "/workspace/weather/agent",
        appRoot: "/workspace/weather",
        model: { id: "anthropic/claude-haiku-4.5" },
        name: "weather-agent",
      },
      tools: {
        available: [
          {
            description: "Get weather",
            logicalPath: "tools/get_weather.ts",
            name: "get_weather",
            origin: "authored",
          },
          {
            description: "Framework echo",
            logicalPath: "tools/framework_echo.ts",
            name: "framework_echo",
            origin: "framework",
          },
        ],
      },
    });

    expect(definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", label: "get_weather" }),
        expect.objectContaining({ id: "tools:authored", kind: "group", label: "Authored" }),
        expect.objectContaining({ id: "tools:framework", kind: "group", label: "Framework" }),
        expect.objectContaining({ kind: "model", label: "anthropic/claude-haiku-4.5" }),
      ]),
    );
    expect(definitions.find((definition) => definition.label === "get_weather")?.parentId).toBe(
      "tools:authored",
    );
    expect(definitions.find((definition) => definition.label === "framework_echo")?.parentId).toBe(
      "tools:framework",
    );
    expect(definitions.find((definition) => definition.label === "get_weather")?.source).toEqual({
      line: 1,
      path: "agent/tools/get_weather.ts",
    });
  });

  it("projects canonical run events with Eve coordinates", () => {
    const envelope: LiveRunEvent = {
      cursor: "12",
      event: {
        data: {
          actions: [{ callId: "call-7", input: { city: "Berlin" }, toolName: "get_weather" }],
          stepIndex: 1,
          turnId: "turn-3",
        },
        type: "actions.requested",
      },
      sessionId: "session-1",
    };

    expect(projectTimelineEvent(envelope, "rev-1", new Map())).toMatchObject({
      coordinates: {
        action: "call-7",
        revision: "rev-1",
        session: "session-1",
        step: "1",
        turn: "turn-3",
      },
      kind: "action",
      summary: "get_weather",
    });
  });

  it("does not let a stale refresh remove newer timeline events", () => {
    const first = projectTimelineEvent(
      {
        cursor: "1",
        event: { data: {}, type: "session.started" },
        sessionId: "session-1",
      },
      "rev-1",
      new Map(),
    );
    const second = projectTimelineEvent(
      {
        cursor: "2",
        event: { data: { message: "hello" }, type: "message.received" },
        sessionId: "session-1",
      },
      "rev-1",
      new Map(),
    );
    if (first === undefined || second === undefined) throw new Error("Expected visible events.");

    expect(mergeTimelineEvents([first, second], "session-1", [first])).toEqual([first, second]);
  });

  it("projects streamed messages, reasoning, and tool lifecycles into chat", () => {
    const envelopes: LiveRunEvent[] = [
      runEvent("1", "message.received", { message: "Weather in Berlin?", turnId: "turn-1" }),
      runEvent("2", "reasoning.appended", {
        reasoningSoFar: "I should check the weather.",
        stepIndex: 0,
        turnId: "turn-1",
      }),
      runEvent("3", "message.appended", {
        messageSoFar: "I’ll check.",
        stepIndex: 0,
        turnId: "turn-1",
      }),
      runEvent("4", "message.completed", {
        finishReason: "tool-calls",
        message: "I’ll check.",
        stepIndex: 0,
        turnId: "turn-1",
      }),
      runEvent("5", "actions.requested", {
        actions: [
          {
            callId: "call-1",
            input: { city: "Berlin" },
            kind: "tool-call",
            toolName: "get_weather",
          },
        ],
        stepIndex: 0,
        turnId: "turn-1",
      }),
      runEvent("6", "action.result", {
        result: {
          callId: "call-1",
          kind: "tool-result",
          output: { temperature: 18 },
          toolName: "get_weather",
        },
        status: "completed",
        stepIndex: 0,
        turnId: "turn-1",
      }),
      runEvent("7", "message.appended", {
        messageSoFar: "It is 18°C.",
        stepIndex: 1,
        turnId: "turn-1",
      }),
      runEvent("8", "message.completed", {
        finishReason: "stop",
        message: "It is 18°C.",
        stepIndex: 1,
        turnId: "turn-1",
      }),
      runEvent("9", "turn.completed", { turnId: "turn-1" }),
    ];

    expect(projectChatMessages(envelopes)).toEqual([
      expect.objectContaining({
        parts: [expect.objectContaining({ text: "Weather in Berlin?", type: "text" })],
        role: "user",
      }),
      expect.objectContaining({
        parts: [
          expect.objectContaining({ text: "I should check the weather.", type: "reasoning" }),
          expect.objectContaining({ state: "done", text: "I’ll check.", type: "text" }),
          expect.objectContaining({
            input: { city: "Berlin" },
            name: "get_weather",
            output: { temperature: 18 },
            state: "completed",
            type: "tool",
          }),
          expect.objectContaining({ state: "done", text: "It is 18°C.", type: "text" }),
        ],
        role: "assistant",
        status: "complete",
      }),
    ]);
  });

  it("keeps an optimistic user message while an older stream replay is projected", () => {
    const optimistic = {
      id: "optimistic:submission-1:user",
      optimistic: true as const,
      parts: [{ state: "done" as const, text: "Next message", type: "text" as const }],
      role: "user" as const,
      sessionId: "session-1",
      status: "streaming" as const,
    };

    expect(mergeChatMessages([optimistic], "session-1", [])).toEqual([optimistic]);
  });

  it("keeps correlated session and authored source identity visible on logs", () => {
    const entry: LiveLogEntry = {
      cursor: "9",
      fields: { coordinates: { revision: "rev-1", session: "session-1" } },
      level: "info",
      message: "hello",
      source: { column: 7, line: 12, path: "agent/tools/dynamic-echo.ts" },
      stream: "console",
      timestamp: "2026-06-20T10:00:00.000Z",
    };

    expect(projectLog(entry).coordinates).toEqual({
      action: undefined,
      revision: "rev-1",
      session: "session-1",
      step: undefined,
      turn: undefined,
    });
    expect(projectLog(entry).source).toEqual({
      column: 7,
      line: 12,
      path: "agent/tools/dynamic-echo.ts",
    });
  });

  it("keeps host and agent discovery diagnostics visible", () => {
    const scenario = createLiveScenario({
      agent: { diagnostics: { discoveryErrors: 1, discoveryWarnings: 2 } },
      debugger: { connected: false, controllerAttached: false },
      diagnostics: [{ message: "Showing the last valid agent snapshot." }],
      runs: [],
      runtime: { runtimeInstanceId: "runtime-1", status: "paused" },
      schemaVersion: 1,
    });

    expect(scenario.runtime.diagnostics).toEqual([
      "Showing the last valid agent snapshot.",
      "Agent discovery reported 1 error and 2 warnings.",
    ]);
  });

  it("keeps the real top frame while identifying the nearest authored frame", () => {
    const pause = projectPause(
      {
        callFrames: [
          {
            callFrameId: "generated",
            functionName: "execute",
            location: { lineNumber: 16 },
            url: "",
          },
          {
            callFrameId: "authored",
            functionName: "getWeather",
            location: { lineNumber: 4 },
            url: "file:///workspace/agent/tools/weather.ts",
          },
        ],
      },
      [],
      new Map([["authored", { line: 5, path: "agent/tools/weather.ts" }]]),
    );

    expect(pause.callStack[0]).toMatchObject({
      active: true,
      location: { path: "Generated source" },
      sourceKind: "generated",
    });
    expect(pause.authoredFrameId).toBe("authored");
    expect(pause.executionLine).toBe(5);
  });

  it("classifies non-authored debugger frames honestly", () => {
    expect(classifyFrameSource("node:internal/process/task_queues")).toBe("internal");
    expect(classifyFrameSource("file:///workspace/node_modules/eve/dist/runtime.js")).toBe(
      "framework",
    );
    expect(classifyFrameSource("file:///workspace/node_modules/zod/index.js")).toBe("dependency");
    expect(classifyFrameSource("")).toBe("generated");
  });
});

function runEvent(
  cursor: string,
  type: string,
  data: Readonly<Record<string, unknown>>,
): LiveRunEvent {
  return { cursor, event: { data, type }, sessionId: "session-1" };
}
