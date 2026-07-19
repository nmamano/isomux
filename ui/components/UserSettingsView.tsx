// Full-page User Settings (master-detail), replacing the old crowded modal
// (UserManagementModal). Entered and exited like the Tasks page: rendered in
// App's main view switch, closed via the header back arrow, ESC, or the
// browser back button (goHome → popstate).
//
// Layout: a sidebar (master) lists every user plus the account section
// (Access & invites for owners, My devices for members) with Sign out pinned
// at the bottom; the detail area shows the selected user's editor, organized
// into sections (Identity / Rooms / Agent context) with a sticky save footer.
// On mobile exactly one of the two panes shows at a time — the list first,
// then the detail with a back row.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
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

// What the detail pane shows: a user's editor, or the account section
// (Access & invites / My devices). null = nothing selected — on mobile that
// means the list is showing; on desktop the detail renders a placeholder.
// Keyed by the STABLE user id (not the lowercased-name map key), so a rename
// from this or another session never dangles the selection.
type Selection = { kind: "user"; id: string } | { kind: "account" };

export function UserSettingsView({
  initialUserId,
  onSwitchUser,
  onClose,
}: {
  // Live-avatars: when set, the page opens with this user's editor selected
  // (used by ghost click → settings shortcut). Read once on mount; updates to
  // this prop while the page is mounted do NOT re-sync the selection. The
  // parent (App.tsx) clears the value on close, so each reopen with a
  // different initialUserId mounts a fresh page and applies the new target.
  initialUserId?: string | null;
  onSwitchUser: (name: string | null) => void;
  onClose: () => void;
}) {
  const { users, isMobile, sessionContext } = useAppState();
  const isOwner = sessionContext?.role === "owner";
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  const [selection, setSelection] = useState<Selection | null>(() => {
    if (initialUserId) {
      // Only select ids that resolve to a record already in the store; if it
      // isn't there yet (rare race on first connect), fall through to the
      // default selection and let the hydration effect below catch up.
      for (const u of users.values()) {
        if (u.id === initialUserId) return { kind: "user", id: u.id };
      }
    }
    // Phones open on the list (master) so the page isn't a wall of fields;
    // desktop preselects the current user — editing your own settings is the
    // most common reason to open the page.
    if (isMobile) return null;
    if (sessionContext) {
      for (const u of users.values()) {
        if (u.id === sessionContext.userId) return { kind: "user", id: u.id };
      }
    }
    return null;
  });

  // The default selection (initialUserId, or self on desktop) can't resolve
  // if the page mounts before the users roster has hydrated (e.g. a view
  // restore racing the users_list broadcast). Apply it as soon as a roster
  // containing the target lands — but never after the user has made any
  // explicit navigation choice (select() and the mobile back-to-list both
  // consume the ref), so it can't override a selection the user has since
  // made or cleared. If a roster snapshot lacks the target (partial or
  // stale hydration), stay armed and retry on the next roster change
  // rather than permanently giving up.
  const defaultAppliedRef = useRef(
    selection !== null || (isMobile && !initialUserId),
  );
  useEffect(() => {
    if (defaultAppliedRef.current || users.size === 0) return;
    const targetId =
      initialUserId ?? (isMobile ? undefined : sessionContext?.userId);
    if (!targetId) {
      // No default to apply — stop watching.
      defaultAppliedRef.current = true;
      return;
    }
    for (const u of users.values()) {
      if (u.id === targetId) {
        defaultAppliedRef.current = true;
        // One-shot hydration catch-up — same setState-in-effect pattern as
        // App's view restore. Safe to bypass the dirty gate: the ref being
        // unconsumed means no explicit selection was ever made, so no
        // editor with unsaved state can be mounted.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelection({ kind: "user", id: u.id });
        return;
      }
    }
  }, [users, initialUserId, isMobile, sessionContext]);

  // Filled by the currently-mounted detail panel — UserEditPanel, or the
  // External access card inside AccessPane — whichever holds unsaved form
  // state. Lets us route every navigation away from it (sidebar click,
  // header back arrow, ESC, mobile back row) through the panel's
  // dirty-check, so we surface the "Discard unsaved changes?" prompt
  // instead of silently dropping in-progress edits.
  const detailCloseRef = useRef<((after?: () => void) => void) | null>(null);
  function leaveEdit(after?: () => void) {
    if (selection !== null && detailCloseRef.current) {
      detailCloseRef.current(after);
    } else {
      after?.();
    }
  }

  function select(next: Selection) {
    // Any explicit choice consumes the pending hydration default (above) so
    // a late-arriving roster can't override it.
    defaultAppliedRef.current = true;
    const same =
      selection !== null &&
      (next.kind === "account"
        ? selection.kind === "account"
        : selection.kind === "user" && selection.id === next.id);
    if (same) return;
    leaveEdit(() => setSelection(next));
  }

  // Mobile back-to-list. An explicit "show me the list" also consumes the
  // hydration default — otherwise the roster arriving later would bounce
  // the user straight back into a detail they just left.
  function backToList() {
    defaultAppliedRef.current = true;
    leaveEdit(() => setSelection(null));
  }

  // Holds the server's lockout-prevention reason if Sign out is refused.
  // Shown inline near the button until dismissed.
  const [logoutBlockedReason, setLogoutBlockedReason] = useState<string | null>(
    null,
  );

  // ESC: mobile detail → back to the list; otherwise leave the page. Both
  // routed through the dirty check. Capture + stopPropagation so App's own
  // Escape handler (goHome, which knows nothing of unsaved edits) never sees
  // it. No deps — re-registers every render so the closures stay fresh.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (isMobile && selection) {
        backToList();
      } else {
        leaveEdit(() => onClose());
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  const selectedUser =
    selection?.kind === "user"
      ? ([...users.values()].find((u) => u.id === selection.id) ?? null)
      : null;

  const canEdit = (u: UserView) =>
    (sessionContext?.userId === u.id || isOwner) && isFullUserView(u);

  const accountAvailable = isOwner || !!sessionContext;
  const accountLabel = isOwner ? "Access & invites" : "My devices";

  function signOut() {
    setLogoutBlockedReason(null);
    // DELETE /api/sessions/current revokes this session; the server core then
    // fans out session_expired and closes the socket, so the page reload lands
    // us on the login wall. A 409 means the lockout-prevention refused it
    // (last owner session); surface the reason inline.
    apiFetch("DELETE", "/api/sessions/current").catch((err) => {
      if (err instanceof ApiError && err.status === 409) {
        setLogoutBlockedReason(err.message);
      }
    });
  }

  const showSidebar = !isMobile || selection === null;
  const showDetail = !isMobile || selection !== null;

  return (
    <div
      style={{
        height: isMobile ? "100dvh" : "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* Header — same bar as the Tasks/Cronjobs pages. minHeight (not
          height) so the safe-area-inset-top padding extends the bar below
          the camera notch instead of being squashed into the 44px box. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <button
          onClick={() => leaveEdit(() => onClose())}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          &larr;
        </button>
        <span
          style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}
        >
          User Settings
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "'JetBrains Mono',monospace",
          }}
        >
          {userList.length} user{userList.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Body: sidebar (master) + detail. On mobile exactly one shows. */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {showSidebar && (
          <div
            style={{
              width: isMobile ? "100%" : 260,
              flexShrink: 0,
              borderRight: isMobile
                ? undefined
                : "1px solid var(--border-subtle)",
              overflowY: "auto",
              overscrollBehavior: "contain",
              display: "flex",
              flexDirection: "column",
              padding: "12px 0",
            }}
          >
            <div style={sidebarSectionLabel}>Users</div>
            {userList.map((u) => {
              const isMe = sessionContext?.userId === u.id;
              const selected =
                selection?.kind === "user" && selection.id === u.id;
              const editable = canEdit(u);
              const summary = summarizeUser(u);
              // Editable rows are real <button>s (keyboard-focusable, with
              // aria-current marking the selection); rows the session can't
              // edit render as plain non-interactive divs.
              const Row = editable ? "button" : "div";
              return (
                <Row
                  key={u.id}
                  onClick={
                    editable
                      ? () => select({ kind: "user", id: u.id })
                      : undefined
                  }
                  aria-current={selected ? "true" : undefined}
                  title={
                    editable
                      ? undefined
                      : "Only the user themselves and owners can edit a user"
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "left",
                    font: "inherit",
                    color: "inherit",
                    padding: "8px 14px",
                    border: "none",
                    cursor: editable ? "pointer" : "default",
                    background: selected ? "var(--bg-hover)" : "transparent",
                    borderLeft: selected
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    opacity: editable ? 1 : 0.55,
                  }}
                >
                  <GhostGraphic
                    variant={u.avatarVariant}
                    color={u.avatarColor}
                    size={22}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.name}
                      </span>
                      {isMe && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 400,
                            color: "var(--text-muted)",
                            flexShrink: 0,
                          }}
                        >
                          (you)
                        </span>
                      )}
                      <RoleBadge role={u.role} />
                    </div>
                    {summary && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text-muted)",
                          fontFamily: "'JetBrains Mono',monospace",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {summary}
                      </div>
                    )}
                  </div>
                </Row>
              );
            })}

            {accountAvailable && (
              <>
                <div style={{ ...sidebarSectionLabel, marginTop: 18 }}>
                  Account
                </div>
                <button
                  onClick={() => select({ kind: "account" })}
                  aria-current={
                    selection?.kind === "account" ? "true" : undefined
                  }
                  style={{
                    width: "100%",
                    textAlign: "left",
                    font: "inherit",
                    padding: "8px 14px 8px 22px",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    border: "none",
                    cursor: "pointer",
                    background:
                      selection?.kind === "account"
                        ? "var(--bg-hover)"
                        : "transparent",
                    borderLeft:
                      selection?.kind === "account"
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                  }}
                >
                  {accountLabel}
                </button>
              </>
            )}

            <div style={{ flex: 1 }} />

            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "16px 14px 10px",
                lineHeight: 1.4,
              }}
            >
              User profiles are stored on the server. Your notifications and
              credentials follow you across devices.
            </p>

            {sessionContext && (
              <div style={{ padding: "0 14px" }}>
                <button
                  onClick={signOut}
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
                    }}
                  >
                    {logoutBlockedReason}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {showDetail && (
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              overscrollBehavior: "contain",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {isMobile && selection && (
              <button
                onClick={backToList}
                style={{
                  alignSelf: "flex-start",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  cursor: "pointer",
                  padding: "10px 16px 4px",
                }}
              >
                &larr; All users
              </button>
            )}
            {selection?.kind === "account" ? (
              <div
                style={{
                  padding: isMobile ? "0 16px 24px" : "0 24px 24px",
                  maxWidth: 720,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                {isOwner ? (
                  // AccessPane's External access card holds unsaved form
                  // state; it registers into detailCloseRef so navigating
                  // away routes through its own discard prompt.
                  <AccessPane closeRef={detailCloseRef} />
                ) : sessionContext ? (
                  <MyDevicesPane />
                ) : null}
              </div>
            ) : selectedUser && isFullUserView(selectedUser) ? (
              <UserEditPanel
                key={selectedUser.id}
                user={selectedUser}
                isMobile={isMobile}
                closeRef={detailCloseRef}
                onClose={() => setSelection(null)}
                onRenamed={(newName) => {
                  // Selection is id-keyed, so a rename never dangles it.
                  // If the edited user is the current device's user and they
                  // renamed (case-changing too), keep localStorage in sync so
                  // the next claim_user doesn't fork a new empty record.
                  const localKey = getUsername()?.toLowerCase();
                  if (
                    localKey &&
                    localKey === selectedUser.name.toLowerCase()
                  ) {
                    saveLocalUsername(newName);
                    onSwitchUser(newName);
                  }
                }}
                onDeleted={() => {
                  // If the deleted user is the current device's user, clear
                  // localStorage so the picker auto-opens on the next render.
                  const localKey = getUsername()?.toLowerCase();
                  if (
                    localKey &&
                    localKey === selectedUser.name.toLowerCase()
                  ) {
                    saveLocalUsername("");
                    if (typeof localStorage !== "undefined")
                      localStorage.removeItem("isomux-username");
                    onSwitchUser(null);
                  }
                  setSelection(null);
                }}
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-ghost)",
                  fontSize: 13,
                }}
              >
                Select a user from the list
              </div>
            )}
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

function summarizeUser(u: UserView): string {
  // Public-only view (e.g. a member's view of another user): no sensitive data
  // is present, so render nothing beyond the name + role badge already shown.
  if (!isFullUserView(u)) return "";
  const parts: string[] = [];
  parts.push(
    `${u.allowedRooms.length} room${u.allowedRooms.length === 1 ? "" : "s"} (${u.notifRooms.length} notification${u.notifRooms.length === 1 ? "" : "s"})`,
  );
  if (u.envFile) parts.push("env: configured");
  if (u.memberPrompt) parts.push("profile: set");
  return parts.join(" · ");
}

function UserEditPanel({
  user,
  isMobile,
  onClose,
  onRenamed,
  onDeleted,
  closeRef,
}: {
  user: UserRecord;
  isMobile: boolean;
  onClose: () => void;
  onRenamed?: (newName: string) => void;
  onDeleted?: () => void;
  // Parent (UserSettingsView) calls `closeRef.current(after?)` when it wants
  // to navigate away from the currently-edited user (switch selection, close
  // the page, ESC, mobile back). The panel decides whether to gate on a
  // "Discard unsaved changes?" confirmation. The optional `after` runs once
  // the close is committed — used by the parent to chain "discard then select
  // Y" / "discard then close the page". Same pattern as TaskView's closeRef.
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { rooms, allRooms, sessionContext } = useAppState();
  // Owner-only fields (currently: allowedRooms). The server rejects
  // changes to those fields from non-owner sessions even on self-edit,
  // but we also hide the editor here so members don't see disabled
  // controls they can't use.
  const isOwner = sessionContext?.role === "owner";
  // Self-edit vs owner-editing-another. Option A (Nil-gated): Notifications are
  // SELF-only (view.*), so they render only when isMe; an owner editing a
  // member manages record fields + access, not their prefs.
  const isMe = sessionContext?.userId === user.id;
  // The TARGET's access is rule-based for owners (they reach every room without
  // materialized grants), literal allowedRooms for members. Drives the self-pref
  // rendering (Notifications) and whether a save writes grants.
  const targetIsOwner = user.role === "owner";
  // Use the unfiltered global rooms list when available so the owner
  // can manage other users' access to rooms they've hidden from their
  // own view, and so the Notifications list reflects every room the
  // target user might actually see. Members fall back to their
  // projected `rooms` (which already match what they can see).
  const editorRooms = allRooms.length > 0 ? allRooms : rooms;
  const [name, setName] = useState(user.name);
  const [notifSetting, setNotifSetting] = useState<NotifRoomsSetting>(
    user.notifRooms,
  );
  const [allowedSetting, setAllowedSetting] = useState<string[]>(
    user.allowedRooms,
  );
  // The room ids the TARGET can reach, for rendering their self prefs: an owner
  // reaches every live room by rule; a member only their (editable) allowedSetting.
  // Without this an owner self-editing sees disabled notification toggles (their
  // allowedRooms is [] by rule).
  const accessibleForPrefs = targetIsOwner
    ? editorRooms.map((r) => r.id)
    : allowedSetting;
  const [envFile, setEnvFile] = useState<string>(user.envFile ?? "");
  const [memberPrompt, setMemberPrompt] = useState<string>(
    user.memberPrompt ?? "",
  );
  // Boss-scoped memory for this user, edited via the unified /api/memory verbs
  // (load + version-guarded save), keyed by the stable userId so it survives a
  // rename. Saved separately from the user PATCH.
  const mem = useMemoryEditor("boss", user.id, true);
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
  // is visible — e.g. "select user Y" or "close the page". Runs once
  // the user clicks Discard; cleared on Cancel.
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  // Holds the server's lockout-prevention reason if delete_user is refused.
  // Same shape as the logout_blocked / revoke_blocked surfaces elsewhere —
  // shown inline next to Delete so the boss sees why the row didn't go.
  const [deleteBlockedReason, setDeleteBlockedReason] = useState<string | null>(
    null,
  );
  // Marks a delete as in-flight so the button can't double-submit. Kept in a
  // ref (no re-render needed); REST gives a definitive 204/4xx so there is no
  // longer a raw listener to correlate.
  const pendingDeleteReqRef = useRef<boolean>(false);

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (pendingDeleteReqRef.current) return;
    pendingDeleteReqRef.current = true;
    setDeleteBlockedReason(null);
    // DELETE is definitive: a 204 means the server removed the record, evicted
    // the target's sessions, and fanned out users_list, so resolve directly. A
    // 403 (owner!=self) / 409 (last-owner lockout) carries the reason the
    // retired delete_user_blocked used to surface.
    apiFetch("DELETE", `/api/users/${encodeURIComponent(user.name)}`)
      .then(() => {
        pendingDeleteReqRef.current = false;
        onDeleted?.();
      })
      .catch((err) => {
        pendingDeleteReqRef.current = false;
        setDeleteBlockedReason(
          err instanceof ApiError ? err.message : "Delete failed",
        );
        setConfirmDelete(false);
      });
  }

  // Validate the stored envFile on open.
  useEffect(() => {
    if (!user.envFile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValidation({ kind: "idle" });
      return;
    }
    setValidation({ kind: "pending" });
    let cancelled = false;
    apiFetch<{ ok: boolean; keyCount?: number; error?: string }>(
      "POST",
      "/api/validate/env",
      { scope: "user", username: user.name },
    )
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setValidation({ kind: "ok", keyCount: r.keyCount });
        else
          setValidation({
            kind: "error",
            message: r.error || "Invalid env file",
          });
      })
      .catch((e) => {
        if (cancelled) return;
        setValidation({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Invalid env file",
        });
      });
    return () => {
      cancelled = true;
    };
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

  // When a room is removed from access, prune notifSetting to fit. The server
  // applies the same prune on save, but the client-side mirror keeps the form
  // state consistent mid-edit.
  function toggleRoomAllowed(roomId: string) {
    const has = allowedSetting.includes(roomId);
    const newAllowed = has
      ? allowedSetting.filter((id) => id !== roomId)
      : [...allowedSetting, roomId];
    setAllowedSetting(newAllowed);
    setNotifSetting(notifSetting.filter((id) => newAllowed.includes(id)));
  }

  function isDirty(): boolean {
    // Name is trim-saved (see handleSave), so compare trimmed to avoid
    // false-positive dirtiness on trailing whitespace the user can't see.
    if (name.trim() !== user.name) return true;
    if ((envFile.trim() || null) !== (user.envFile ?? null)) return true;
    if ((memberPrompt.trim() || null) !== (user.memberPrompt ?? null))
      return true;
    if (mem.dirty) return true;
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

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Save supersedes any in-flight discard prompt: the user picked Save
    // over Discard. Without this, a save failure leaves the prompt up
    // with a stale pending action (e.g. "close the page") that a later
    // Discard click would execute against the user's expectations.
    pendingDiscardActionRef.current = null;
    setConfirmDiscard(false);
    setSaving(true);
    setError(null);
    const renamed = trimmed !== user.name;
    const origName = user.name; // URL target BEFORE any rename takes effect
    const normalizedColor = isHexColor(avatarColor)
      ? normalizeHexColor(avatarColor)
      : user.avatarColor;
    const memoryChanged = mem.dirty;
    const recordChanged =
      renamed ||
      (envFile.trim() || null) !== (user.envFile ?? null) ||
      (memberPrompt.trim() || null) !== (user.memberPrompt ?? null) ||
      normalizedColor !== user.avatarColor ||
      avatarVariant !== user.avatarVariant;
    try {
      // The update_user SPLIT (Option A), sequenced to preserve the WS atomicity
      // guarantees and dodge the rename->404. (1) Owner access change FIRST,
      // against the ORIGINAL username, so a combined rename + grant doesn't 404
      // the access PUT after the record renames; setAccess prune-clamps the
      // target's notif/default server-side in one write.
      if (
        isOwner &&
        !targetIsOwner &&
        !sameRoomSet(allowedSetting, user.allowedRooms)
      ) {
        // Owners are rule-based (no materialized grants), so an owner target
        // never writes allowedRooms — only a member's access is editable here.
        await apiFetch(
          "PUT",
          `/api/users/${encodeURIComponent(origName)}/access`,
          { allowedRooms: allowedSetting },
        );
      }
      // (2) Record fields (name/env/prompt/avatar), against the original name.
      if (recordChanged) {
        await apiFetch("PATCH", `/api/users/${encodeURIComponent(origName)}`, {
          name: renamed ? trimmed : undefined,
          envFile: envFile.trim() || null,
          memberPrompt: memberPrompt.trim() || null,
          avatarColor: normalizedColor,
          avatarVariant,
        });
      }
      // (2b) Boss memory is a separate version-guarded REPLACE keyed by the stable
      // userId (rename-safe). A 409 means it changed under us — surface + keep open.
      if (memoryChanged) {
        const m = await mem.save();
        if (!m.ok) {
          setError(m.message);
          return;
        }
      }
      // (3) View prefs are SELF-only (Option A: the fields render only for isMe).
      // notif-rooms takes the full list.
      if (isMe && !sameRoomSet(notifSetting, user.notifRooms)) {
        await apiFetch("PUT", "/api/me/view/notif-rooms", {
          notifRooms: notifSetting,
        });
      }
      if (renamed) onRenamed?.(trimmed);
      // Unlike the old modal (which collapsed the editor on save), the page
      // stays on the saved user. Sync local fields to exactly what was saved
      // so the form reads clean once the broadcast refreshes the record —
      // including normalizations the server applies (trim, hex color).
      setName(trimmed);
      setEnvFile(envFile.trim());
      setMemberPrompt(memberPrompt.trim());
      setAvatarColor(normalizedColor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const contentPad = isMobile ? "0 16px" : "0 24px";

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: contentPad,
          maxWidth: 720,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        {/* Detail heading: who is being edited. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: "18px 0 2px",
          }}
        >
          <GhostGraphic
            variant={user.avatarVariant}
            color={user.avatarColor}
            size={26}
          />
          <h4
            style={{
              fontSize: 15,
              fontWeight: 700,
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            {user.name}
          </h4>
          <RoleBadge role={user.role} />
          {isMe && (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              (you)
            </span>
          )}
        </div>

        <h5 style={sectionTitleStyle}>Identity</h5>
        <label style={subLabelStyle}>Display Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 32))}
          maxLength={32}
          style={{ ...inputStyle, maxWidth: 340 }}
        />

        <label style={subLabelStyle}>
          Avatar{" "}
          <span style={hintStyle}>
            (your ghost in the office scene; other users see it next to the
            agent you&apos;re viewing)
          </span>
        </label>
        <AvatarPicker
          color={avatarColor}
          variant={avatarVariant}
          onColorChange={setAvatarColor}
          onVariantChange={setAvatarVariant}
        />

        {isOwner && (!targetIsOwner || isMe) ? (
          <>
            <h5 style={sectionTitleStyle}>Rooms</h5>
            <p style={sectionHintStyle}>
              {!targetIsOwner && "Access: rooms this user can see and act in. "}
              {isMe &&
                "Notifications: sound when an agent in that room finishes."}
            </p>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-base)",
                padding: "4px 0",
                marginTop: 8,
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
                {!targetIsOwner && (
                  <span style={{ width: 90, textAlign: "center" }}>Access</span>
                )}
                {isMe && (
                  <span style={{ width: 90, textAlign: "center" }}>
                    Notifications
                  </span>
                )}
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
                  const hasAccess = accessibleForPrefs.includes(r.id);
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
                      {!targetIsOwner && (
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
                      )}
                      {isMe && (
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
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : !isOwner ? (
          <>
            <h5 style={sectionTitleStyle}>Notifications</h5>
            <p style={sectionHintStyle}>
              Sound when an agent in these rooms finishes.
            </p>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-base)",
                padding: "4px 0",
                marginTop: 8,
              }}
            >
              {(() => {
                // Members only see rooms they can already reach. `editorRooms`
                // is the projected `rooms` slice for non-owner WSes, so the
                // filter is effectively a no-op but kept defensive.
                const notifRoomsToShow = editorRooms.filter((r) =>
                  accessibleForPrefs.includes(r.id),
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
        ) : null}

        <h5 style={sectionTitleStyle}>Agent Context</h5>
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
          Memory{" "}
          <span style={hintStyle}>
            (durable boss-scoped facts for this user; rewrites the file exactly
            as shown — one memory per line, keep existing author/date text
            unless you mean to change it)
          </span>
        </label>
        <textarea
          value={mem.memory}
          onChange={(e) => mem.setMemory(e.target.value)}
          placeholder={
            mem.loaded ? "Some memory relevant to this user" : "Loading memory…"
          }
          rows={8}
          readOnly={!mem.loaded}
          style={{
            ...inputStyle,
            minHeight: 144,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.45,
          }}
        />
      </div>

      {/* Sticky action footer: always visible however long the form is. The
          inline error / blocked-reason / discard surfaces live here too, so
          they can't appear off-screen when triggered from the footer. */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: "auto",
          background: "var(--bg-base)",
          borderTop: "1px solid var(--border-subtle)",
          padding: isMobile
            ? "10px 16px calc(10px + env(safe-area-inset-bottom, 0px))"
            : "10px 24px",
        }}
      >
        <div style={{ maxWidth: 720 - 48 }}>
          {error && (
            <p style={{ fontSize: 10, color: "#ff6b6b", margin: "0 0 8px" }}>
              {error}
            </p>
          )}

          {deleteBlockedReason && (
            <p
              style={{
                margin: "0 0 8px",
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
                marginBottom: 8,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-input)",
              }}
            >
              <span
                style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}
              >
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
                onClick={() => void handleSave()}
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
        flexShrink: 0,
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

const sidebarSectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-ghost)",
  padding: "0 14px",
  marginBottom: 6,
};
// Section headers inside the user editor: a titled rule that groups the
// fields the old modal ran together in one long column.
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  margin: "24px 0 0",
  paddingBottom: 5,
  borderBottom: "1px solid var(--border-subtle)",
};
const sectionHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-ghost)",
  margin: "6px 0 0",
  lineHeight: 1.4,
};
const subLabelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 12 };
const hintStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
