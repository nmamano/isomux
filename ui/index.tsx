import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { PRODUCTION_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";
import { AppWidgetPage } from "./AppWidgetPage.tsx";
import type { AppWidgetBoot } from "./app-widget-state.ts";
import { LanguageProvider } from "./i18n.tsx";
import { captureInstallPrompt } from "./app-install.ts";
import { trackOfficePage } from "./home-screen-office.ts";
import { holdArrivingPanel } from "./elevator-panel-store.ts";

// First: a ride from another office's elevator left the panel in the address.
const ride = holdArrivingPanel();

const widgetMeta = document.querySelector<HTMLMetaElement>(
  'meta[name="isomux-app-widget"]',
);
const widgetBoot = widgetMeta
  ? (JSON.parse(widgetMeta.content) as AppWidgetBoot)
  : null;
// Both pages hold the install event: the short-link page installs its app,
// the office page installs the office.
captureInstallPrompt();
// The office page tells an app page in the same window where to go back to.
if (!widgetBoot) trackOfficePage(window);

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={PRODUCTION_FEATURES}>
      <StoreProvider ride={ride}>
        <LanguageProvider>
          {widgetBoot ? <AppWidgetPage boot={widgetBoot} /> : <App />}
        </LanguageProvider>
      </StoreProvider>
    </FeaturesProvider>
  </ThemeProvider>,
);

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
