import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import type {
  InstructionsReq,
  InstructionsRes,
} from "../../shared/contract-shapes.ts";

export function CronjobsPromptDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { cronjobsPrompt, isMobile } = useAppState();
  const [text, setText] = useState(cronjobsPrompt ?? "");
  // The version of the text read on open. The save sends it back, so a write
  // from a stale tab is a 409 instead of a silent overwrite. Save stays
  // disabled until the read lands.
  const [version, setVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed read without a server message, translated at render so a
  // language switch never re-runs the read.
  const [loadFailed, setLoadFailed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Read once on open. The field stays read-only until the read lands, so the
  // answer never overwrites a draft.
  useEffect(() => {
    let cancelled = false;
    apiFetch<InstructionsRes>("GET", "/api/cron-instructions")
      .then((r) => {
        if (cancelled) return;
        setText(r.instructions ?? "");
        setVersion(r.version);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError) setError(e.message);
        else setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const shownError =
    error ?? (loadFailed ? t("dialogs.schedulePrompt.loadFailed") : null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  function handleSave() {
    if (version == null) return;
    setSaving(true);
    setError(null);
    const body: InstructionsReq = {
      instructions: text.trim() ? text : null,
      version,
    };
    apiFetch("PUT", "/api/cron-instructions", body)
      .then(() => onClose())
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : t("common.saveFailed")),
      )
      .finally(() => setSaving(false));
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "flex-start" : "center",
        justifyContent: "center",
        overflowY: "auto",
        // The card has no backdrop-filter of its own: a blur nested in this
        // one is the suspect for the page painting over the card for a
        // frame during scroll on macOS (task a09fa236). Contain stops a
        // scroll here from chaining into the page.
        overscrollBehavior: "contain",
      }}
    >
      <div
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border-light)",
          borderRadius: 16,
          padding: "24px 28px",
          marginTop: isMobile ? "env(safe-area-inset-top, 16px)" : undefined,
          marginBottom: isMobile ? 16 : undefined,
          width: isMobile ? "calc(100% - 32px)" : 440,
          maxWidth: isMobile ? "100%" : undefined,
          boxShadow: "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <h3
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: 0,
            color: "var(--text-primary)",
          }}
        >
          {t("dialogs.schedulePrompt.title")}
        </h3>

        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 18,
            marginBottom: 5,
          }}
        >
          {t("common.instructions")}{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            {t("dialogs.schedulePrompt.rulesHint")}
          </span>
        </label>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={version == null}
          placeholder={t("dialogs.schedulePrompt.rulesPlaceholder")}
          rows={8}
          style={{
            width: "100%",
            padding: "9px 12px",
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            fontSize: 12,
            outline: "none",
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          {t("dialogs.schedulePrompt.appliedNextRun")}
        </p>

        {shownError && (
          <p
            style={{
              fontSize: 11,
              color: "var(--red-text)",
              margin: "10px 0 0",
            }}
          >
            {shownError}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || version == null}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent-text)",
              color: "var(--bg-base)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
