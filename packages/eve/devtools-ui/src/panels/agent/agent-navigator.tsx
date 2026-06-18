import {
  Bot,
  Box,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  Globe2,
  Link2,
  Radio,
  Search,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { usePaneNavigation } from "@ui/components/three-pane-layout";
import type { AgentDefinition } from "@ui/model/devtools-model";

const icons: Readonly<Record<AgentDefinition["kind"], LucideIcon>> = {
  channel: Radio,
  connection: Link2,
  group: FolderTree,
  hook: GitBranch,
  instructions: FileText,
  model: Bot,
  sandbox: Box,
  schedule: Clock3,
  skill: Sparkles,
  subagent: GitBranch,
  tool: Wrench,
  workspace: Globe2,
};

export function AgentNavigator() {
  const controller = useDevToolsController();
  const paneNavigation = usePaneNavigation();
  const [query, setQuery] = useState("");
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<string>>(() => new Set());
  const normalizedQuery = query.toLocaleLowerCase().trim();
  const allDefinitions = controller.scenario.agent;
  const definitionsById = new Map(
    allDefinitions.map((definition) => [definition.id, definition] as const),
  );
  const definitionDepths = definitionDepthMap(allDefinitions);
  const isExpanded = (definition: AgentDefinition) => groupIsExpanded(definition, toggledGroups);
  const definitions = visibleDefinitions(
    allDefinitions,
    normalizedQuery,
    definitionsById,
    isExpanded,
  );
  return (
    <div className="navigator-content">
      <div className="pane-heading">
        <div>
          <h2>Resolved Agent</h2>
          <span>{allDefinitions.filter((definition) => definition.kind !== "group").length}</span>
        </div>
      </div>
      <label className="search-field">
        <Search aria-hidden="true" size={14} />
        <span className="sr-only">Search definitions</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search definitions..."
          type="search"
          value={query}
        />
      </label>
      <div className="definition-tree" role="tree">
        {definitions.map((definition) => {
          const Icon = icons[definition.kind];
          const group = definition.kind === "group";
          const expanded =
            group &&
            (isExpanded(definition) ||
              (normalizedQuery.length > 0 &&
                definitions.some((candidate) => candidate.parentId === definition.id)));
          const selected = !group && definition.id === controller.selectedAgent?.id;
          const parent =
            definition.parentId === undefined
              ? undefined
              : definitionsById.get(definition.parentId);
          const showProvenance = definition.provenance !== "runtime" && !isProvenanceFolder(parent);
          return (
            <button
              aria-expanded={group ? expanded : undefined}
              aria-level={(definitionDepths.get(definition.id) ?? 0) + 1}
              aria-selected={group ? undefined : selected}
              className="definition-row"
              data-child={definition.parentId !== undefined || undefined}
              data-depth={definitionDepths.get(definition.id) ?? 0}
              data-selected={selected || undefined}
              key={definition.id}
              onClick={() => {
                if (group) {
                  setToggledGroups((current) => toggleSetValue(current, definition.id));
                  return;
                }
                controller.selectAgent(definition.id);
                paneNavigation.showPrimary();
              }}
              role="treeitem"
              type="button"
            >
              {group && expanded && <ChevronDown aria-hidden="true" size={12} />}
              {group && !expanded && <ChevronRight aria-hidden="true" size={12} />}
              {!group && <span className="tree-spacer" />}
              <Icon aria-hidden="true" size={14} />
              <span>{definition.label}</span>
              {showProvenance && (
                <span className="definition-provenance">{definition.provenance}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function visibleDefinitions(
  definitions: readonly AgentDefinition[],
  query: string,
  definitionsById: ReadonlyMap<string, AgentDefinition>,
  isExpanded: (definition: AgentDefinition) => boolean,
): readonly AgentDefinition[] {
  if (query.length > 0) {
    const visibleIds = new Set<string>();
    for (const definition of definitions) {
      if (
        !definition.label.toLocaleLowerCase().includes(query) &&
        !definition.kind.toLocaleLowerCase().includes(query) &&
        !definition.provenance.toLocaleLowerCase().includes(query)
      ) {
        continue;
      }
      visibleIds.add(definition.id);
      let parentId = definition.parentId;
      while (parentId !== undefined) {
        visibleIds.add(parentId);
        parentId = definitionsById.get(parentId)?.parentId;
      }
    }
    return definitions.filter((definition) => visibleIds.has(definition.id));
  }

  return definitions.filter((definition) => {
    let parentId = definition.parentId;
    while (parentId !== undefined) {
      const parent = definitionsById.get(parentId);
      if (parent === undefined || !isExpanded(parent)) return false;
      parentId = parent.parentId;
    }
    return true;
  });
}

function groupIsExpanded(definition: AgentDefinition, toggledGroups: ReadonlySet<string>): boolean {
  const expandedByDefault = definition.label !== "Framework";
  return toggledGroups.has(definition.id) ? !expandedByDefault : expandedByDefault;
}

function toggleSetValue(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function isProvenanceFolder(definition: AgentDefinition | undefined): boolean {
  return (
    definition?.kind === "group" &&
    (definition.label === "Authored" || definition.label === "Framework")
  );
}

function definitionDepthMap(definitions: readonly AgentDefinition[]): ReadonlyMap<string, number> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition] as const));
  const depths = new Map<string, number>();

  function depthFor(definition: AgentDefinition): number {
    const cached = depths.get(definition.id);
    if (cached !== undefined) return cached;
    const parent = definition.parentId === undefined ? undefined : byId.get(definition.parentId);
    const depth = parent === undefined ? 0 : depthFor(parent) + 1;
    depths.set(definition.id, depth);
    return depth;
  }

  for (const definition of definitions) depthFor(definition);
  return depths;
}
