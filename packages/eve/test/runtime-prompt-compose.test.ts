import { describe, expect, it } from "vitest";
import {
  composeRuntimeBasePrompt,
  resolveParallelActionInstruction,
} from "../src/runtime/prompt/compose.js";

const CONTROL_PARALLEL_ACTION_INSTRUCTION =
  "Tool execution\nA single tool or subagent call runs as one serial action. If you call multiple independent tools or subagents in one response, eve treats that batch as parallel work. Only batch work that is independent and does not rely on another call in the same response.";

const TREATMENT_PARALLEL_ACTION_INSTRUCTION = [
  "Tool execution",
  "- Before the first tool or subagent call, silently decompose the request into concrete work items and identify which items can run in parallel.",
  "- A work item is parallelizable when its input is already known, it does not need another pending result, and it does not conflict with another call over the same external state.",
  "- Emit every parallelizable tool or subagent call in the same assistant response so eve can execute them concurrently.",
  "- If a request asks for a list, table, audit, comparison, migration, search, or per-item analysis, first fan out the independent reads, lookups, inspections, or checks for each item.",
  "- If you are about to call one tool for one item while other independent items are still unrequested, include those other calls in the same response instead.",
  "- Sequence calls only when a later call needs an earlier result or when calls would conflict over shared state. Synthesize answers and perform dependent writes after the independent results return.",
].join("\n");

describe("composeRuntimeBasePrompt", () => {
  it("composes the authored instructions prompt into one runtime instruction block", () => {
    expect(
      composeRuntimeBasePrompt({
        instructions: {
          name: "instructions",
          logicalPath: "instructions.md",
          markdown: "You are a weather assistant.\n",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      }),
    ).toEqual(["Instructions (instructions)\nYou are a weather assistant."]);
  });

  it("adds a parallel tool execution instruction when tools are available", () => {
    expect(
      composeRuntimeBasePrompt({
        toolsAvailable: true,
      }),
    ).toEqual([TREATMENT_PARALLEL_ACTION_INSTRUCTION]);
  });

  it("resolves the benchmark control prompt variant", () => {
    expect(resolveParallelActionInstruction({ variant: "control" })).toBe(
      CONTROL_PARALLEL_ACTION_INSTRUCTION,
    );
  });

  it("defaults unknown benchmark prompt variants to treatment", () => {
    expect(resolveParallelActionInstruction({ variant: undefined })).toBe(
      TREATMENT_PARALLEL_ACTION_INSTRUCTION,
    );
    expect(resolveParallelActionInstruction({ variant: "treatment" })).toBe(
      TREATMENT_PARALLEL_ACTION_INSTRUCTION,
    );
  });

  it("drops the instructions block when the authored markdown normalizes to empty", () => {
    expect(
      composeRuntimeBasePrompt({
        instructions: {
          name: "instructions",
          logicalPath: "instructions.md",
          markdown: "   \n",
          sourceId: "instructions.md",
          sourceKind: "markdown",
        },
      }),
    ).toEqual([]);
  });

  it("adds a shallow workspace awareness section when authored project files are mounted", () => {
    expect(
      composeRuntimeBasePrompt({
        workspaceSpec: { rootEntries: ["skills/"] },
      }),
    ).toEqual([
      [
        "Workspace",
        "- You have access to authored files mounted at the workspace root for this run.",
        "- The live workspace root visible to `bash` in this run is `/workspace`.",
        "- Root entries under /workspace/:",
        "  - skills/",
        "- Treat `/workspace` as the workspace root for this run unless a `bash` call shows otherwise.",
        "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
        "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
        "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
        "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
      ].join("\n"),
    ]);
  });

  it("does not inject runtime-owned delivery or sandbox guidance", () => {
    expect(composeRuntimeBasePrompt({})).toEqual([]);
  });

  it("orders workspace and tool execution sections predictably", () => {
    expect(
      composeRuntimeBasePrompt({
        toolsAvailable: true,
        workspaceSpec: { rootEntries: ["skills/"] },
      }),
    ).toEqual([
      [
        "Workspace",
        "- You have access to authored files mounted at the workspace root for this run.",
        "- The live workspace root visible to `bash` in this run is `/workspace`.",
        "- Root entries under /workspace/:",
        "  - skills/",
        "- Treat `/workspace` as the workspace root for this run unless a `bash` call shows otherwise.",
        "- For questions about workspace paths or file availability, verify with `bash` first using commands like `pwd`, `ls`, and `find`.",
        "- If the required `bash` verification fails, report that failure directly instead of answering from this overview.",
        "- Use the `bash` tool with `ls`, `find`, and `rg` to inspect deeper contents when needed.",
        "- Do not claim these files are unavailable unless a workspace or tool call actually fails.",
      ].join("\n"),
      TREATMENT_PARALLEL_ACTION_INSTRUCTION,
    ]);
  });
});
