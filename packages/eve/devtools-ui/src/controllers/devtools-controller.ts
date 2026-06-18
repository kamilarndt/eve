import type {
  AgentDefinition,
  ChatMessage,
  ConnectionStatus,
  PanelId,
  PrototypeScenario,
  ScenarioId,
  SourceFile,
  Theme,
  TimelineEvent,
} from "@ui/model/devtools-model";

export interface DevToolsController {
  readonly chatMessages: readonly ChatMessage[];
  readonly connectionStatus: ConnectionStatus;
  readonly consoleOpen: boolean;
  readonly draft: string;
  readonly events: readonly TimelineEvent[];
  readonly isFixture: boolean;
  readonly isSendingMessage: boolean;
  readonly panel: PanelId;
  readonly scenario: PrototypeScenario;
  readonly selectedAgent?: AgentDefinition;
  readonly selectedEvent?: TimelineEvent;
  readonly selectedRunId?: string;
  readonly selectedSource?: SourceFile;
  readonly theme: Theme;
  readonly toast?: string;
  clearToast(): void;
  debuggerCommand(command: "pause" | "resume" | "stepInto" | "stepOut" | "stepOver"): void;
  evaluateExpression(expression: string): void;
  selectAgent(id: string): void;
  selectEvent(id: string): void;
  selectPanel(panel: PanelId): void;
  selectRun(id: string): void;
  selectSource(id: string): void;
  sendMessage(): void;
  setDraft(value: string): void;
  setScenario(id: ScenarioId): void;
  setTheme(theme: Theme): void;
  startSession(): void;
  toggleBreakpoint(line: number): void;
  toggleConsole(): void;
}
