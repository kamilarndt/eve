import type { ReactNode } from "react";

interface EmptyStateProps {
  readonly action?: ReactNode;
  readonly description: string;
  readonly title: string;
}

export function EmptyState({ action, description, title }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
