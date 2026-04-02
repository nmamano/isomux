import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { PRODUCTION_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={PRODUCTION_FEATURES}>
      <StoreProvider>
        <App />
      </StoreProvider>
    </FeaturesProvider>
  </ThemeProvider>
);
