import { rmSync } from "node:fs";

export interface DevToolsProcessCleanupHandle {
  close(): void;
}

export function registerDevToolsDiscoveryCleanup(
  discoveryPath: string,
): DevToolsProcessCleanupHandle {
  const removeDiscovery = () => {
    rmSync(discoveryPath, { force: true });
  };

  process.once("exit", removeDiscovery);

  return {
    close() {
      process.off("exit", removeDiscovery);
    },
  };
}
