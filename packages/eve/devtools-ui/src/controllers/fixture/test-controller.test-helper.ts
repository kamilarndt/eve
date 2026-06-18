import type { DevToolsController } from "@ui/controllers/devtools-controller";
import { projectFixtureChatMessages } from "@ui/controllers/fixture/chat-messages";
import { createPrototypeScenario } from "@ui/controllers/fixture/scenarios";

export function createTestController(
  overrides: Partial<DevToolsController> = {},
): DevToolsController {
  const scenario = overrides.scenario ?? createPrototypeScenario("empty");
  return {
    chatMessages: projectFixtureChatMessages(scenario.events),
    clearToast() {},
    connectionStatus: "connected",
    consoleOpen: false,
    debuggerCommand() {},
    draft: "",
    evaluateExpression() {},
    events: scenario.events,
    isFixture: true,
    isSendingMessage: false,
    panel: "runs",
    scenario,
    selectAgent() {},
    selectEvent() {},
    selectPanel() {},
    selectRun() {},
    selectSource() {},
    sendMessage() {},
    setDraft() {},
    setScenario() {},
    setTheme() {},
    startSession() {},
    theme: "light",
    toggleBreakpoint() {},
    toggleConsole() {},
    ...overrides,
  };
}
