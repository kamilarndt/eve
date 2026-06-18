import { describe, expect, it } from "vitest";

import { createPrototypeScenario, scenarioOptions } from "@ui/controllers/fixture/scenarios";

describe("DevTools prototype scenarios", () => {
  it("keeps every scenario internally navigable", () => {
    for (const option of scenarioOptions) {
      const scenario = createPrototypeScenario(option.id);

      expect(scenario.agent.length).toBeGreaterThan(0);
      expect(scenario.sources.length).toBeGreaterThan(0);
      expect(scenario.selectedAgentId).toSatisfy(
        (id: string | undefined) =>
          id === undefined || scenario.agent.some((definition) => definition.id === id),
      );
      expect(scenario.selectedRunId).toSatisfy(
        (id: string | undefined) => id === undefined || scenario.runs.some((run) => run.id === id),
      );
      expect(scenario.selectedEventId).toSatisfy(
        (id: string | undefined) =>
          id === undefined || scenario.events.some((event) => event.id === id),
      );
      expect(scenario.selectedSourceId).toSatisfy(
        (id: string | undefined) =>
          id === undefined || scenario.sources.some((source) => source.id === id),
      );
    }
  });

  it("models the decisive paused, crashed, and dense states", () => {
    const paused = createPrototypeScenario("paused");
    const crashed = createPrototypeScenario("crashed");
    const stress = createPrototypeScenario("stress");

    expect(paused.runtime.status).toBe("paused");
    expect(paused.debugger.callStack.length).toBeGreaterThan(0);
    expect(paused.debugger.executionLine).toBeDefined();
    expect(crashed.runtime.status).toBe("crashed");
    expect(crashed.logs.some((record) => record.level === "error")).toBe(true);
    expect(stress.events).toHaveLength(80);
    expect(stress.runs.length).toBeGreaterThan(20);
  });

  it("groups authored and framework primitives under provenance folders", () => {
    const scenario = createPrototypeScenario("running");

    expect(scenario.agent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "instructions-active",
          parentId: "instructions",
        }),
        expect.objectContaining({ id: "tools-authored", label: "Authored", parentId: "tools" }),
        expect.objectContaining({
          id: "tools-framework",
          label: "Framework",
          parentId: "tools",
        }),
        expect.objectContaining({
          id: "channels-framework",
          label: "Framework",
          parentId: "channels",
        }),
        expect.objectContaining({ id: "subagent-research", parentId: "subagents" }),
        expect.objectContaining({ id: "tool-weather", parentId: "tools-authored" }),
        expect.objectContaining({ id: "tool-question", parentId: "tools-framework" }),
        expect.objectContaining({ id: "channel-eve", parentId: "channels-framework" }),
      ]),
    );
  });
});
