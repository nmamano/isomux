import { useAppState } from "../store.tsx";

// Brief grace window — covers reconnect blips so the banner doesn't flash on
// every transient cycle. Implemented as a CSS animation-delay (with fill-mode
// backwards) so the banner mounts immediately when disconnected but stays
// visually hidden for SHOW_DELAY_MS; if connection recovers within that window,
// the component unmounts before it ever appears. First-load hydration is
// handled separately via hasReceivedInitialState below (we don't show the
// banner at all until we've received the first full_state).
const SHOW_DELAY_MS = 600;

export function ConnectionBanner() {
  const { connected, hasReceivedInitialState } = useAppState();
  if (connected || !hasReceivedInitialState) return null;

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
        paddingTop: "calc(4px + env(safe-area-inset-top, 0px))",
        paddingBottom: 4,
        paddingLeft: 16,
        paddingRight: 16,
        background: "var(--red, #c0392b)",
        color: "white",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        animation: `isomuxBannerSlideIn 0.4s ${SHOW_DELAY_MS}ms ease backwards`,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "white",
          opacity: 0.9,
          animation: "isomuxBannerPulse 1.4s ease-in-out infinite",
        }}
      />
      <span>Reconnecting…</span>
      <style>{`
        @keyframes isomuxBannerSlideIn {
          from { opacity: 0; transform: translateY(-100%); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes isomuxBannerPulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
