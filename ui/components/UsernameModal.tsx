import { useState } from "react";

export function UsernameModal({
  onSave,
  onClose,
  defaultValue,
}: {
  onSave: (name: string) => void;
  onClose?: () => void;
  defaultValue?: string;
}) {
  const [name, setName] = useState(defaultValue ?? "");
  const isEditing = defaultValue != null;
  const canSubmit = name.trim().length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    onSave(name.trim());
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-medium)",
          borderRadius: 16,
          padding: 28,
          width: 340,
          maxWidth: "90vw",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: "var(--text-primary)",
            marginBottom: 16,
            fontFamily: "'DM Sans',sans-serif",
          }}
        >
          What's your name?
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape" && onClose) onClose();
          }}
          maxLength={16}
          placeholder="Enter your name"
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--border-medium)",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            fontSize: 14,
            fontFamily: "'JetBrains Mono',monospace",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          {isEditing && onClose && (
            <button
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid var(--border-medium)",
                background: "var(--btn-surface)",
                color: "var(--text-dim)",
                fontSize: 13,
                fontFamily: "'DM Sans',sans-serif",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: canSubmit ? "var(--accent)" : "var(--bg-hover)",
              color: canSubmit ? "var(--bg-base)" : "var(--text-ghost)",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "'DM Sans',sans-serif",
              cursor: canSubmit ? "pointer" : "default",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {isEditing ? "Save" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
