import { createRoot } from "react-dom/client";
import { DemoAppView } from "./demo-app-view.tsx";
import { CSS } from "./styles.ts";
import { ThemeProvider } from "./store.tsx";

const name = new URLSearchParams(window.location.search).get("name") ?? "";
const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <style>{CSS}</style>
    <DemoAppView name={name} />
  </ThemeProvider>,
);
