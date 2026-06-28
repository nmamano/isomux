import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type {
  RoomRenameReq,
  RoomSettingsReq,
} from "../../shared/contract-shapes.ts";
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
  // Protection is server-authoritative and carried explicitly on the wire:
  // room.canCloseWhenEmpty is false ONLY for the protected canonical first room
  // (derived from canonical room order, independent of this viewer's order), so
  // it's correct even under a custom room order. Emptiness stays a client-side
  // reactive check; the server stays authoritative on the close.
  const canDeleteRoom =
    (room?.canCloseWhenEmpty ?? false) &&
    agents.every((agent) => agent.roomId !== roomId);
  const [name, setName] = useState(room?.name ?? "");
  const [prompt, setPrompt] = useState(room?.prompt ?? "");
  // Raw room memory, loaded lazily; sent back only once the load succeeds so an
  // unrelated name/prompt save can't wipe rooms/<id>.md.
  const [memory, setMemory] = useState("");
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    setError(null);
    // Rename is an independent, cosmetic field; fire-and-forget, parity with the
    // old WS rename_room (which never blocked the dialog). It shares the settings
    // PUT's room:manage guard, so a rename that would 403 already fails the
    // settings save below — no separate error surface needed.
    if (room && trimmedName !== room.name) {
      const renameBody: RoomRenameReq = { name: trimmedName };
      apiFetch<void>("PATCH", `/api/rooms/${roomId}`, renameBody).catch(
        () => {},
      );
    }
    // The settings save drives the dialog: success closes it, an ApiError shows
    // inline (the HTTP response replaces the old settings_save_response correlation).
    const settingsBody: RoomSettingsReq = {
      prompt: prompt.trim() ? prompt : null,
      // Only send memory once the raw load succeeded (else leave the file alone).
      ...(memoryLoaded ? { memory } : {}),
    };
    apiFetch<void>("PUT", `/api/rooms/${roomId}/settings`, settingsBody)
      .then(() => onClose())
      .catch((e) => setError(e instanceof ApiError ? e.message : "Save failed"))
      .finally(() => setSaving(false));
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

  // Load raw room memory on open. Until it resolves the textarea stays disabled
  // and memory is omitted from the save. Reset first so a roomId change can't
  // leave the previous room's text marked loaded (a fast Save would rewrite the
  // new room with stale memory).
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMemoryLoaded(false);
    setMemory("");
    apiFetch<{ text: string }>("GET", `/api/rooms/${roomId}/memory/raw`)
      .then((r) => {
        if (cancelled) return;
        setMemory(r.text);
        setMemoryLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomId]);

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
          Memory{" "}
          <span style={{ fontWeight: 400, color: "var(--text-ghost)" }}>
            (durable facts for this room; raw lines)
          </span>
        </label>
        <textarea
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          placeholder={
            memoryLoaded
              ? "This room uses Bun for local scripts"
              : "Loading memory…"
          }
          rows={6}
          readOnly={!memoryLoaded}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          New lines get an id + your name on save; edited lines keep theirs;
          removed lines are dropped.
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
                // Fire-and-forget + optimistic close, parity with the old WS
                // close_room (the room_closed broadcast removes the tab).
                apiFetch<void>("DELETE", `/api/rooms/${roomId}`).catch(
                  () => {},
                );
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
