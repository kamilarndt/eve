import { formatAvailableSkillsSection } from "#execution/skills/instructions.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedInstructions,
  ResolvedSkillDefinition,
} from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import type { WorkspaceRuntimeSpec } from "#runtime/workspace/types.js";
import { formatConnectionsSection } from "#runtime/prompt/connections.js";

const PARALLEL_ACTION_PROMPT_VARIANT_ENV = "EVE_PARALLEL_ACTION_PROMPT_VARIANT";

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

export function resolveParallelActionInstruction(input: { readonly variant?: string }): string {
  return input.variant === "control"
    ? CONTROL_PARALLEL_ACTION_INSTRUCTION
    : TREATMENT_PARALLEL_ACTION_INSTRUCTION;
}

/**
 * Input for composing the base authored instructions prompt for one
 * resolved agent.
 */
interface ComposeRuntimeBasePromptInput {
  connections?: readonly ResolvedConnectionDefinition[];
  instructions?: ResolvedInstructions;
  skills?: readonly ResolvedSkillDefinition[];
  toolsAvailable?: boolean;
  workspaceSpec?: WorkspaceRuntimeSpec;
}

/**
 * Composes the authored base prompt from the resolved instructions source
 * without flattening skills into always-on instructions.
 */
export function composeRuntimeBasePrompt(input: ComposeRuntimeBasePromptInput): readonly string[] {
  return [
    ...createInstructionsPromptBlocks(input.instructions),
    ...createWorkspacePromptBlocks(input.workspaceSpec),
    ...(input.toolsAvailable
      ? [
          resolveParallelActionInstruction({
            variant: process.env[PARALLEL_ACTION_PROMPT_VARIANT_ENV],
          }),
        ]
      : []),
    ...createConnectionsPromptBlocks(input.connections),
    ...createSkillsPromptBlocks(input.skills),
  ];
}

function createInstructionsPromptBlocks(
  instructions: ResolvedInstructions | undefined,
): readonly string[] {
  if (instructions === undefined) {
    return [];
  }

  const markdown = instructions.markdown.trim();

  if (markdown.length === 0) {
    return [];
  }

  return [`Instructions (${instructions.name})\n${markdown}`];
}

function createWorkspacePromptBlocks(
  workspaceSpec: WorkspaceRuntimeSpec | undefined,
): readonly string[] {
  if (workspaceSpec === undefined) {
    return [];
  }

  const workspaceSection = createWorkspacePromptSection(workspaceSpec);
  return workspaceSection === undefined ? [] : [workspaceSection];
}

function createConnectionsPromptBlocks(
  connections: readonly ResolvedConnectionDefinition[] | undefined,
): readonly string[] {
  if (!connections || connections.length === 0) return [];
  return [formatConnectionsSection(connections)];
}

function createSkillsPromptBlocks(
  skills: readonly ResolvedSkillDefinition[] | undefined,
): readonly string[] {
  if (!skills || skills.length === 0) return [];
  const section = formatAvailableSkillsSection(skills);
  if (section === null) return [];
  return [section];
}
