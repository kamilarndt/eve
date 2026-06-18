const snapshotSegmentPattern = /(?:^|\/)snapshots\/([^/]+)/u;

export function formatRevision(revision: string): string {
  if (revision === "unknown") return revision;
  const normalized = revision.replaceAll("\\", "/");
  const snapshotSegment = snapshotSegmentPattern.exec(normalized)?.[1];
  if (snapshotSegment !== undefined) {
    return (snapshotSegment.split("-")[0] ?? snapshotSegment).slice(0, 8);
  }
  if (!normalized.includes("/")) {
    return normalized.length > 12 ? normalized.slice(0, 8) : normalized;
  }
  return stablePathToken(normalized);
}

function stablePathToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}
