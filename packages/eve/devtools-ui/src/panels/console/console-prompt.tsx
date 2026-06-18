import { useState, type FormEvent } from "react";

import type { RuntimeStatus } from "@ui/model/devtools-model";

interface ConsolePromptProps {
  readonly onEvaluate: (expression: string) => void;
  readonly runtimeStatus: RuntimeStatus;
}

export function ConsolePrompt({ onEvaluate, runtimeStatus }: ConsolePromptProps) {
  const [expression, setExpression] = useState("");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextExpression = expression.trim();
    if (nextExpression.length === 0) return;
    onEvaluate(nextExpression);
    setExpression("");
  }

  return (
    <form className="console-prompt" onSubmit={submit}>
      <span title="Expressions execute arbitrary code in the trusted local agent runtime.">
        {runtimeStatus === "paused" ? "paused frame · local code" : "runtime · local code"}
      </span>
      <span aria-hidden="true">›</span>
      <input
        aria-label="Evaluate expression"
        onChange={(event) => setExpression(event.target.value)}
        placeholder="Evaluate in local runtime..."
        value={expression}
      />
    </form>
  );
}
