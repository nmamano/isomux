import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { PRODUCTION_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";
import { initFocusDebug } from "./focus-debug.ts";

// Diagnostic tracer for the editor input-capture bug - inert unless the
// localStorage flag is set (see focus-debug.ts).
initFocusDebug();

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={PRODUCTION_FEATURES}>
      <StoreProvider>
        <App />
      </StoreProvider>
    </FeaturesProvider>
  </ThemeProvider>,
);

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
