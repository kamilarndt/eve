import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DevToolsApp } from "@ui/app/devtools-app";
import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { useFixtureController } from "@ui/controllers/fixture/use-fixture-controller";
import { useLiveController } from "@ui/controllers/live/use-live-controller";
import "@ui/styles/tokens.css";
import "@ui/styles/app.css";

function PrototypeRoot() {
  const controller = useFixtureController();
  return (
    <DevToolsControllerProvider controller={controller}>
      <DevToolsApp />
    </DevToolsControllerProvider>
  );
}

function LiveRoot({ capability }: { readonly capability: string }) {
  const controller = useLiveController(capability);
  return (
    <DevToolsControllerProvider controller={controller}>
      <DevToolsApp />
    </DevToolsControllerProvider>
  );
}

function Root() {
  const capability = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (capability !== null && /^[a-f\d]{64}$/u.test(capability)) {
    return <LiveRoot capability={capability} />;
  }
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).has("prototype")) {
    return <PrototypeRoot />;
  }
  return (
    <main className="capability-error">
      <div>
        <strong>DevTools capability missing</strong>
        <p>Open the complete local DevTools URL printed by Eve.</p>
      </div>
    </main>
  );
}

const rootElement = document.querySelector("#root");
if (rootElement === null) {
  throw new Error("DevTools root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
