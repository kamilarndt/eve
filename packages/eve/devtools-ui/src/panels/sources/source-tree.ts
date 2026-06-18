import type { SourceFile } from "@ui/model/devtools-model";

export interface SourceFolderNode {
  readonly children: readonly SourceTreeNode[];
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
}

export interface SourceFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly source: SourceFile;
}

export type SourceTreeNode = SourceFileNode | SourceFolderNode;

interface MutableSourceFolder {
  readonly files: SourceFile[];
  readonly folders: Map<string, MutableSourceFolder>;
}

/** Builds a folder-first tree from source paths. */
export function buildSourceTree(sources: readonly SourceFile[]): readonly SourceTreeNode[] {
  const root = createFolder();

  for (const source of sources) {
    const segments = source.path.split("/").filter(Boolean);
    segments.pop();
    let folder = root;

    for (const segment of segments) {
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = createFolder();
        folder.folders.set(segment, child);
      }
      folder = child;
    }

    folder.files.push(source);
  }

  return toSourceTreeNodes(root);
}

function createFolder(): MutableSourceFolder {
  return { files: [], folders: new Map() };
}

function toSourceTreeNodes(folder: MutableSourceFolder, parentPath = ""): SourceTreeNode[] {
  const folders: SourceFolderNode[] = [...folder.folders.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => {
      const path = parentPath.length === 0 ? name : `${parentPath}/${name}`;
      return {
        children: toSourceTreeNodes(child, path),
        kind: "folder",
        name,
        path,
      };
    });
  const files: SourceFileNode[] = folder.files
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({
      kind: "file",
      name: source.path.split("/").at(-1) ?? source.path,
      source,
    }));

  return [...folders, ...files];
}
