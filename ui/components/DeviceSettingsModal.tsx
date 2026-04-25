import { useState, useEffect } from "react";
import { useAppState } from "../store.tsx";
import {
  getDefaultRoomId,
  setDefaultRoomId,
  getNotifRooms,
  setNotifRooms,
  shouldNotifyRoom,
  type NotifRoomsSetting,
} from "../device-settings.ts";

export function DeviceSettingsModal({
  onClose,
  username,
  onSaveUsername,
}: {
  onClose: () => void;
  username: string;
  onSaveUsername: (name: string) => void;
}) {
  const { rooms, isMobile } = useAppState();
  const [name, setName] = useState(username);
  const [defaultRoomId, setDefaultRoomIdState] = useState<string | null>(() => getDefaultRoomId());
  const [notifSetting, setNotifSetting] = useState<NotifRoomsSetting>(() => getNotifRooms());

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  function toggleRoomNotif(roomId: string) {
    if (notifSetting === "all") {
      // Drop just this room from the implicit "all" set
      setNotifSetting(rooms.filter((r) => r.id !== roomId).map((r) => r.id));
      return;
    }
    const has = notifSetting.includes(roomId);
    const next = has ? notifSetting.filter((id) => id !== roomId) : [...notifSetting, roomId];
    // If selection now covers every existing room, collapse to "all" so future
    // rooms inherit the same on-by-default behavior.
    const coversAll = rooms.length > 0 && rooms.every((r) => next.includes(r.id));
    setNotifSetting(coversAll ? "all" : next);
  }

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== username) onSaveUsername(trimmed);
    setDefaultRoomId(defaultRoomId);
    setNotifRooms(notifSetting);
    onClose();
  }

  const canSave = name.trim().length > 0;

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
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
          Device Settings
        </h3>
        <p style={{ fontSize: 11, color: "var(--text-ghost)", margin: "6px 0 0", lineHeight: 1.4 }}>
          Stored locally in this browser. Not synced across devices, and may be lost if browser storage is cleared.
        </p>

        <label style={labelStyle}>Boss Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          maxLength={16}
          placeholder="Your name"
          style={inputStyle}
        />

        <label style={labelStyle}>
          Default Room <span style={hintStyle}>(which room opens when Isomux loads)</span>
        </label>
        <div style={{ position: "relative" }}>
          <select
            value={defaultRoomId ?? ""}
            onChange={(e) => setDefaultRoomIdState(e.target.value || null)}
            style={{ ...inputStyle, paddingRight: 28, appearance: "none", WebkitAppearance: "none", MozAppearance: "none" }}
          >
            <option value="">Whichever is first</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: 12,
              top: "50%",
              transform: "translateY(-50%)",
              pointerEvents: "none",
              color: "var(--text-muted)",
              fontSize: 10,
              lineHeight: 1,
            }}
          >▾</span>
        </div>

        <label style={labelStyle}>
          Room Notifications <span style={hintStyle}>(sound when an agent in these rooms finishes)</span>
        </label>
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-input)",
            padding: "4px 0",
            maxHeight: 180,
            overflowY: "auto",
          }}
        >
          {rooms.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-ghost)" }}>No rooms yet.</div>
          ) : (
            rooms.map((r) => (
              <label
                key={r.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 12px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={shouldNotifyRoom(r.id, notifSetting)}
                  onChange={() => toggleRoomNotif(r.id)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span>{r.name}</span>
              </label>
            ))
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={{ ...saveBtnStyle, opacity: canSave ? 1 : 0.5, cursor: canSave ? "pointer" : "default" }} disabled={!canSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginTop: 16,
  marginBottom: 5,
};

const hintStyle: React.CSSProperties = {
  fontWeight: 400,
  color: "var(--text-ghost)",
};

const inputStyle: React.CSSProperties = {
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
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
};
