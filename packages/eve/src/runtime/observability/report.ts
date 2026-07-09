import type { HandleMessageStreamEvent } from "#protocol/message.js";

let WARNED_ABOUT_REPORT_FAILURE = false;

function isIssueSourceEvent(event: HandleMessageStreamEvent): boolean {
  if (event.type === "action.result") {
    return event.data.status === "failed" || event.data.status === "rejected";
  }

  if (
    event.type === "step.failed" ||
    event.type === "turn.failed" ||
    event.type === "session.failed"
  ) {
    return true;
  }

  if (event.type === "subagent.event") {
    return isIssueSourceEvent(event.data.event);
  }

  return false;
}

export async function reportEveObservabilityEvent(event: HandleMessageStreamEvent): Promise<void> {
  if (!isIssueSourceEvent(event)) {
    return;
  }

  try {
    const workflowCore = await import("#compiled/@workflow/core/index.js");
    const report = (
      workflowCore as {
        experimental_reportObservabilityEvent?: (event: HandleMessageStreamEvent) => Promise<void>;
      }
    ).experimental_reportObservabilityEvent;
    await report?.(event);
  } catch (error) {
    if (!WARNED_ABOUT_REPORT_FAILURE) {
      WARNED_ABOUT_REPORT_FAILURE = true;
      console.warn(
        "[eve] reportEveObservabilityEvent failed; suppressing further warnings this process.",
        {
          type: event.type,
          error: (error as Error).message,
        },
      );
    }
  }
}
