import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { PRODUCTION_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";
import { WidgetOfficeBridge } from "./WidgetOfficeBridge.tsx";
import type { AppWidgetBoot } from "./app-widget-state.ts";
import { LanguageProvider } from "./i18n.tsx";

const widgetMeta = document.querySelector<HTMLMetaElement>(
  'meta[name="isomux-app-widget"]',
);
const widgetBoot = widgetMeta
  ? (JSON.parse(widgetMeta.content) as AppWidgetBoot)
  : null;

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={PRODUCTION_FEATURES}>
      <StoreProvider>
        <LanguageProvider>
          {widgetBoot ? <WidgetOfficeBridge boot={widgetBoot} /> : <App />}
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
