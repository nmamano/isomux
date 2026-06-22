import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import {
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
} from "./dialog-styles.ts";

export function RoomSettingsModal({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const { agents, rooms, isMobile } = useAppState();
  const room = rooms.find((r) => r.id === roomId);
  const roomIndex = rooms.findIndex((r) => r.id === roomId);
  // Emptiness is id-based and authoritative. `roomIndex > 0` is NOT
  // semantically correct: it approximates the server's protected-first-room
  // rule (office-state.closeRoom refuses global index <= 0) via the VISIBLE
  // index, which is right only under default view order and diverges once a
  // user sets a custom order. It is a temporary default-order-compatible
  // approximation until RoomWire carries an explicit protected/deletable
  // capability (slice 4). The server stays authoritative on the close.
  const canDeleteRoom =
    roomIndex > 0 && agents.every((agent) => agent.roomId !== roomId);
  const [name, setName] = useState(room?.name ?? "");
  const [prompt, setPrompt] = useState(room?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (room && trimmedName !== room.name) {
      send({ type: "rename_room", roomId, name: trimmedName });
    }
    const reqId = `room-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setSaving(true);
    setError(null);
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "settings_save_response" && msg.requestId === reqId) {
          setSaving(false);
          removeRawListener(listener);
          if (msg.ok) onClose();
          else setError(msg.error || "Save failed");
        }
      } catch {}
    };
    addRawListener(listener);
    send({
      type: "update_room_settings",
      requestId: reqId,
      roomId,
      prompt: prompt.trim() ? prompt : null,
    });
  }

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

  if (!room) return null;

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
        <h3
          style={{
            fontSize: 17,
            fontWeight: 700,
            margin: 0,
            color: "var(--text-primary)",
          }}
        >
          {room.name} · Settings
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
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name"
          style={inputStyle}
        />

        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 14,
            marginBottom: 5,
          }}
        >
          Room Prompt{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (optional, appended after office prompt)
          </span>
        </label>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. You're in the Marketing room. Match our brand voice."
          rows={8}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          Changes take effect on next conversation. Env files are now per-user —
          set them in User Settings.
        </p>

        {error && (
          <p style={{ fontSize: 10, color: "#ff6b6b", margin: "6px 0 0" }}>
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: canDeleteRoom ? "space-between" : "flex-end",
            alignItems: "center",
            gap: 8,
            marginTop: 20,
          }}
        >
          {canDeleteRoom && (
            <button
              onClick={() => {
                send({ type: "close_room", roomId });
                onClose();
              }}
              style={deleteBtnStyle}
              disabled={saving}
            >
              Delete empty room
            </button>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>
              Cancel
            </button>
            {(() => {
              const disabled = saving || !name.trim();
              return (
                <button
                  onClick={handleSave}
                  disabled={disabled}
                  style={{
                    ...saveBtnStyle,
                    opacity: disabled ? 0.45 : 1,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = {
  ...dialogCancelBtn,
  fontFamily: "'DM Sans',sans-serif",
};
const saveBtnStyle: React.CSSProperties = {
  ...dialogSaveBtn,
  fontFamily: "'DM Sans',sans-serif",
};
const deleteBtnStyle: React.CSSProperties = {
  ...dialogCancelBtn,
  borderColor: "rgba(255, 107, 107, 0.45)",
  color: "#ff8a8a",
  fontFamily: "'DM Sans',sans-serif",
};
