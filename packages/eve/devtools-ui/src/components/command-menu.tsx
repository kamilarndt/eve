import {
  Activity,
  Bot,
  FileCode2,
  MessageSquarePlus,
  PanelBottom,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import type { PanelId } from "@ui/model/devtools-model";

interface CommandMenuProps {
  readonly onClose: () => void;
}

const panelCommands: readonly {
  readonly icon: typeof Activity;
  readonly label: string;
  readonly panel: PanelId;
}[] = [
  { icon: Activity, label: "Open Runs", panel: "runs" },
  { icon: Bot, label: "Open Agent", panel: "agent" },
  { icon: FileCode2, label: "Open Sources", panel: "sources" },
  { icon: TerminalSquare, label: "Open Console", panel: "console" },
];

export function CommandMenu({ onClose }: CommandMenuProps) {
  const controller = useDevToolsController();
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const buttons = [
      ...(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = buttons.findIndex((button) => button === document.activeElement);
      const next = nextCommandIndex(current, buttons.length, event.key);
      buttons[next]?.focus();
      return;
    }
    if (event.key !== "Tab") return;
    const first = buttons[0];
    const last = buttons.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="command-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Command Menu"
        aria-modal="true"
        className="command-menu"
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialog}
        role="dialog"
      >
        <header>Command Menu</header>
        <div>
          <button
            autoFocus
            onClick={() => {
              controller.startSession();
              controller.selectPanel("runs");
              onClose();
            }}
            type="button"
          >
            <MessageSquarePlus aria-hidden="true" size={14} />
            New Session
          </button>
          <button
            onClick={() => {
              controller.toggleConsole();
              onClose();
            }}
            type="button"
          >
            <PanelBottom aria-hidden="true" size={14} />
            Toggle Console Drawer
          </button>
          {panelCommands.map(({ icon: Icon, label, panel }) => (
            <button
              key={panel}
              onClick={() => {
                controller.selectPanel(panel);
                onClose();
              }}
              type="button"
            >
              <Icon aria-hidden="true" size={14} />
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function nextCommandIndex(
  current: number,
  count: number,
  key: "ArrowDown" | "ArrowUp",
): number {
  if (count === 0) return -1;
  const direction = key === "ArrowDown" ? 1 : -1;
  return (current + direction + count) % count;
}
