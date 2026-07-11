import {
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  runCodeMode,
  unwrapCodeModeResult,
} from "#compiled/experimental-ai-sdk-code-mode/index.js";
import { installWorkflowSandboxModule } from "#shared/workflow-sandbox.js";

installWorkflowSandboxModule({
  continueCodeModeInterrupt,
  createCodeModeTool,
  getCodeModeInterrupt,
  requestCodeModeInterrupt,
  runCodeMode,
  unwrapCodeModeResult,
});

export default function installWorkflowSandboxRuntimePlugin(): void {}
