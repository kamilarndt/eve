import { createContext, useContext, type ReactNode } from "react";

import type { DevToolsController } from "@ui/controllers/devtools-controller";

const DevToolsControllerContext = createContext<DevToolsController | undefined>(undefined);

interface DevToolsControllerProviderProps {
  readonly children: ReactNode;
  readonly controller: DevToolsController;
}

export function DevToolsControllerProvider({
  children,
  controller,
}: DevToolsControllerProviderProps) {
  return (
    <DevToolsControllerContext.Provider value={controller}>
      {children}
    </DevToolsControllerContext.Provider>
  );
}

export function useDevToolsController(): DevToolsController {
  const controller = useContext(DevToolsControllerContext);
  if (controller === undefined) {
    throw new Error("useDevToolsController must be used inside DevToolsControllerProvider.");
  }
  return controller;
}
