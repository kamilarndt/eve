import type { ReactNode } from "react";

interface DebuggerSectionProps {
  readonly children: ReactNode;
  readonly title: string;
}

export function DebuggerSection({ children, title }: DebuggerSectionProps) {
  return (
    <section className="debugger-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
