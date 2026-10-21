// A small notice when the server serves a newer UI build than this tab runs
// (ui/ui-build.ts). It never reloads by itself: the member may be typing.
// It sits under the update overlay (zIndex 9000), and under the reconnecting
// banner when both show.

import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { reloadBrowser } from "../reload-browser.ts";
import { ownUiBuild, showUiBuildNotice } from "../ui-build.ts";

export function UiBuildNotice(): React.ReactElement | null {
  const { serverUiBuild, uiBuildDismissed, connected } = useAppState();
  const dispatch = useDispatch();
  const { t } = useI18n();
  if (!showUiBuildNotice(ownUiBuild(), serverUiBuild, uiBuildDismissed))
    return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        // Below the reconnecting banner (ConnectionBanner) while it shows.
        top: `calc(${connected ? 8 : 34}px + env(safe-area-inset-top, 0px))`,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 8900,
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: "calc(100vw - 24px)",
        boxSizing: "border-box",
        padding: "6px 6px 6px 14px",
        borderRadius: 999,
        background: "var(--bg-surface-solid)",
        border: "1px solid var(--border-medium)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        color: "var(--text-primary)",
        fontSize: 12,
        animation: "fadeIn 0.2s ease",
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>{t("app.uiBuild.outOfDate")}</span>
      <button
        onClick={() => reloadBrowser()}
        style={{
          padding: "4px 12px",
          borderRadius: 999,
          border: "none",
          background: "var(--accent-text)",
          color: "var(--bg-base)",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {t("update.screen.reload")}
      </button>
      <button
        onClick={() => dispatch({ type: "ui_build_dismiss" })}
        aria-label={t("common.dismiss")}
        title={t("common.dismiss")}
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M1 1l8 8M9 1l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
