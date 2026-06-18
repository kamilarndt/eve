import { ArrowUp, CirclePause, LoaderCircle, LockKeyhole } from "lucide-react";
import type { Ref } from "react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";

export function RunComposer({ inputRef }: { readonly inputRef?: Ref<HTMLTextAreaElement> }) {
  const controller = useDevToolsController();
  const selectedRun = controller.scenario.runs.find((run) => run.id === controller.selectedRunId);
  const disabled =
    controller.isSendingMessage ||
    controller.scenario.runtime.status !== "ready" ||
    (selectedRun !== undefined && selectedRun.status !== "waiting");
  const isNewSession = controller.selectedRunId === undefined;
  const isPaused = controller.scenario.runtime.status === "paused";
  const isRunBusy = selectedRun?.status === "running";
  const isBusy = !isPaused && (controller.isSendingMessage || isRunBusy);

  return (
    <form
      className="run-composer"
      data-disabled={disabled || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        controller.sendMessage();
      }}
    >
      {isBusy && (
        <LoaderCircle
          aria-hidden="true"
          className="composer-loading-icon"
          size={14}
          strokeWidth={1.9}
        />
      )}
      {isPaused && <CirclePause aria-hidden="true" className="composer-paused-icon" size={14} />}
      {disabled && !isBusy && !isPaused && <LockKeyhole aria-hidden="true" size={14} />}
      <textarea
        aria-label={isNewSession ? "Message your agent" : "Message this session"}
        disabled={disabled}
        onChange={(event) => controller.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            shouldSubmitMessage({
              isComposing: event.nativeEvent.isComposing,
              key: event.key,
              shiftKey: event.shiftKey,
            })
          ) {
            event.preventDefault();
            controller.sendMessage();
          }
        }}
        placeholder={
          controller.scenario.runtime.status === "paused"
            ? "Paused — resume to send a message."
            : controller.scenario.runtime.status !== "ready"
              ? "Runtime unavailable"
              : controller.isSendingMessage
                ? "Sending message..."
                : isRunBusy
                  ? "Agent is running. Waiting for the next input boundary..."
                  : selectedRun !== undefined && selectedRun.status !== "waiting"
                    ? "This session cannot receive another message"
                    : isNewSession
                      ? "Message your agent..."
                      : "Message this session..."
        }
        ref={inputRef}
        rows={1}
        value={controller.draft}
      />
      <span className="composer-shortcut" role={isBusy ? "status" : undefined}>
        {isPaused ? "Paused" : isBusy ? "Running…" : "Enter"}
      </span>
      <button
        aria-label="Send Message"
        className="composer-send"
        disabled={disabled || controller.draft.trim().length === 0}
        title="Send Message (Enter)"
        type="submit"
      >
        <ArrowUp aria-hidden="true" size={15} strokeWidth={2} />
      </button>
    </form>
  );
}

export function shouldSubmitMessage(input: {
  readonly isComposing: boolean;
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}
