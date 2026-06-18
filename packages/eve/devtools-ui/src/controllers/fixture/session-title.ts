const maxSessionTitleLength = 48;

export function deriveSessionTitle(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxSessionTitleLength) return normalized;
  return `${normalized.slice(0, maxSessionTitleLength - 1).trimEnd()}…`;
}
