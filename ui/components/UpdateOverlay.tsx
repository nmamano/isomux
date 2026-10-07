// The full-screen update screen. Every tab of every member shows it while an
// update runs, from the updater's own progress events (ui/update-watch.ts
// holds the rules). Hide always closes it. The tab that launched the update
// reloads itself when the office is back on the new version, unless the
// installer left notes to read (UpdateStatusWire.outcome); other tabs get a
// Reload button.

import { useEffect } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { reloadBrowser } from "../reload-browser.ts";
import {
  updateScreen,
  visibleScreen,
  type UpdateStep,
} from "../update-watch.ts";

const STEP_KEYS = {
  prepare: "update.screen.prepare",
  install: "update.screen.install",
  restart: "update.screen.restart",
} as const satisfies Record<UpdateStep, string>;

const buttonStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent-text)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const quietButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--bg-code)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-light)",
};

function Dots() {
  return (
    <div aria-hidden style={{ display: "flex", gap: 6, marginBottom: 16 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--accent-text)",
            animation: `dotBounce 1.4s ${i * 0.16}s infinite ease-in-out both`,
          }}
        />
      ))}
    </div>
  );
}

// The installer's messages, as written (they come from the box in English).
export function UpdateOutcomeNotes({
  title,
  messages,
}: {
  title: string;
  messages: string[];
}) {
  return (
    <div style={{ marginTop: 16, textAlign: "left", width: "100%" }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{title}</h3>
      <ul
        style={{
          margin: "6px 0 0",
          paddingLeft: 18,
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--text-dim)",
        }}
      >
        {messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

export function UpdateOverlay() {
  const { updateWatch, updateInfo, connected, sessionContext } =
    useAppState();
  const dispatch = useDispatch();
  const { t } = useI18n();
  const screen = updateScreen(updateWatch, updateInfo, connected);
  // The installer's notes are for owners, like the Update pane. With notes to
  // read, the launching tab (always an owner's) waits for Reload too.
  const notes =
    screen.kind === "done" && sessionContext?.role === "owner"
      ? screen.outcome
      : null;
  const reloadSelf = screen.kind === "done" && screen.clicked && !notes;

  useEffect(() => {
    if (reloadSelf) reloadBrowser();
  }, [reloadSelf]);

  const shown = visibleScreen(updateWatch, screen);
  if (shown.kind === "none" || reloadSelf) return null;

  const version = (v: string | null) =>
    v ?? t("settings.update.unknownVersion");
  const busy = shown.kind === "running" || shown.kind === "requested";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={busy ? "update-screen-title" : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-base)",
        animation: "fadeIn 0.2s ease",
      }}
    >
      <div
        role="status"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          maxWidth: 420,
          padding: 24,
          textAlign: "center",
          color: "var(--text-primary)",
        }}
      >
        {busy && (
          <>
            <Dots />
            <h2
              id="update-screen-title"
              style={{ fontSize: 17, fontWeight: 700, margin: 0 }}
            >
              {t("update.screen.title")}
            </h2>
          </>
        )}
        <p
          style={{
            fontSize: 13,
            color: busy ? "var(--text-dim)" : "var(--text-primary)",
            lineHeight: 1.6,
            margin: "8px 0 0",
          }}
        >
          {shown.kind === "running"
            ? t(STEP_KEYS[shown.step])
            : shown.kind === "requested"
              ? t("update.screen.requested")
              : shown.kind === "done"
                ? t("update.screen.done", { version: version(shown.version) })
                : t("update.screen.failed", {
                    version: version(shown.version),
                  })}
        </p>
        {shown.kind === "done" && notes && (
          <UpdateOutcomeNotes
            title={t("update.outcome.title")}
            messages={notes.messages}
          />
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          {shown.kind === "done" && (
            <button onClick={() => reloadBrowser()} style={buttonStyle}>
              {t("update.screen.reload")}
            </button>
          )}
          <button
            onClick={() => dispatch({ type: "update_hide", screen: shown })}
            style={quietButtonStyle}
          >
            {t("update.screen.hide")}
          </button>
        </div>
      </div>
    </div>
  );
}
