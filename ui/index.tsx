import { createRoot } from "react-dom/client";
import { StoreProvider } from "./store.tsx";
import { App } from "./App.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(
  <StoreProvider>
    <App />
  </StoreProvider>
);
