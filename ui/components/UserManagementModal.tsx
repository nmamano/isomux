import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import {
  setUsername as saveLocalUsername,
  getUsername,
} from "../device-settings.ts";
import type { NotifRoomsSetting, UserRecord } from "../../shared/types.ts";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";
import { AccessPane } from "./AccessPane.tsx";

type ValidationStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; keyCount?: number }
  | { kind: "error"; message: string };

// Single modal that handles user selection, creation, and per-user setting
// edits. Auto-opens (modal-locked) on first connect when localStorage has no
// isomux-username; also opens from the top-bar User Settings button.
export function UserManagementModal({
  currentUsername,
  forceCreate,
  onSwitchUser,
  onClose,
}: {
  currentUsername: string | null;
  forceCreate: boolean;
  onSwitchUser: (name: string | null) => void;
  onClose?: () => void;
}) {
  const { users, rooms, isMobile, sessionContext } = useAppState();
  const isOwner = sessionContext?.role === "owner";
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );
  const [creatingName, setCreatingName] = useState("");
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // Holds the server's lockout-prevention reason if Sign out is refused.
  // Shown inline near the button until dismissed.
  const [logoutBlockedReason, setLogoutBlockedReason] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const fn = (data: string) => {
      try {
        const m = JSON.parse(data);
        if (m.type === "logout_blocked" && typeof m.reason === "string") {
          setLogoutBlockedReason(m.reason);
        }
      } catch {}
    };
    addRawListener(fn);
    return () => removeRawListener(fn);
  }, []);

  // The modal is dismissable only when the user has a known name. On first
  // connect (forceCreate=true) the user MUST pick or create someone before
  // they can use Isomux.
  const dismissable = !forceCreate && !!onClose;

  useEffect(() => {
    if (!dismissable) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [dismissable, onClose]);

  function handleCreate() {
    const trimmed = creatingName.trim();
    if (!trimmed) return;
    const lowered = trimmed.toLowerCase();
    if (users.has(lowered)) {
      setCreatingError(
        `User '${trimmed}' already exists — pick them above instead.`,
      );
      return;
    }
    send({ type: "claim_user", username: trimmed });
    saveLocalUsername(trimmed);
    onSwitchUser(trimmed);
    setCreatingName("");
    setCreatingError(null);
    if (dismissable) onClose?.();
  }

  function handleSwitchTo(record: UserRecord) {
    saveLocalUsername(record.name);
    onSwitchUser(record.name);
    if (dismissable) onClose?.();
  }

  return (
    <div
      onMouseDown={
        dismissable
          ? (e) => {
              if (e.target === e.currentTarget) onClose?.();
            }
          : undefined
      }
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
          width: isMobile ? "calc(100% - 32px)" : 640,
          maxWidth: isMobile ? "100%" : "calc(100vw - 48px)",
          maxHeight: isMobile ? "calc(100dvh - 32px)" : "85vh",
          overflowY: "auto",
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
          {forceCreate ? "Welcome — pick or create a user" : "User Settings"}
        </h3>
        <p
          style={{
            fontSize: 11,
            color: "var(--text-ghost)",
            margin: "6px 0 0",
            lineHeight: 1.4,
          }}
        >
          User profiles are stored on the server. Your default room,
          notifications, and credentials follow you across devices.
        </p>

        {userList.length > 0 && (
          <>
            <div style={labelStyle}>Existing Users</div>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {userList.map((u) => {
                const isMe =
                  currentUsername?.toLowerCase() === u.name.toLowerCase();
                const isEditing = editingKey === u.name.toLowerCase();
                return (
                  <div
                    key={u.name.toLowerCase()}
                    style={{
                      borderBottom: "1px solid var(--border-subtle)",
                      background: isMe ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: "10px 12px",
                        gap: 8,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span>
                            {u.name}
                            {isMe ? " (you)" : ""}
                          </span>
                          <RoleBadge role={u.role} />
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--text-hint)",
                            fontFamily: "'JetBrains Mono',monospace",
                            marginTop: 2,
                          }}
                        >
                          {summarizeUser(u, rooms)}
                        </div>
                      </div>
                      {!isMe && !sessionContext && (
                        <button
                          onClick={() => handleSwitchTo(u)}
                          style={smallBtnStyle}
                        >
                          Use
                        </button>
                      )}
                      <button
                        onClick={() =>
                          setEditingKey(isEditing ? null : u.name.toLowerCase())
                        }
                        style={smallBtnStyle}
                      >
                        {isEditing ? "Close" : "Edit"}
                      </button>
                    </div>
                    {isEditing && (
                      <UserEditPanel
                        user={u}
                        onClose={() => setEditingKey(null)}
                        onRenamed={(newName) => {
                          // If the edited user is the current device's user
                          // and they renamed (case-changing too), keep
                          // localStorage in sync so the next claim_user
                          // doesn't fork a new empty record.
                          const localKey = getUsername()?.toLowerCase();
                          if (localKey && localKey === u.name.toLowerCase()) {
                            saveLocalUsername(newName);
                            onSwitchUser(newName);
                          }
                        }}
                        onDeleted={() => {
                          // If the deleted user is the current device's
                          // user, clear localStorage so the picker auto-
                          // opens (modal-locked) on the next render.
                          const localKey = getUsername()?.toLowerCase();
                          if (localKey && localKey === u.name.toLowerCase()) {
                            saveLocalUsername("");
                            if (typeof localStorage !== "undefined")
                              localStorage.removeItem("isomux-username");
                            onSwitchUser(null);
                          }
                          setEditingKey(null);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!sessionContext && (
          <>
            <div style={labelStyle}>Create New User</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                autoFocus={forceCreate || userList.length === 0}
                value={creatingName}
                onChange={(e) => {
                  setCreatingName(e.target.value.slice(0, 32));
                  setCreatingError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
                maxLength={32}
                placeholder="Your name"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={handleCreate}
                disabled={!creatingName.trim()}
                style={{
                  ...saveBtnStyle,
                  opacity: creatingName.trim() ? 1 : 0.5,
                  cursor: creatingName.trim() ? "pointer" : "default",
                }}
              >
                Create
              </button>
            </div>
            {creatingError && (
              <p style={{ fontSize: 10, color: "#ff6b6b", margin: "6px 0 0" }}>
                {creatingError}
              </p>
            )}
          </>
        )}

        {isOwner && <AccessPane />}

        {sessionContext && (
          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => {
                setLogoutBlockedReason(null);
                send({ type: "logout" });
                // The WS will close after the server-side revoke; the page
                // reload triggered by session_expired will land us on the
                // login wall. If the server refuses (lockout prevention),
                // the raw listener above will set logoutBlockedReason and
                // we'll render the inline note below.
              }}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid #ff6b6b",
                background: "transparent",
                color: "#ff6b6b",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="End this device's session"
            >
              Sign out
            </button>
            {logoutBlockedReason && (
              <p
                style={{
                  margin: "8px 0 0",
                  padding: "8px 12px",
                  border: "1px solid #ff6b6b",
                  borderRadius: 6,
                  background: "rgba(255,107,107,0.08)",
                  fontSize: 11,
                  color: "#ff6b6b",
                  maxWidth: 520,
                }}
              >
                {logoutBlockedReason}
              </p>
            )}
          </div>
        )}

        {dismissable && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 20,
            }}
          >
            <button onClick={onClose} style={cancelBtnStyle}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function summarizeUser(
  u: UserRecord,
  rooms: { id: string; name: string }[],
): string {
  const parts: string[] = [];
  const room = rooms.find((r) => r.id === u.defaultRoomId);
  parts.push(`default: ${room?.name ?? "first room"}`);
  if (u.notifRooms === "all") parts.push("notify: all rooms");
  else
    parts.push(
      `notify: ${u.notifRooms.length} room${u.notifRooms.length === 1 ? "" : "s"}`,
    );
  if (u.envFile) parts.push("env: configured");
  return parts.join(" · ");
}

function UserEditPanel({
  user,
  onClose,
  onRenamed,
  onDeleted,
}: {
  user: UserRecord;
  onClose: () => void;
  onRenamed?: (newName: string) => void;
  onDeleted?: () => void;
}) {
  const { rooms } = useAppState();
  const [name, setName] = useState(user.name);
  const [defaultRoomId, setDefaultRoomId] = useState<string | null>(
    user.defaultRoomId,
  );
  const [notifSetting, setNotifSetting] = useState<NotifRoomsSetting>(
    user.notifRooms,
  );
  const [envFile, setEnvFile] = useState<string>(user.envFile ?? "");
  const [validation, setValidation] = useState<ValidationStatus>({
    kind: "idle",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Holds the server's lockout-prevention reason if delete_user is refused.
  // Same shape as the logout_blocked / revoke_blocked surfaces elsewhere —
  // shown inline next to Delete so the boss sees why the row didn't go.
  const [deleteBlockedReason, setDeleteBlockedReason] = useState<string | null>(
    null,
  );
  // Tracks the requestId of an in-flight delete so we can correlate the
  // server's delete_user_blocked / users_list responses. Kept in a ref
  // because it's read inside a raw listener closure that doesn't need to
  // trigger a re-render when it changes.
  const pendingDeleteReqRef = useRef<string | null>(null);
  // Mirror the latest onDeleted into a ref so the raw-listener effect can
  // mount once and stay subscribed — re-running it on every parent render
  // (the parent re-creates the callback inline) would churn the listener
  // and open a tiny race window where a server message lands between
  // remove + re-add.
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => {
    onDeletedRef.current = onDeleted;
  }, [onDeleted]);
  const userNameRef = useRef(user.name);
  useEffect(() => {
    userNameRef.current = user.name;
  }, [user.name]);

  // Correlate the server's response to delete_user. The raw listener fires
  // before the store dispatch so calling onDeleted here runs synchronously
  // alongside the users_list state update — the parent batches both into
  // one render (editingKey cleared + user gone from the list).
  useEffect(() => {
    const fn = (data: string) => {
      // Cheap early-out: skip JSON.parse on every server message when we
      // don't have a delete in flight.
      if (!pendingDeleteReqRef.current) return;
      try {
        const m = JSON.parse(data);
        if (
          m.type === "delete_user_blocked" &&
          m.requestId === pendingDeleteReqRef.current
        ) {
          pendingDeleteReqRef.current = null;
          setDeleteBlockedReason(
            typeof m.reason === "string" ? m.reason : "Refused.",
          );
          setConfirmDelete(false);
          return;
        }
        if (m.type === "users_list" && Array.isArray(m.users)) {
          const targetLower = userNameRef.current.toLowerCase();
          const stillPresent = m.users.some(
            (u: { name?: unknown }) =>
              typeof u?.name === "string" &&
              u.name.toLowerCase() === targetLower,
          );
          if (!stillPresent) {
            pendingDeleteReqRef.current = null;
            onDeletedRef.current?.();
          }
        }
      } catch {}
    };
    addRawListener(fn);
    return () => removeRawListener(fn);
  }, []);

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (pendingDeleteReqRef.current) return;
    const reqId = `delete-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingDeleteReqRef.current = reqId;
    setDeleteBlockedReason(null);
    send({ type: "delete_user", requestId: reqId, username: user.name });
  }

  // Validate the stored envFile on open.
  useEffect(() => {
    if (!user.envFile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValidation({ kind: "idle" });
      return;
    }
    const reqId = `user-env-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setValidation({ kind: "pending" });
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "settings_validation" && msg.requestId === reqId) {
          if (msg.ok) setValidation({ kind: "ok", keyCount: msg.keyCount });
          else
            setValidation({
              kind: "error",
              message: msg.error || "Invalid env file",
            });
          removeRawListener(listener);
        }
      } catch {}
    };
    addRawListener(listener);
    send({
      type: "request_settings_validation",
      requestId: reqId,
      scope: "user",
      username: user.name,
    });
    return () => removeRawListener(listener);
  }, [user.envFile, user.name]);

  function toggleRoomNotif(roomId: string) {
    if (notifSetting === "all") {
      setNotifSetting(rooms.filter((r) => r.id !== roomId).map((r) => r.id));
      return;
    }
    const has = notifSetting.includes(roomId);
    const next = has
      ? notifSetting.filter((id) => id !== roomId)
      : [...notifSetting, roomId];
    const coversAll =
      rooms.length > 0 && rooms.every((r) => next.includes(r.id));
    setNotifSetting(coversAll ? "all" : next);
  }

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const reqId = `user-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setSaving(true);
    setError(null);
    const renamed = trimmed !== user.name;
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "settings_save_response" && msg.requestId === reqId) {
          setSaving(false);
          removeRawListener(listener);
          if (msg.ok) {
            if (renamed) onRenamed?.(trimmed);
            onClose();
          } else {
            setError(msg.error || "Save failed");
          }
        }
      } catch {}
    };
    addRawListener(listener);
    send({
      type: "update_user",
      requestId: reqId,
      username: user.name,
      changes: {
        name: renamed ? trimmed : undefined,
        defaultRoomId,
        notifRooms: notifSetting,
        envFile: envFile.trim() || null,
      },
    });
  }

  return (
    <div
      style={{
        padding: "10px 12px 14px",
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-input)",
      }}
    >
      <label style={subLabelStyle}>Display Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 32))}
        maxLength={32}
        style={inputStyle}
      />

      <label style={subLabelStyle}>
        Default Room <span style={hintStyle}>(opens when you load Isomux)</span>
      </label>
      <select
        value={defaultRoomId ?? ""}
        onChange={(e) => setDefaultRoomId(e.target.value || null)}
        style={inputStyle}
      >
        <option value="">Whichever is first</option>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      <label style={subLabelStyle}>
        Notifications{" "}
        <span style={hintStyle}>
          (sound when an agent in these rooms finishes)
        </span>
      </label>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-base)",
          padding: "4px 0",
          maxHeight: 140,
          overflowY: "auto",
        }}
      >
        {rooms.length === 0 ? (
          <div
            style={{
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--text-ghost)",
            }}
          >
            No rooms yet.
          </div>
        ) : (
          rooms.map((r) => {
            const checked =
              notifSetting === "all" || notifSetting.includes(r.id);
            return (
              <label
                key={r.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 12px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleRoomNotif(r.id)}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span>{r.name}</span>
              </label>
            );
          })
        )}
      </div>

      <label style={subLabelStyle}>
        Env File Path{" "}
        <span style={hintStyle}>
          (absolute path; applied at agent spawn time — existing agents keep
          their current env)
        </span>
      </label>
      <input
        value={envFile}
        onChange={(e) => {
          setEnvFile(e.target.value);
          setValidation({ kind: "idle" });
        }}
        placeholder="/home/you/.secrets/me.env"
        style={inputStyle}
      />
      <ValidationLine status={validation} />

      {error && (
        <p style={{ fontSize: 10, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}

      {deleteBlockedReason && (
        <p
          style={{
            margin: "8px 0 0",
            padding: "8px 12px",
            border: "1px solid #ff6b6b",
            borderRadius: 6,
            background: "rgba(255,107,107,0.08)",
            fontSize: 11,
            color: "#ff6b6b",
          }}
        >
          {deleteBlockedReason}
        </p>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 12,
        }}
      >
        <button
          onClick={handleDelete}
          onBlur={() => setConfirmDelete(false)}
          disabled={saving}
          style={{
            padding: "7px 14px",
            borderRadius: 6,
            border: `1px solid ${confirmDelete ? "var(--red)" : "var(--border)"}`,
            background: confirmDelete ? "var(--red)" : "transparent",
            color: confirmDelete ? "var(--bg-base)" : "var(--red)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="Delete this user"
        >
          {confirmDelete ? "Confirm?" : "Delete"}
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            style={{
              ...saveBtnStyle,
              opacity: saving || !name.trim() ? 0.5 : 1,
              cursor: saving || !name.trim() ? "default" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Compact role indicator next to each user's display name. Intentionally
// muted: the owner/member distinction is about who can mint invites and
// revoke sessions, not about who can do things inside the office (everyone
// authenticated has full operational access).
function RoleBadge({ role }: { role: "owner" | "member" }) {
  const isOwner = role === "owner";
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        padding: "1px 6px",
        borderRadius: 4,
        border: `1px solid ${isOwner ? "var(--accent)" : "var(--border)"}`,
        color: isOwner ? "var(--accent)" : "var(--text-ghost)",
        background: "transparent",
      }}
      title={
        isOwner
          ? "Owner — can mint invites and revoke sessions"
          : "Member — full office access, can't mint invites"
      }
    >
      {role}
    </span>
  );
}

function ValidationLine({ status }: { status: ValidationStatus }) {
  if (status.kind === "idle") return null;
  if (status.kind === "pending")
    return (
      <p
        style={{ fontSize: 10, color: "var(--text-ghost)", margin: "4px 0 0" }}
      >
        Checking…
      </p>
    );
  if (status.kind === "ok")
    return (
      <p style={{ fontSize: 10, color: "var(--accent)", margin: "4px 0 0" }}>
        Loaded {status.keyCount ?? 0} variable{status.keyCount === 1 ? "" : "s"}
        .
      </p>
    );
  return (
    <p style={{ fontSize: 10, color: "#ff6b6b", margin: "4px 0 0" }}>
      {status.message}
    </p>
  );
}

const labelStyle: React.CSSProperties = {
  ...dialogLabel,
  marginTop: 18,
  marginBottom: 6,
};
const subLabelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 10 };
const hintStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;

const smallBtnStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 11,
  cursor: "pointer",
};
