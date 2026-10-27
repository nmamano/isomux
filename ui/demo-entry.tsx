import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, ThemeProvider, FeaturesProvider } from "./store.tsx";
import { LanguageProvider, useI18n } from "./i18n.tsx";
import { DEMO_FEATURES } from "../shared/features.ts";
import { App } from "./App.tsx";
import { setShim } from "./ws.ts";
import { setApiShim } from "./api.ts";
import {
  demoApi,
  handleCommand,
  sendInitialState,
  setEmbedMode,
} from "./demo-server.ts";

const isEmbed = new URLSearchParams(window.location.search).has("embed");

// In embed mode, strip Angela (room 1) so only room 0 is seeded
if (isEmbed) setEmbedMode();

// Wire the shims before anything connects: the WS shim handles commands still
// on the bus; the API shim handles commands already migrated to apiFetch.
setShim(handleCommand, sendInitialState);
setApiShim(demoApi);

// Hardcode username so the modal is skipped.
// Safe: demo runs at isomux.com/demo, real app is self-hosted (different origin).
localStorage.setItem("isomux-username", "Ricky");

const isMobile =
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  window.innerWidth < 600;

// The banner wraps to two lines on a phone and in longer languages, so its
// height is measured, not assumed: the app sits below whatever it takes.
function DemoBanner({ onHeight }: { onHeight: (px: number) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeight]);
  return (
    <div
      ref={ref}
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
      <span>{isMobile ? t("demo.banner.short") : t("demo.banner.long")}</span>
      <a
        href="https://isomux.com"
        style={{
          color: "var(--green-text)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        isomux.com
      </a>
    </div>
  );
}

// The one-line height, used until the first measurement.
const DEMO_BANNER_HEIGHT = 33;

const features = isEmbed ? { ...DEMO_FEATURES, embed: true } : DEMO_FEATURES;

function DemoApp() {
  const [bannerHeight, setBannerHeight] = useState(DEMO_BANNER_HEIGHT);
  if (isEmbed) {
    return (
      <div style={{ position: "fixed", inset: 0, transform: "translateZ(0)" }}>
        <App routing={false} />
      </div>
    );
  }
  return (
    <>
      <style>{`:root { --banner-h: ${bannerHeight}px; }`}</style>
      <DemoBanner onHeight={setBannerHeight} />
      <div
        style={{
          position: "fixed",
          top: bannerHeight,
          left: 0,
          right: 0,
          bottom: 0,
          transform: "translateZ(0)",
        }}
      >
        <App routing={false} />
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ThemeProvider>
    <FeaturesProvider features={features}>
      <StoreProvider>
        <LanguageProvider>
          <DemoApp />
        </LanguageProvider>
      </StoreProvider>
    </FeaturesProvider>
  </ThemeProvider>,
);
