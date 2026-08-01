import { useState, useEffect, useRef } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import type {
  RoomRenameReq,
  RoomSettingsReq,
  RoomSettingsRes,
} from "../../shared/contract-shapes.ts";
import {
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
} from "./dialog-styles.ts";
import {
  ExpandableTextarea,
  isExpandedEditorOpen,
} from "./ExpandableTextarea.tsx";

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
  // Room memory is edited via the unified /api/memory verbs (load + version-
  // guarded save). Saved separately from the room settings PUT.
  const mem = useMemoryEditor("room", roomId, true);
  // The settings PUT is version-guarded (optimistic concurrency, mirroring the
  // memory editor): GET on open, send the version back on save; a 409 means
  // another writer saved since - keep the dialog open and say so. The token
  // must stay coupled to the BYTES read with it, so the prompt field hydrates
  // from the same GET response (never pair a store-snapshot prompt with the
  // GET's version - a fresher server prompt would be silently blessed over).
  // Until the load resolves the field is read-only and Save stays disabled;
  // the store value paints first purely as a placeholder.
  const [settingsVersion, setSettingsVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsLoaded = settingsVersion != null;

  useEffect(() => {
    let cancelled = false;
    apiFetch<RoomSettingsRes>("GET", `/api/rooms/${roomId}/settings`)
      .then((r) => {
        if (cancelled) return;
        setPrompt(r.prompt ?? "");
        setSettingsVersion(r.version);
      })
      .catch(() => {
        // Leave version null -> field stays read-only, Save stays disabled
        // (no way to write safely).
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName || settingsVersion == null) return;
    setSaving(true);
    setError(null);
    // Rename is an independent, cosmetic field; fire-and-forget, parity with the
    // old WS rename_room (which never blocked the dialog). It shares the settings
    // PUT's room:manage guard, so a rename that would 403 already fails the
    // settings save below - no separate error surface needed.
    if (room && trimmedName !== room.name) {
      const renameBody: RoomRenameReq = { name: trimmedName };
      apiFetch<void>("PATCH", `/api/rooms/${roomId}`, renameBody).catch(
        () => {},
      );
    }
    // The settings save drives the dialog: success closes it, an ApiError shows
    // inline. Memory is a separate version-guarded REPLACE on /api/memory.
    const settingsBody: RoomSettingsReq = {
      prompt: prompt.trim() ? prompt : null,
      version: settingsVersion,
    };
    void (async () => {
      try {
        await apiFetch<void>(
          "PUT",
          `/api/rooms/${roomId}/settings`,
          settingsBody,
        );
        const m = await mem.save();
        if (!m.ok) {
          setError(m.message);
          return;
        }
        onClose();
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") {
          setError(
            "Room settings changed since you opened this - reopen the dialog to edit the latest.",
          );
        } else {
          setError(e instanceof ApiError ? e.message : "Save failed");
        }
      } finally {
        setSaving(false);
      }
    })();
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
      // An expanded editor owns Escape while it is open (it collapses instead
      // of closing this dialog). Our capture listener runs first, so the
      // stand-down has to happen here.
      if (e.key === "Escape" && !isExpandedEditorOpen()) {
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
        <ExpandableTextarea
          textareaRef={textareaRef}
          title={`${room.name} · Room Prompt`}
          hint="Changes take effect on next conversation."
          value={prompt}
          onChange={setPrompt}
          placeholder="e.g. You're in the Marketing room. Match our brand voice."
          rows={8}
          readOnly={!settingsLoaded}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          Changes take effect on next conversation. Env files are now per-user -
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
        <ExpandableTextarea
          title={`${room.name} · Memory`}
          hint="This editor rewrites the file exactly as shown. Use one memory per line; keep existing author/date text unless you mean to change it."
          value={mem.memory}
          onChange={mem.setMemory}
          placeholder={
            mem.loaded ? "Some memory relevant to this room" : "Loading memory…"
          }
          rows={6}
          readOnly={!mem.loaded}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        <p
          style={{
            fontSize: 10,
            color: "var(--text-ghost)",
            margin: "3px 0 0",
          }}
        >
          This editor rewrites the file exactly as shown. Use one memory per
          line; keep existing author/date text unless you mean to change it.
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
              const disabled =
                saving || !name.trim() || settingsVersion == null;
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
