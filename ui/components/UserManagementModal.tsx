import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import {
  setUsername as saveLocalUsername,
  getUsername,
} from "../device-settings.ts";
import type { NotifRoomsSetting, UserRecord } from "../../shared/types.ts";
import { type UserView, isFullUserView } from "../user-merge.ts";
import {
  GHOST_COLOR_PALETTE,
  GHOST_VARIANTS,
  isHexColor,
  normalizeHexColor,
  type GhostVariant,
} from "../../shared/avatar.ts";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";
import { AccessPane } from "./AccessPane.tsx";
import { MyDevicesPane } from "./MyDevicesPane.tsx";

type ValidationStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; keyCount?: number }
  | { kind: "error"; message: string };

export function UserManagementModal({
  initialUserId,
  onSwitchUser,
  onClose,
}: {
  // Live-avatars: when set, the modal opens with this user's edit
  // panel expanded (used by ghost click → settings shortcut). Read
  // once on mount; updates to this prop while the modal is mounted
  // do NOT re-sync the selection. The parent (App.tsx) clears the
  // value on close, so each reopen with a different initialUserId
  // mounts a fresh modal and applies the new target — which is the
  // only path that exercises this prop today.
  initialUserId?: string | null;
  onSwitchUser: (name: string | null) => void;
  onClose?: () => void;
}) {
  const { users, rooms, allRooms, isMobile, sessionContext } = useAppState();
  const isOwner = sessionContext?.role === "owner";
  // Owners need every room for the Allowed Rooms editor and the user
  // summaries below, including rooms they've hidden from their own
  // view. `allRooms` is pushed by the server to owner WSes only;
  // members fall back to their projected `rooms` (already filtered).
  const editorRooms = allRooms.length > 0 ? allRooms : rooms;
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );
  const [editingKey, setEditingKey] = useState<string | null>(() => {
    if (!initialUserId) return null;
    // Resolve userId → display name → lowercased map key. If the user
    // record isn't in the store yet (rare race on first connect),
    // fall back to the generic open state — the user just sees the list.
    for (const u of users.values()) {
      if (u.id === initialUserId) return u.name.toLowerCase();
    }
    return null;
  });
  // Filled by the currently-mounted UserEditPanel. Lets us route every
  // close path (row-level Edit/Close, modal Close button, ESC, click-
  // outside) through the panel's dirty-check, so we surface the
  // "Discard unsaved changes?" prompt instead of silently dropping
  // the user's in-progress edits.
  const editCloseRef = useRef<((after?: () => void) => void) | null>(null);
  function leaveEdit(after?: () => void) {
    if (editingKey && editCloseRef.current) {
      editCloseRef.current(after);
    } else {
      after?.();
    }
  }
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

  const dismissable = !!onClose;

  useEffect(() => {
    if (!dismissable) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        // Inline the dirty-check route so the handler always sees the
        // latest editingKey without re-running the effect on every
        // unrelated re-render.
        if (editingKey && editCloseRef.current) {
          editCloseRef.current(() => onClose?.());
        } else {
          onClose?.();
        }
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [dismissable, onClose, editingKey]);

  return (
    <div
      onMouseDown={
        dismissable
          ? (e) => {
              if (e.target === e.currentTarget) leaveEdit(() => onClose?.());
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
          User Settings
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
                const isMe = sessionContext?.userId === u.id;
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
                          <span>{u.name}</span>
                          {isMe && (
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 400,
                                color: "var(--text-muted)",
                              }}
                            >
                              (you)
                            </span>
                          )}
                          <RoleBadge role={u.role} />
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--text-muted)",
                            fontFamily: "'JetBrains Mono',monospace",
                            marginTop: 2,
                          }}
                        >
                          {summarizeUser(u, editorRooms)}
                        </div>
                      </div>
                      {(isMe || isOwner) && isFullUserView(u) && (
                        <button
                          onClick={() => {
                            const targetKey = u.name.toLowerCase();
                            if (isEditing) {
                              // Close the currently-open panel; the panel
                              // will gate on its own dirty check.
                              leaveEdit();
                            } else if (editingKey) {
                              // Switch from a different open editor to this
                              // row. Route through the open editor's
                              // dirty-check first, then expand the new row.
                              leaveEdit(() => setEditingKey(targetKey));
                            } else {
                              setEditingKey(targetKey);
                            }
                          }}
                          style={smallBtnStyle}
                        >
                          {isEditing ? "Close" : "Edit"}
                        </button>
                      )}
                    </div>
                    {isEditing && isFullUserView(u) && (
                      <UserEditPanel
                        user={u}
                        closeRef={editCloseRef}
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

        {isOwner ? <AccessPane /> : sessionContext && <MyDevicesPane />}

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
            <button
              onClick={() => leaveEdit(() => onClose?.())}
              style={cancelBtnStyle}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function sameRoomSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const id of a) if (!setB.has(id)) return false;
  return true;
}

