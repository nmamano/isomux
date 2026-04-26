import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";

export function CronjobsPromptDialog({ onClose }: { onClose: () => void }) {
  const { cronjobsPrompt, isMobile } = useAppState();
  const [text, setText] = useState(cronjobsPrompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  function handleSave() {
    const reqId = `cronjobs-prompt-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setSaving(true);
    setError(null);
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "settings_save_response" && msg.requestId === reqId) {
          removeRawListener(listener);
          setSaving(false);
          if (msg.ok) onClose();
          else setError(msg.error || "Save failed");
        }
      } catch {}
    };
    addRawListener(listener);
    send({
      type: "update_cronjobs_prompt",
      requestId: reqId,
      value: text.trim() ? text : null,
    });
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
      }}
    >
      <div
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
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
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>Cronjobs Settings</h3>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginTop: 18, marginBottom: 5 }}>
          Rules <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>(system prompt for all cronjobs)</span>
        </label>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Always write findings to a markdown file. Be terse."
          rows={8}
          style={{
            width: "100%",
            padding: "9px 12px",
            background: "var(--bg-input)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12,
            outline: "none",
            boxSizing: "border-box",
            resize: "vertical",
          }}
        />
        <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>
          Applied to the next run; in-flight runs use their captured snapshot.
        </p>

        {error && <p style={{ fontSize: 11, color: "#ff6b6b", margin: "10px 0 0" }}>{error}</p>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
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
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "var(--bg-base)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
