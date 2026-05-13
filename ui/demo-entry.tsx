import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { DEMO_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";
import { setShim } from "./ws.ts";
import {
  handleCommand,
  sendInitialState,
  setEmbedMode,
} from "./demo-server.ts";

const isEmbed = new URLSearchParams(window.location.search).has("embed");

// In embed mode, strip Angela (room 1) so only room 0 is seeded
if (isEmbed) setEmbedMode();

// Wire the shim before anything connects
setShim(handleCommand, sendInitialState);

// Hardcode username so the modal is skipped.
// Safe: demo runs at isomux.com/demo, real app is self-hosted (different origin).
localStorage.setItem("isomux-username", "demo-boss");

const isMobile =
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  window.innerWidth < 600;

function DemoBanner() {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "6px 16px",
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border-light)",
        fontSize: 13,
        color: "var(--text-dim)",
      }}
    >
      <span>
        {isMobile
          ? "This is a demo. To connect real agents:"
          : "This is a demo office. To connect real Claude agents:"}
      </span>
      <a
        href="https://isomux.com"
        style={{
          color: "var(--green)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        isomux.com
      </a>
    </div>
  );
}

const DEMO_BANNER_HEIGHT = 33;

const features = isEmbed ? { ...DEMO_FEATURES, embed: true } : DEMO_FEATURES;

function DemoApp() {
  if (isEmbed) {
    return (
      <div style={{ position: "fixed", inset: 0, transform: "translateZ(0)" }}>
        <App />
      </div>
    );
  }
  return (
    <>
      <style>{`:root { --banner-h: ${DEMO_BANNER_HEIGHT}px; }`}</style>
      <DemoBanner />
      <div
        style={{
          position: "fixed",
          top: DEMO_BANNER_HEIGHT,
          left: 0,
          right: 0,
          bottom: 0,
          transform: "translateZ(0)",
        }}
      >
        <App />
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={features}>
      <StoreProvider>
        <DemoApp />
      </StoreProvider>
    </FeaturesProvider>
  </ThemeProvider>,
);