function summarizeUser(
  u: UserView,
  rooms: { id: string; name: string }[],
): string {
  // Public-only view (e.g. a member's view of another user): no sensitive data
  // is present, so render nothing beyond the name + role badge already shown.
  if (!isFullUserView(u)) return "";
  const parts: string[] = [];
  const room = rooms.find((r) => r.id === u.defaultRoomId);
  parts.push(`default: ${room?.name ?? "first room"}`);
  parts.push(
    `${u.allowedRooms.length} room${u.allowedRooms.length === 1 ? "" : "s"} (${u.notifRooms.length} notification${u.notifRooms.length === 1 ? "" : "s"})`,
  );
  if (u.envFile) parts.push("env: configured");
  if (u.memberPrompt) parts.push("profile: set");
  return parts.join(" · ");
}

function UserEditPanel({
  user,
  onClose,
  onRenamed,
  onDeleted,
  closeRef,
}: {
  user: UserRecord;
  onClose: () => void;
  onRenamed?: (newName: string) => void;
  onDeleted?: () => void;
  // Parent (UserManagementModal) calls `closeRef.current(after?)` when it
  // wants to navigate away from the currently-edited user (switch to
  // another user, close the modal, ESC, click-outside). The panel decides
  // whether to gate on a "Discard unsaved changes?" confirmation. The
  // optional `after` runs once the close is committed — used by the
  // parent to chain "discard then switch to user Y" / "discard then
  // close the modal". Same pattern as TaskView's closeRef.
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { rooms, allRooms, sessionContext } = useAppState();
  // Owner-only fields (currently: allowedRooms). The server rejects
  // changes to those fields from non-owner sessions even on self-edit,
  // but we also hide the editor here so members don't see disabled
  // controls they can't use.
  const isOwner = sessionContext?.role === "owner";
  // Use the unfiltered global rooms list when available so the owner
  // can manage other users' access to rooms they've hidden from their
  // own view, and so the Notifications list reflects every room the
  // target user might actually see. Members fall back to their
  // projected `rooms` (which already match what they can see).
  const editorRooms = allRooms.length > 0 ? allRooms : rooms;
  const [name, setName] = useState(user.name);
  const [defaultRoomId, setDefaultRoomId] = useState<string | null>(
    user.defaultRoomId,
  );
  const [notifSetting, setNotifSetting] = useState<NotifRoomsSetting>(
    user.notifRooms,
  );
  const [allowedSetting, setAllowedSetting] = useState<string[]>(
    user.allowedRooms,
  );
  const [envFile, setEnvFile] = useState<string>(user.envFile ?? "");
  const [memberPrompt, setMemberPrompt] = useState<string>(
    user.memberPrompt ?? "",
  );
  // Live-avatars: visual identity for the user's ghost in the office
  // scene. Color is stored as #rrggbb (normalized at save time);
  // variant is one of GHOST_VARIANTS. Both default to the user record's
  // current value (which the server fills in with a hash-derived hue +
  // "classic" for legacy records on read).
  const [avatarColor, setAvatarColor] = useState<string>(user.avatarColor);
  const [avatarVariant, setAvatarVariant] = useState<GhostVariant>(
    user.avatarVariant,
  );
  const [validation, setValidation] = useState<ValidationStatus>({
    kind: "idle",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Discard-unsaved-changes confirmation. Set true by requestClose when
  // the form is dirty; cleared by either commit (Discard) or cancel.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Holds the parent-supplied "after" callback while the discard prompt
  // is visible — e.g. "switch to user Y" or "close the modal". Runs once
  // the user clicks Discard; cleared on Cancel.
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
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

  // notifSetting and allowedSetting are both strict string[] (no "all"
  // sentinel). Toggling adds or removes a roomId.
  function toggleRoomNotif(roomId: string) {
    const has = notifSetting.includes(roomId);
    setNotifSetting(
      has
        ? notifSetting.filter((id) => id !== roomId)
        : [...notifSetting, roomId],
    );
  }

  // When a room is removed from access, prune notifSetting and clear
  // defaultRoomId if it pointed at the removed room. The server applies
  // the same prune on save, but the client-side mirror keeps the form
  // state consistent mid-edit and avoids surfacing a default the user
  // can't reach in the merged Rooms section.
  function toggleRoomAllowed(roomId: string) {
    const has = allowedSetting.includes(roomId);
    const newAllowed = has
      ? allowedSetting.filter((id) => id !== roomId)
      : [...allowedSetting, roomId];
    setAllowedSetting(newAllowed);
    setNotifSetting(notifSetting.filter((id) => newAllowed.includes(id)));
    if (has && defaultRoomId === roomId) setDefaultRoomId(null);
  }

  function isDirty(): boolean {
    // Name is trim-saved (see handleSave), so compare trimmed to avoid
    // false-positive dirtiness on trailing whitespace the user can't see.
    if (name.trim() !== user.name) return true;
    if (defaultRoomId !== user.defaultRoomId) return true;
    if ((envFile.trim() || null) !== (user.envFile ?? null)) return true;
    if ((memberPrompt.trim() || null) !== (user.memberPrompt ?? null))
      return true;
    if (avatarColor !== user.avatarColor) return true;
    if (avatarVariant !== user.avatarVariant) return true;
    if (!sameRoomSet(notifSetting, user.notifRooms)) return true;
    if (!sameRoomSet(allowedSetting, user.allowedRooms)) return true;
    return false;
  }

  // Parent-driven close path. If the form is clean, runs onClose + after
  // immediately; if dirty, surfaces the "Discard unsaved changes?" prompt
  // and stashes `after` for the Discard handler to run on commit.
  function requestClose(after?: () => void) {
    if (isDirty()) {
      pendingDiscardActionRef.current = after ?? null;
      setConfirmDiscard(true);
    } else {
      onClose();
      after?.();
    }
  }

  function commitDiscard() {
    const next = pendingDiscardActionRef.current;
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
    onClose();
    next?.();
  }

  function cancelDiscard() {
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
  }

  // Mirror requestClose into the parent's ref every render so the captured
  // closure always sees fresh form state — same no-deps pattern TaskView
  // uses for its own dirty-check ref.
  useEffect(() => {
    if (closeRef) closeRef.current = requestClose;
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Save supersedes any in-flight discard prompt: the user picked Save
    // over Discard. Without this, a save failure leaves the prompt up
    // with a stale pending action (e.g. "close modal") that a later
    // Discard click would execute against the user's expectations.
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
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
      // Only owners can change allowedRooms (server enforces and the UI
      // hides the section). Omit the field for member self-edits so the
      // payload doesn't trip the server-side field-level gate.
      changes: {
        name: renamed ? trimmed : undefined,
        defaultRoomId,
        notifRooms: notifSetting,
        envFile: envFile.trim() || null,
        memberPrompt: memberPrompt.trim() || null,
        avatarColor: isHexColor(avatarColor)
          ? normalizeHexColor(avatarColor)
          : user.avatarColor,
        avatarVariant,
        ...(isOwner ? { allowedRooms: allowedSetting } : {}),
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
        {editorRooms
          .filter((r) => allowedSetting.includes(r.id))
          .map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
      </select>

      {isOwner ? (
        <>
          <label style={subLabelStyle}>
            Rooms{" "}
            <span style={hintStyle}>
              (Access: rooms this user can see and act in. Notifications: sound
              when an agent in that room finishes.)
            </span>
          </label>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-base)",
              padding: "4px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "4px 12px 6px",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--text-ghost)",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>Room</span>
              <span style={{ width: 90, textAlign: "center" }}>Access</span>
              <span style={{ width: 90, textAlign: "center" }}>
                Notifications
              </span>
            </div>
            {editorRooms.length === 0 ? (
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
              editorRooms.map((r) => {
                const hasAccess = allowedSetting.includes(r.id);
                const wantsNotif = hasAccess && notifSetting.includes(r.id);
                return (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "6px 12px",
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: hasAccess
                          ? "var(--text-primary)"
                          : "var(--text-ghost)",
                      }}
                    >
                      {r.name}
                    </span>
                    <span
                      style={{
                        width: 90,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={hasAccess}
                        onChange={() => toggleRoomAllowed(r.id)}
                        aria-label={`Access to ${r.name}`}
                        style={{
                          accentColor: "var(--accent)",
                          cursor: "pointer",
                        }}
                      />
                    </span>
                    <span
                      style={{
                        width: 90,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={wantsNotif}
                        disabled={!hasAccess}
                        onChange={() => {
                          // Defensive: also gate at the handler, not just
                          // via `disabled`, so a future refactor or stale
                          // click can't add notif for an inaccessible room.
                          if (!hasAccess) return;
                          toggleRoomNotif(r.id);
                        }}
                        aria-label={`Notifications for ${r.name}`}
                        style={{
                          accentColor: "var(--accent)",
                          cursor: hasAccess ? "pointer" : "default",
                          opacity: hasAccess ? 1 : 0.35,
                        }}
                      />
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>
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
            }}
          >
            {(() => {
              // Members only see rooms they can already reach. `editorRooms`
              // is the projected `rooms` slice for non-owner WSes, so the
              // filter is effectively a no-op but kept defensive.
              const notifRoomsToShow = editorRooms.filter((r) =>
                allowedSetting.includes(r.id),
              );
              if (notifRoomsToShow.length === 0) {
                return (
                  <div
                    style={{
                      padding: "8px 12px",
                      fontSize: 12,
                      color: "var(--text-ghost)",
                    }}
                  >
                    No rooms yet.
                  </div>
                );
              }
              return notifRoomsToShow.map((r) => {
                const checked = notifSetting.includes(r.id);
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
                      style={{
                        accentColor: "var(--accent)",
                        cursor: "pointer",
                      }}
                    />
                    <span>{r.name}</span>
                  </label>
                );
              });
            })()}
          </div>
        </>
      )}

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

      <label style={subLabelStyle}>
        Profile Prompt{" "}
        <span style={hintStyle}>
          (auto-injected into the system prompt of agents you own; other
          users&apos; agents can look it up if they need context on you)
        </span>
      </label>
      <textarea
        value={memberPrompt}
        onChange={(e) => setMemberPrompt(e.target.value)}
        placeholder="A few notes for agents about who you are, your role, how you like to collaborate…"
        rows={5}
        style={{
          ...inputStyle,
          minHeight: 90,
          resize: "vertical",
          fontFamily: "inherit",
          lineHeight: 1.45,
        }}
      />

      <label style={subLabelStyle}>
        Avatar{" "}
        <span style={hintStyle}>
          (your ghost in the office scene; other users see it next to the agent
          you&apos;re viewing)
        </span>
      </label>
      <AvatarPicker
        color={avatarColor}
        variant={avatarVariant}
        onColorChange={setAvatarColor}
        onVariantChange={setAvatarVariant}
      />

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

      {confirmDiscard && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 12,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-base)",
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
            Discard unsaved changes?
          </span>
          <button
            onClick={commitDiscard}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--red)",
              background: "var(--red)",
              color: "var(--bg-base)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Discard
          </button>
          <button
            onClick={cancelDiscard}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
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
          <button
            onClick={() => requestClose()}
            style={cancelBtnStyle}
            disabled={saving}
          >
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

// Live-avatars: picker for the user's ghost color + variant. 8 variant
// thumbnails (clickable) over a row of palette swatches plus a hex
// input for users who want a color outside the curated palette.
function AvatarPicker({
  color,
  variant,
  onColorChange,
  onVariantChange,
}: {
  color: string;
  variant: GhostVariant;
  onColorChange: (next: string) => void;
  onVariantChange: (next: GhostVariant) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 10,
        background: "var(--bg-base)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 6,
          marginBottom: 10,
        }}
      >
        {GHOST_VARIANTS.map((v) => {
          const selected = v === variant;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onVariantChange(v)}
              title={v}
              style={{
                background: selected ? "var(--bg-input)" : "transparent",
                border: `1px solid ${
                  selected ? "var(--accent)" : "var(--border)"
                }`,
                borderRadius: 6,
                padding: 6,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <GhostGraphic variant={v} color={color} size={44} />
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        {GHOST_COLOR_PALETTE.map((c) => {
          const selected =
            isHexColor(color) && normalizeHexColor(color) === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              onClick={() => onColorChange(c)}
              title={c}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                border: selected
                  ? "2px solid var(--accent)"
                  : "1px solid var(--border)",
                background: c,
                cursor: "pointer",
                padding: 0,
              }}
            />
          );
        })}
        <input
          value={color}
          onChange={(e) => onColorChange(e.target.value)}
          placeholder="#88d1f0"
          spellCheck={false}
          style={{
            ...inputStyle,
            width: 90,
            marginLeft: 6,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        />
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
          ? "Owner — can invite users, revoke sessions, and set per-user room access"
          : "Member — can act in rooms the owner allowed; can't invite or revoke"
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
