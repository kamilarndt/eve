/**
 * Typing-indicator labels for requested actions. The Slack indicator is
 * plain text (`assistant.threads.setStatus` renders no markdown), so the
 * label is the capitalized action name plus a framework-selected argument,
 * for example `Grep useEve` or `Read file agent/agent.ts`.
 */
import {
  truncateTypingStatus,
  truncateTypingStatusWithSuffix,
} from "#public/channels/slack/limits.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

interface ActionLabel {
  readonly groupKey: string;
  readonly text: string;
}

interface ActionGroup {
  readonly count: number;
  readonly label: ActionLabel;
}

function humanizeActionName(name: string): string {
  const words = name.replace(/[_-]+/gu, " ").trim();
  const first = words[0];
  return first === undefined ? words : `${first.toUpperCase()}${words.slice(1)}`;
}

function formatActionLabel(name: string, argument?: string): string {
  const label = humanizeActionName(name);
  return argument === undefined ? label : `${label} ${argument}`;
}

function actionLabel(action: RuntimeActionRequest): ActionLabel {
  switch (action.kind) {
    case "load-skill": {
      const skill = typeof action.input.skill === "string" ? action.input.skill : undefined;
      return { groupKey: "load-skill", text: formatActionLabel("load_skill", skill) };
    }
    case "remote-agent-call":
      return {
        groupKey: `remote-agent:${action.remoteAgentName}`,
        text: formatActionLabel(action.remoteAgentName),
      };
    case "subagent-call":
      return {
        groupKey: `subagent:${action.subagentName}`,
        text: formatActionLabel(action.subagentName),
      };
    case "tool-call":
      return {
        groupKey: `tool:${action.toolName}`,
        text: formatActionLabel(action.toolName, action.displayArgument),
      };
  }
}

/**
 * One action's typing-indicator label: `Grep useEveAgent` for tool calls,
 * the capitalized subagent or remote-agent name for dispatched calls, and
 * `Load skill <name>` for skill loads.
 */
export function describeActionRequest(action: RuntimeActionRequest): string {
  return truncateTypingStatus(actionLabel(action).text);
}

/**
 * Typing-indicator text for one requested batch. The most frequent action
 * name is counted and shown with its first argument; other actions become a
 * `+N more` suffix that is preserved within Slack's status limit.
 */
export function describeActionRequests(actions: readonly RuntimeActionRequest[]): string {
  const [first] = actions;
  if (first === undefined) return "Working...";

  const groups = new Map<string, ActionGroup>();
  for (const action of actions) {
    const label = actionLabel(action);
    const existing = groups.get(label.groupKey);
    groups.set(label.groupKey, {
      count: (existing?.count ?? 0) + 1,
      label: existing?.label ?? label,
    });
  }

  let primary: ActionGroup = { count: 0, label: actionLabel(first) };
  for (const group of groups.values()) {
    if (group.count > primary.count) primary = group;
  }

  const status =
    primary.count === 1 ? primary.label.text : `${primary.count} ${primary.label.text}`;
  const remaining = actions.length - primary.count;
  return remaining === 0
    ? truncateTypingStatus(status)
    : truncateTypingStatusWithSuffix({ status, suffix: `+${remaining} more` });
}
