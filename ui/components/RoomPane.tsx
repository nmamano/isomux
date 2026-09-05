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
import { ExpandableTextarea } from "./ExpandableTextarea.tsx";

// One room's settings, as a pane. Mounted keyed by roomId, so switching rooms
// in the sidebar remounts it and no field can carry across.
//
// `onDeleted` exists because deleting an empty room removes its own sidebar
// row: the page has to move the selection somewhere that still exists.
export function RoomPane({
  roomId,
  onDeleted,
  closeRef,
}: {
  roomId: string;
  onDeleted: () => void;
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { agents, rooms } = useAppState();
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
  // What the fields held when they last agreed with the server - captured at
  // hydration, reset on save. Dirtiness is measured against THIS, never
  // against the store snapshot: the prompt comes from the version-guarded GET
  // and can legitimately differ from the store's copy (see below), and `name`
  // is captured once at mount, so comparing either against a live store value
  // makes an untouched pane look dirty and the discard prompt cry wolf. Same
  // shape useMemoryEditor already uses for mem.dirty.
  const [baselineName, setBaselineName] = useState(room?.name ?? "");
  const [baselinePrompt, setBaselinePrompt] = useState("");
  // Room memory is edited via the unified /api/memory verbs (load + version-
  // guarded save). Saved separately from the room settings PUT.
  const mem = useMemoryEditor("room", roomId, true);
  // The settings PUT is version-guarded (optimistic concurrency, mirroring the
  // memory editor): GET on open, send the version back on save; a 409 means
  // another writer saved since - stay on the pane and say so. The token
  // must stay coupled to the BYTES read with it, so the prompt field hydrates
  // from the same GET response (never pair a store-snapshot prompt with the
  // GET's version - a fresher server prompt would be silently blessed over).
  // Until the load resolves the field is read-only and Save stays disabled;
  // the store value paints first purely as a placeholder.
  const [settingsVersion, setSettingsVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsLoaded = settingsVersion != null;

  useEffect(() => {
    let cancelled = false;
    apiFetch<RoomSettingsRes>("GET", `/api/rooms/${roomId}/settings`)
      .then((r) => {
        if (cancelled) return;
        setPrompt(r.prompt ?? "");
        setBaselinePrompt(r.prompt ?? "");
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
    // old WS rename_room, which never blocked the save. It shares the settings
    // PUT's room:manage guard, so a rename that would 403 already fails the
    // settings save below - no separate error surface needed.
    if (room && trimmedName !== room.name) {
      const renameBody: RoomRenameReq = { name: trimmedName };
      apiFetch<void>("PATCH", `/api/rooms/${roomId}`, renameBody).catch(
        () => {},
      );
    }
    // The settings save drives the pane: success settles it to "Saved", an
    // ApiError shows inline. Memory is a separate version-guarded REPLACE on
    // /api/memory.
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
        // The PUT above SPENT the token, so refresh it here - before
        // anything that can fail and return. Doing this after the memory save
        // meant a memory conflict left a spent token behind, and the reader's
        // next Save came back as "settings changed since you opened this":
        // a false cause, for a failure their own successful save created.
        //
        // Its own try/catch, because a failed re-read is not a failed save.
        // Reporting it as one tells the reader the opposite of what happened
        // and sends them to save again, into a 409.
        try {
          const next = await apiFetch<RoomSettingsRes>(
            "GET",
            `/api/rooms/${roomId}/settings`,
          );
          setSettingsVersion(next.version);
          // The FIELD is set from the response too, not just the baseline. The
          // server normalizes an all-whitespace prompt to null, so without
          // this the field keeps the whitespace, the baseline becomes "", and
          // the pane is dirty the instant a save succeeds.
          setPrompt(next.prompt ?? "");
          setBaselinePrompt(next.prompt ?? "");
        } catch {
          // No safe token to write with. Null disables Save, matching the
          // failed-hydration path above, and the save that already landed
          // still counts.
          setSettingsVersion(null);
          setError(
            "Saved, but this page could not reload the room. Select another row and come back to keep editing.",
          );
        }
        setBaselineName(trimmedName);
        setSavedAt(Date.now());
        const m = await mem.save();
        if (!m.ok) {
          setError(m.message);
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") {
          setError(
            "Room settings changed somewhere else since this page loaded. Select another row and come back to load the latest.",
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

  // Mirror the unsaved-changes guard into the page's ref every render, so the
  // captured closure sees fresh field state - the no-deps pattern
  // UserEditPanel and DevicePane use. Name, prompt and memory are all
  // dirty-capable; without this a sidebar click drops all three in silence.
  const dirty =
    (settingsLoaded && (name.trim() !== baselineName || prompt !== baselinePrompt)) ||
    mem.dirty;
  useEffect(() => {
    if (closeRef) {
      closeRef.current = (after?: () => void) => {
        if (dirty && !confirm("Discard unsaved changes to this room?")) return;
        after?.();
      };
    }
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  if (!room) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <div>
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
        <p
          style={{
            fontSize: 11,
            color: "var(--text-ghost)",
            margin: "6px 0 0",
            lineHeight: 1.4,
          }}
        >
          Double-click a room tab to come straight here.
        </p>

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
          Changes take effect on next conversation. Set environment variables
          under Connections.
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
            (durable facts for this room; raw lines; {mem.size} /{" "}
            {mem.cap ?? "…"})
          </span>
        </label>
        <ExpandableTextarea
          title={`${room.name} · Memory`}
          hint="This editor rewrites the file exactly as shown. Use one memory per line."
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
          line.
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
                onDeleted();
              }}
              style={deleteBtnStyle}
              disabled={saving}
            >
              Delete empty room
            </button>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setName(baselineName);
                setPrompt(baselinePrompt);
                mem.reset();
                setError(null);
              }}
              style={cancelBtnStyle}
              disabled={saving || !dirty}
            >
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
                  {saving ? "Saving…" : savedAt && !dirty ? "Saved" : "Save"}
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
