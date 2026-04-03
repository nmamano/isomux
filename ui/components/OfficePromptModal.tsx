import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { send } from "../ws.ts";

export function OfficePromptModal({ onClose, username, onSaveUsername }: { onClose: () => void; username: string; onSaveUsername: (name: string) => void }) {
  const { officePrompt, isMobile } = useAppState();
  const [text, setText] = useState(officePrompt);
  const [name, setName] = useState(username);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSave() {
    send({ type: "set_office_prompt", text });
    if (name.trim() && name.trim() !== username) onSaveUsername(name.trim());
    onClose();
  }

  // Place cursor at end of text on mount
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, []);

  // ESC to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
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
        onClick={(e) => e.stopPropagation()}
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
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
          Office Settings
        </h3>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginTop: 18, marginBottom: 5 }}>Boss Title</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
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
          }}
        />

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginTop: 14, marginBottom: 5 }}>Rules <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>(system prompt for all agents)</span></label>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Always write tests. Use TypeScript. Be concise."
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
          Changes take effect on next conversation.
        </p>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={saveBtnStyle}>Save</button>
        </div>
      </div>
    </div>
  );
}

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'DM Sans',sans-serif",
};
