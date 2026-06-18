import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import { usePaneNavigation } from "@ui/components/three-pane-layout";
import { buildSourceTree, type SourceTreeNode } from "@ui/panels/sources/source-tree";

export function SourceNavigator() {
  const controller = useDevToolsController();
  const paneNavigation = usePaneNavigation();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.toLocaleLowerCase().trim();
  const sourceTree = useMemo(
    () =>
      buildSourceTree(
        controller.scenario.sources.filter(
          (source) =>
            normalizedQuery.length === 0 ||
            source.path.toLocaleLowerCase().includes(normalizedQuery),
        ),
      ),
    [controller.scenario.sources, normalizedQuery],
  );
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return (
    <div className="navigator-content">
      <div className="pane-heading">
        <div>
          <h2>Sources</h2>
          <span>{controller.scenario.sources.length}</span>
        </div>
      </div>
      <label className="search-field">
        <Search aria-hidden="true" size={14} />
        <span className="sr-only">Open source file</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Open file..."
          type="search"
          value={query}
        />
      </label>
      <div className="source-tree" role="tree">
        <div className="source-group">
          <div className="source-group-label">
            <ChevronDown aria-hidden="true" size={12} />
            <span>Authored</span>
          </div>
          <SourceTree
            collapsedFolders={collapsedFolders}
            filtering={normalizedQuery.length > 0}
            nodes={sourceTree}
            onSelectSource={(id) => {
              controller.selectSource(id);
              paneNavigation.showPrimary();
            }}
            onToggleFolder={toggleFolder}
            selectedSourceId={controller.selectedSource?.id}
          />
        </div>
      </div>
    </div>
  );
}

interface SourceTreeProps {
  readonly collapsedFolders: ReadonlySet<string>;
  readonly depth?: number;
  readonly filtering: boolean;
  readonly nodes: readonly SourceTreeNode[];
  readonly onSelectSource: (id: string) => void;
  readonly onToggleFolder: (path: string) => void;
  readonly selectedSourceId?: string;
}

function SourceTree({
  collapsedFolders,
  depth = 0,
  filtering,
  nodes,
  onSelectSource,
  onToggleFolder,
  selectedSourceId,
}: SourceTreeProps) {
  return nodes.map((node) => {
    const paddingLeft = 24 + depth * 16;
    if (node.kind === "folder") {
      const expanded = filtering || !collapsedFolders.has(node.path);
      const FolderIcon = expanded ? FolderOpen : Folder;
      return (
        <div className="source-folder" key={node.path}>
          <button
            aria-expanded={expanded}
            className="source-folder-row"
            onClick={() => onToggleFolder(node.path)}
            role="treeitem"
            style={{ paddingLeft }}
            title={node.path}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" size={12} />
            ) : (
              <ChevronRight aria-hidden="true" size={12} />
            )}
            <FolderIcon aria-hidden="true" size={14} />
            <span>{node.name}</span>
          </button>
          {expanded && (
            <div role="group">
              <SourceTree
                collapsedFolders={collapsedFolders}
                depth={depth + 1}
                filtering={filtering}
                nodes={node.children}
                onSelectSource={onSelectSource}
                onToggleFolder={onToggleFolder}
                selectedSourceId={selectedSourceId}
              />
            </div>
          )}
        </div>
      );
    }

    const selected = node.source.id === selectedSourceId;
    return (
      <button
        aria-selected={selected}
        className="source-row"
        data-selected={selected || undefined}
        key={node.source.id}
        onClick={() => onSelectSource(node.source.id)}
        role="treeitem"
        style={{ paddingLeft }}
        title={node.source.path}
        type="button"
      >
        <span className="tree-spacer" />
        <FileCode2 aria-hidden="true" size={14} />
        <span>{node.name}</span>
        {node.source.loaded && <span aria-label="Loaded" className="loaded-dot" />}
      </button>
    );
  });
}
