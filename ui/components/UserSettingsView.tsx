// The full-page Settings surface (master-detail), replacing the old crowded modal
// (UserManagementModal). Entered and exited like the Tasks page: rendered in
// App's main view switch, closed via the header back arrow, ESC, or the
// browser back button (goHome → popstate).
//
// Layout: a sidebar (master) shows the account section (Access / Invites /
// Sessions for owners, My devices for members) ABOVE the user list - so the
// entries stay reachable however long the roster grows - with Sign out pinned
// at the bottom; the detail area shows the selected user's editor,
// organized into sections (Identity / Rooms / Agent context) with a sticky
// save footer. On mobile exactly one of the two panes shows at a time - the
// list first, then the detail with a back row.
//
// The user rows double as a roster: a green dot on the
// avatar for users with a live connection (store.onlineUserIds, an
// all-audience presence aggregate), plus - for OWNER viewers only - a
// session count / last-seen summary derived from the active-sessions list.
// Non-owner viewers get only the dot and a bare "online".

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
import { DevicePane } from "./DevicePane.tsx";
import { OfficePane } from "./OfficePane.tsx";
import { StoragePane } from "./StoragePane.tsx";
import { UsagePane } from "./UsagePane.tsx";
import { RoomPane } from "./RoomPane.tsx";
import { ThemePane } from "./ThemePane.tsx";
import { UpdatePane } from "./UpdatePane.tsx";
import { ExternalAccessPane } from "./ExternalAccessPane.tsx";
import { InvitesPane } from "./InvitesPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { MyDevicesPane } from "./MyDevicesPane.tsx";
import { PreferencesPane } from "./PreferencesPane.tsx";
import { ApiTokensPane } from "./ApiTokensPane.tsx";
import { ConnectionsPane } from "./ConnectionsPane.tsx";
import {
  ExpandableTextarea,
  isExpandedEditorOpen,
} from "./ExpandableTextarea.tsx";
import { useAccessListsSeed, formatRelative } from "./access-shared.tsx";

// Sections that render INSIDE this page. The sidebar also carries rows that
// still open a dialog (office, room, device label, theme, updates); those are
// not sections because nothing of theirs mounts in the detail pane yet.
//
// "signInLinks" is the pane formerly labelled "My devices": it holds invite
// links and sessions for signing in elsewhere, not devices, and the label now
// says so. "connections" split in two because one pane held both the office's
// sign-ins and variables and the caller's own.
export type SettingsSection =
  | "office"
  | "storage"
  | "usage"
  | "access"
  | "invites"
  | "sessions"
  | "connectionsOffice"
  | "prefs"
  | "connectionsPersonal"
  | "apiTokens"
  | "signInLinks"
  | "updates"
  | "deviceLabel"
  | "theme";

// One sidebar entry. A row either moves the detail pane to `target`, or opens
// a dialog through `open` - never both. The row holds the target as DATA
// rather than a closure over select(), because select() routes through the
// unsaved-changes guard and must not be captured during render.
type SidebarRow = {
  key: string;
  label: string;
  selected: boolean;
  target?: Selection;
  open?: () => void;
};

// A labelled group of sidebar entries. The Members group carries no rows: it
// renders the live roster instead, which needs per-user avatars and status.
type SidebarGroup = {
  id: string;
  label: string;
  rows: SidebarRow[];
  roster?: boolean;
};

// What the detail pane shows: a user's editor, or one settings section.
// null = nothing selected - on mobile that means the list is showing; on
// desktop the detail renders a placeholder. User selections are keyed by the
// STABLE user id (not the lowercased-name map key), so a rename from this or
// another session never dangles the selection.
// Structural equality over the three arms. Re-selecting the row you are
// already on must be a no-op, or it would run the unsaved-changes prompt
// against a pane you never left.
function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "section" && b.kind === "section")
    return a.section === b.section;
  if (a.kind === "user" && b.kind === "user") return a.id === b.id;
  if (a.kind === "room" && b.kind === "room") return a.roomId === b.roomId;
  return false;
}

export type Selection =
  | { kind: "user"; id: string }
  | { kind: "section"; section: SettingsSection }
  // Rooms are not a fixed set, so a room cannot be a section name. It carries
  // its id instead, which is also how the room-tab double-click points here.
  | { kind: "room"; roomId: string };

export function UserSettingsView({
  initialUserId,
  onSwitchUser,
  onClose,
  initialTarget,
}: {
  // Live-avatars: when set, the page opens with this user's editor selected
  // (used by ghost click → settings shortcut). Read once on mount; updates to
  // this prop while the page is mounted do NOT re-sync the selection. The
  // parent (App.tsx) clears the value on close, so each reopen with a
  // different initialUserId mounts a fresh page and applies the new target.
  initialUserId?: string | null;
  // Which sidebar row to open on. Every door into this page carries its own
  // target - the update pill lands on Updates, the bar's Theme button on
  // Theme, a room tab on that room - so the page never has to guess where the
  // reader meant to go. Read once on mount, like initialUserId.
  initialTarget?: Selection | null;
  onSwitchUser: (name: string | null) => void;
  onClose: () => void;
}) {
  const {
    users,
    rooms,
    isMobile,
    sessionContext,
    onlineUserIds,
    activeSessions,
  } = useAppState();
  const isOwner = sessionContext?.role === "owner";
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  // Roster signals. Seed the invites + sessions lists here
  // (not just in the account panes): the owner sidebar's per-user session
  // count / last-seen needs sessions data even when no account pane is open.
  // For members the seed only feeds the My devices pane - their roster rows
  // never render session stats (owner-only signal).
  useAccessListsSeed();
  const onlineSet = useMemo(() => new Set(onlineUserIds), [onlineUserIds]);
  // Per-user aggregate over the active auth sessions, keyed by the STABLE
  // userId (SessionWire.userId) so a rename or casing change can never split
  // one user's sessions across rows. lastSeenAt is the max across the user's
  // sessions - the "last login/activity" answer for offline users.
  const sessionStats = useMemo(() => {
    const stats = new Map<string, { count: number; lastSeenAt: number }>();
    for (const s of activeSessions) {
      const cur = stats.get(s.userId);
      if (cur) {
        cur.count += 1;
        if (s.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = s.lastSeenAt;
      } else {
        stats.set(s.userId, { count: 1, lastSeenAt: s.lastSeenAt });
      }
    }
    return stats;
  }, [activeSessions]);

  const [selection, setSelection] = useState<Selection | null>(() => {
    // An explicit target beats everything else: the caller named the row.
    if (initialTarget) return initialTarget;
    if (initialUserId) {
      // Only select ids that resolve to a record already in the store; if it
      // isn't there yet (rare race on first connect), fall through to the
      // default selection and let the hydration effect below catch up.
      for (const u of users.values()) {
        if (u.id === initialUserId) return { kind: "user", id: u.id };
      }
    }
    // Phones open on the list (master) so the page isn't a wall of fields;
    // desktop preselects the current user - editing your own settings is the
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
  // containing the target lands - but never after the user has made any
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
      // No default to apply - stop watching.
      defaultAppliedRef.current = true;
      return;
    }
    for (const u of users.values()) {
      if (u.id === targetId) {
        defaultAppliedRef.current = true;
        // One-shot hydration catch-up - same setState-in-effect pattern as
        // App's view restore. Safe to bypass the dirty gate: the ref being
        // unconsumed means no explicit selection was ever made, so no
        // editor with unsaved state can be mounted.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelection({ kind: "user", id: u.id });
        return;
      }
    }
  }, [users, initialUserId, isMobile, sessionContext]);

  // Filled by the currently-mounted detail panel - UserEditPanel, or the
  // External access card inside ExternalAccessPane - whichever holds unsaved
  // form state. Lets us route every navigation away from it (sidebar click,
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
    const same = selection !== null && sameSelection(selection, next);
    if (same) return;
    leaveEdit(() => setSelection(next));
  }

  // Mobile back-to-list. An explicit "show me the list" also consumes the
  // hydration default - otherwise the roster arriving later would bounce
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
  // it. No deps - re-registers every render so the closures stay fresh.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // An expanded editor collapses on Escape instead of navigating this
      // page; our capture listener runs first, so stand down for it.
      if (isExpandedEditorOpen()) return;
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

  // The sidebar is grouped by WHO owns the setting. Isomux has five owners -
  // the office, a room, an agent, a member, this device - and every setting
  // belongs to exactly one of them. Agents get no group on purpose: you reach
  // an agent by clicking it in the scene, its form doubles as the spawn form,
  // and the list would churn hourly. The office and the rooms have no other
  // door, which is what earns them one.
  //
  // A row either selects a section that renders in the detail pane, or opens a
  // dialog that still layers over this page. The dialog rows are permanent;
  // only their onClick changes when their pane lands.
  const sectionRow = (section: SettingsSection, label: string): SidebarRow => ({
    key: section,
    label,
    selected: selection?.kind === "section" && selection.section === section,
    target: { kind: "section", section },
  });

  const selfUserId = sessionContext?.userId ?? null;
  const sidebarGroups: SidebarGroup[] = accountAvailable
    ? [
        {
          id: "office",
          label: "Office",
          rows: [
            sectionRow("office", "Office"),
            ...(isOwner
              ? [
                  sectionRow("access", "Access"),
                  sectionRow("invites", "Invites"),
                  sectionRow("sessions", "Sessions"),
                ]
              : []),
            sectionRow("connectionsOffice", "Connections"),
            sectionRow("usage", "Usage"),
            // Storage is owner-only, matching the server: prune is gated on
            // officeOwner and the usage read strips paths for anyone else.
            ...(isOwner ? [sectionRow("storage", "Storage")] : []),
            sectionRow("updates", "Updates"),
          ],
        },
        {
          id: "rooms",
          label: "Rooms",
          rows: rooms.map((room) => ({
            key: `room:${room.id}`,
            label: room.name,
            selected:
              selection?.kind === "room" && selection.roomId === room.id,
            target: { kind: "room" as const, roomId: room.id },
          })),
        },
        { id: "members", label: "Members", rows: [], roster: true },
        {
          id: "you",
          label: "You",
          rows: [
            // Your own profile used to be reachable only by finding yourself
            // in the roster below. It is the same editor; this row just gives
            // it the door it should always have had.
            ...(selfUserId
              ? [
                  {
                    key: "profile",
                    label: "Profile",
                    selected:
                      selection?.kind === "user" && selection.id === selfUserId,
                    target: { kind: "user" as const, id: selfUserId },
                  },
                ]
              : []),
            sectionRow("prefs", "Preferences"),
            sectionRow("connectionsPersonal", "Connections"),
            sectionRow("apiTokens", "API tokens"),
            sectionRow("signInLinks", "Sign-in links"),
          ],
        },
        {
          id: "device",
          label: "Device",
          rows: [
            sectionRow("deviceLabel", "Device label"),
            sectionRow("theme", "Theme"),
          ],
        },
      ]
    : [];

  // The roster splits the sidebar in two. Slicing on it keeps group ORDER in
  // sidebarGroups alone, so adding or moving a group never means editing the
  // JSX below.
  const rosterIndex = sidebarGroups.findIndex((group) => group.roster);
  const groupsBeforeRoster =
    rosterIndex === -1 ? [] : sidebarGroups.slice(0, rosterIndex);
  const groupsAfterRoster =
    rosterIndex === -1 ? [] : sidebarGroups.slice(rosterIndex + 1);
  const rosterGroup = rosterIndex === -1 ? null : sidebarGroups[rosterIndex];

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
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* Header - same bar as the Tasks/Cronjobs pages. minHeight (not
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
          Settings
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
            {/* Groups render in the order of sidebarGroups. The roster group
                is rendered in place rather than as rows, so the ordering
                lives in that one array and not here. */}
            {groupsBeforeRoster.map((group, i) => (
              <SidebarGroupRows
                key={group.id}
                group={group}
                first={i === 0}
                onSelect={(target) => select(target)}
              />
            ))}

            <div
              style={{
                ...sidebarSectionLabel,
                marginTop: groupsBeforeRoster.length > 0 ? 18 : 0,
              }}
            >
              {rosterGroup?.label ?? "Members"}
            </div>
            {userList.map((u) => {
              const isMe = sessionContext?.userId === u.id;
              const selected =
                selection?.kind === "user" && selection.id === u.id;
              const editable = canEdit(u);
              const online = onlineSet.has(u.id);
              // Session count / last-seen are OWNER-only signals (task
              // 8e882cd4); non-owner viewers get just the online dot and a
              // bare "online". The server already scopes /api/sessions to the
              // caller, but the design keeps even a member's own session
              // stats off the roster for consistency.
              const summary = summarizeRoster(
                online,
                isOwner ? (sessionStats.get(u.id) ?? null) : null,
              );
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
                  <span
                    style={{
                      position: "relative",
                      display: "flex",
                      flexShrink: 0,
                    }}
                  >
                    <GhostGraphic
                      variant={u.avatarVariant}
                      color={u.avatarColor}
                      size={22}
                    />
                    {online && (
                      <span style={onlineDotStyle} title="Online now" />
                    )}
                  </span>
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

            {groupsAfterRoster.map((group) => (
              <SidebarGroupRows
                key={group.id}
                group={group}
                first={false}
                onSelect={(target) => select(target)}
              />
            ))}

            <div style={{ flex: 1 }} />

            <p
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
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
                &larr; Settings
              </button>
            )}
            {selection?.kind === "section" ? (
              <div
                style={{
                  padding: isMobile ? "0 16px 24px" : "0 24px 24px",
                  maxWidth: 720,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                {/* Owner-only sections render null for members (unreachable
                    via the sidebar, which only offers "devices" to them). The
                    External access card holds unsaved form state; it registers
                    into detailCloseRef so navigating away routes through its
                    own discard prompt. */}
                {selection.section === "access" && isOwner ? (
                  <ExternalAccessPane closeRef={detailCloseRef} />
                ) : selection.section === "invites" && isOwner ? (
                  <InvitesPane />
                ) : selection.section === "sessions" && isOwner ? (
                  <SessionsPane />
                ) : selection.section === "signInLinks" && sessionContext ? (
                  <MyDevicesPane />
                ) : selection.section === "prefs" && sessionContext ? (
                  <PreferencesPane />
                ) : selection.section === "connectionsOffice" && sessionContext ? (
                  <ConnectionsPane
                    half="office"
                    username={sessionContext.username}
                    role={sessionContext.role}
                    onGoToOtherHalf={() =>
                      select({ kind: "section", section: "connectionsPersonal" })
                    }
                  />
                ) : selection.section === "connectionsPersonal" &&
                  sessionContext ? (
                  <ConnectionsPane
                    half="personal"
                    username={sessionContext.username}
                    role={sessionContext.role}
                    onGoToOtherHalf={() =>
                      select({ kind: "section", section: "connectionsOffice" })
                    }
                  />
                ) : selection.section === "office" ? (
                  <OfficePane closeRef={detailCloseRef} />
                ) : selection.section === "usage" ? (
                  <UsagePane />
                ) : selection.section === "storage" && isOwner ? (
                  <StoragePane closeRef={detailCloseRef} />
                ) : selection.section === "updates" ? (
                  <UpdatePane onClose={() => leaveEdit(() => onClose())} />
                ) : selection.section === "deviceLabel" ? (
                  <DevicePane closeRef={detailCloseRef} />
                ) : selection.section === "theme" ? (
                  <ThemePane />
                ) : selection.section === "apiTokens" && sessionContext ? (
                  <ApiTokensPane />
                ) : null}
              </div>
            ) : selection?.kind === "room" ? (
              <div
                style={{
                  padding: isMobile ? "0 16px 24px" : "0 24px 24px",
                  maxWidth: 720,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <RoomPane
                  key={selection.roomId}
                  roomId={selection.roomId}
                  closeRef={detailCloseRef}
                  onDeleted={() => setSelection(null)}
                />
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
                Select a setting from the list
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

// One-line roster summary under the user's name. Replaces the
// old rooms/env/profile line, which truncated into invisibility and answered
// nothing anyone asked; this one answers "are they here, and if not, when
// were they last?". Kept short enough to never ellipsize at sidebar width.
// `stats` is non-null only for OWNER viewers (session count / last-seen are
// owner-only signals); everyone else gets a bare "online" or, when offline,
// no line at all - same as the old public-view behavior.
function summarizeRoster(
  online: boolean,
  stats: { count: number; lastSeenAt: number } | null,
): string {
  if (online) {
    if (!stats) return "online";
    return `online · ${stats.count} session${stats.count === 1 ? "" : "s"}`;
  }
  if (!stats) return "";
  return `last seen ${formatRelative(stats.lastSeenAt)}`;
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
  // the close is committed - used by the parent to chain "discard then select
  // Y" / "discard then close the page". Same pattern as TaskView's closeRef.
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
}) {
  const { rooms, allRooms, sessionContext } = useAppState();
  // Owner-only fields (currently: allowedRooms). The server rejects
  // changes to those fields from non-owner sessions even on self-edit,
  // but we also hide the editor here so members don't see disabled
  // controls they can't use.
  const isOwner = sessionContext?.role === "owner";
  // Self-edit vs owner-editing-another. Notifications are
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
  // Per-user DISPLAY preference: room ids the user has hidden
  // from their own view. SELF-only, like notifications - an owner editing a
  // member manages access, not their view. Saved as the complement (the
  // "shown" list) via PUT /api/me/view/shown. The three room settings are
  // hierarchical: ACCESS ⊇ DISPLAYED ⊇ NOTIFICATIONS.
  const [hiddenSetting, setHiddenSetting] = useState<string[]>(user.hidden);
  // The room ids the TARGET can reach, for rendering their self prefs: an owner
  // reaches every live room by rule; a member SELF-editing reads their LIVE
  // record (user.allowedRooms - they have no Access column, and the record
  // refreshes via user_self_updated if an owner grants mid-edit); an owner
  // editing a member uses the editable allowedSetting. Without
  // the owner rule an owner self-editing sees disabled notification toggles
  // (their allowedRooms is [] by rule).
  const accessibleForPrefs = targetIsOwner
    ? editorRooms.map((r) => r.id)
    : !isOwner && isMe
      ? user.allowedRooms
      : allowedSetting;
  // A MEMBER's projected `rooms` exclude the rooms they've hidden, so the
  // Displayed column could never offer re-showing one. GET /api/me/rooms
  // returns id+name for every ACCESSIBLE room (hidden included) - fetched for
  // member self-edit and REFETCHED whenever their access set changes (an
  // owner granting/revoking a room while this panel is mounted lands as a
  // user_self_updated refresh of user.allowedRooms), so the rows can't go
  // permanently stale. Owners already hold the live allRooms.
  const [meRooms, setMeRooms] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const accessKey = [...user.allowedRooms].sort().join(",");
  useEffect(() => {
    if (isOwner || !isMe) return;
    apiFetch<{ rooms: { id: string; name: string }[] }>("GET", "/api/me/rooms")
      .then((r) => setMeRooms(r.rooms))
      .catch(() => {});
  }, [isOwner, isMe, accessKey]);
  // Rows of the Rooms table - RENDERING only; the destructive shown-complement
  // written on save is computed from a fresh /api/me/rooms read in handleSave,
  // never from these rows. Owner viewers: the unfiltered global list (they
  // manage access to every room). Member self-edit: the fetched accessible
  // list, falling back to the projected rooms until it lands.
  const rowsForPrefs: { id: string; name: string }[] =
    !isOwner && isMe ? (meRooms ?? editorRooms) : editorRooms;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Discard-unsaved-changes confirmation. Set true by requestClose when
  // the form is dirty; cleared by either commit (Discard) or cancel.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Holds the parent-supplied "after" callback while the discard prompt
  // is visible - e.g. "select user Y" or "close the page". Runs once
  // the user clicks Discard; cleared on Cancel.
  const pendingDiscardActionRef = useRef<(() => void) | null>(null);
  // Holds the server's lockout-prevention reason if delete_user is refused.
  // Same shape as the logout_blocked / revoke_blocked surfaces elsewhere -
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

  // Hiding a room prunes its notification (NOTIFICATIONS ⊆ DISPLAYED). The
  // server applies the same clamp on save (clampViewFields); the client-side
  // mirror keeps the form state consistent mid-edit.
  function toggleRoomDisplayed(roomId: string) {
    const wasHidden = hiddenSetting.includes(roomId);
    setHiddenSetting(
      wasHidden
        ? hiddenSetting.filter((id) => id !== roomId)
        : [...hiddenSetting, roomId],
    );
    if (!wasHidden) {
      setNotifSetting(notifSetting.filter((id) => id !== roomId));
    }
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
    if ((memberPrompt.trim() || null) !== (user.memberPrompt ?? null))
      return true;
    if (mem.dirty) return true;
    if (avatarColor !== user.avatarColor) return true;
    if (avatarVariant !== user.avatarVariant) return true;
    if (!sameRoomSet(notifSetting, user.notifRooms)) return true;
    if (!sameRoomSet(allowedSetting, user.allowedRooms)) return true;
    if (isMe && !sameRoomSet(hiddenSetting, user.hidden)) return true;
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
  // closure always sees fresh form state - same no-deps pattern TaskView
  // uses for its own dirty-check ref.
  useEffect(() => {
    if (closeRef) closeRef.current = requestClose;
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  // Tab-close guard while dirty:
  // in-app navigation already routes through the discard prompt, but closing
  // or reloading the tab was the one silent loss path. No deps - the handler
  // must see fresh form state each render.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty()) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
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
      (memberPrompt.trim() || null) !== (user.memberPrompt ?? null) ||
      normalizedColor !== user.avatarColor ||
      avatarVariant !== user.avatarVariant;
    try {
      // The update_user split is sequenced to preserve the WS atomicity
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
        // never writes allowedRooms - only a member's access is editable here.
        await apiFetch(
          "PUT",
          `/api/users/${encodeURIComponent(origName)}/access`,
          { allowedRooms: allowedSetting },
        );
      }
      // (2) Record fields (name/prompt/avatar), against the original name.
      if (recordChanged) {
        await apiFetch("PATCH", `/api/users/${encodeURIComponent(origName)}`, {
          name: renamed ? trimmed : undefined,
          memberPrompt: memberPrompt.trim() || null,
          avatarColor: normalizedColor,
          avatarVariant,
        });
      }
      // (2b) Boss memory is a separate version-guarded REPLACE keyed by the stable
      // userId (rename-safe). A 409 means it changed under us - surface + keep open.
      if (memoryChanged) {
        const m = await mem.save();
        if (!m.ok) {
          setError(m.message);
          return;
        }
      }
      // (3) View prefs are SELF-only: the fields render only for isMe. Shown
      // FIRST: the server clamps notifRooms to the effective
      // shown set on every shown write, so re-showing a room and enabling its
      // notification in one save only works in this order. The shown list is
      // the complement of hiddenSetting over the accessible set - and because
      // any accessible room OMITTED from it becomes hidden, the complement is
      // computed over a FRESH authoritative accessible list fetched at save
      // time, never a possibly stale client snapshot. A room
      // granted/created while this panel is mounted must default to shown,
      // not get silently hidden. If the pre-write read fails, fail the save
      // rather than risk a destructive stale complement.
      if (isMe && !sameRoomSet(hiddenSetting, user.hidden)) {
        let accessibleNow: { id: string }[];
        try {
          accessibleNow = (
            await apiFetch<{ rooms: { id: string; name: string }[] }>(
              "GET",
              "/api/me/rooms",
            )
          ).rooms;
        } catch {
          setError("Could not confirm your room list; Displayed not saved.");
          return;
        }
        await apiFetch("PUT", "/api/me/view/shown", {
          shown: accessibleNow
            .filter((r) => !hiddenSetting.includes(r.id))
            .map((r) => r.id),
        });
      }
      // notif-rooms takes the full list.
      if (isMe && !sameRoomSet(notifSetting, user.notifRooms)) {
        await apiFetch("PUT", "/api/me/view/notif-rooms", {
          notifRooms: notifSetting,
        });
      }
      if (renamed) onRenamed?.(trimmed);
      // Unlike the old modal (which collapsed the editor on save), the page
      // stays on the saved user. Sync local fields to exactly what was saved
      // so the form reads clean once the broadcast refreshes the record -
      // including normalizations the server applies (trim, hex color).
      setName(trimmed);
      setMemberPrompt(memberPrompt.trim());
      setAvatarColor(normalizedColor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const contentPad = isMobile ? "0 16px" : "0 24px";

  // Drives the dirty-aware Save button (save-flow friction pass, task
  // 4733fa30): disabled + "Saved" when the form matches the record, so "did
  // I save?" is answerable at a glance - the convention the External access
  // card already follows.
  const dirty = isDirty();

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

        {/* Rooms: ONE table for the three hierarchical
            per-room settings - ACCESS ⊇ DISPLAYED ⊇ NOTIFICATIONS.
            Access is owner-managed on member targets; Displayed and
            Notifications are SELF-only view prefs, so at most two
            columns ever render at once (owner-editing-member: Access only;
            self-edit: Displayed + Notifications). A member viewer only ever
            mounts this panel for themselves (canEdit), so !isOwner ⇒ isMe. */}
        {(isOwner && (!targetIsOwner || isMe)) || (!isOwner && isMe) ? (
          <>
            <h5 style={sectionTitleStyle}>Rooms</h5>
            <p style={sectionHintStyle}>
              {isOwner &&
                !targetIsOwner &&
                "Access: rooms this user can see and act in (owner-managed). "}
              {isMe &&
                "Displayed: which of your accessible rooms appear in your own view. " +
                  "Notifications: sound when an agent in that room finishes. " +
                  "A room must be displayed to notify."}
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
                  color: "var(--text-muted)",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>Room</span>
                {isOwner && !targetIsOwner && (
                  <span style={{ width: 80, textAlign: "center" }}>Access</span>
                )}
                {isMe && (
                  <span style={{ width: 80, textAlign: "center" }}>
                    Displayed
                  </span>
                )}
                {isMe && (
                  <span style={{ width: 90, textAlign: "center" }}>
                    Notifications
                  </span>
                )}
              </div>
              {rowsForPrefs.length === 0 ? (
                <div
                  style={{
                    padding: "8px 12px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  No rooms yet.
                </div>
              ) : (
                rowsForPrefs.map((r) => {
                  const hasAccess = accessibleForPrefs.includes(r.id);
                  const displayed = hasAccess && !hiddenSetting.includes(r.id);
                  const wantsNotif = displayed && notifSetting.includes(r.id);
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
                      {isOwner && !targetIsOwner && (
                        <span
                          style={{
                            width: 80,
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
                            width: 80,
                            display: "flex",
                            justifyContent: "center",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={displayed}
                            disabled={!hasAccess}
                            onChange={() => {
                              // Defensive handler-level gate mirroring the
                              // notif one below: DISPLAYED ⊆ ACCESS.
                              if (!hasAccess) return;
                              toggleRoomDisplayed(r.id);
                            }}
                            aria-label={`Display ${r.name}`}
                            style={{
                              accentColor: "var(--accent)",
                              cursor: hasAccess ? "pointer" : "default",
                              opacity: hasAccess ? 1 : 0.35,
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
                            disabled={!displayed}
                            onChange={() => {
                              // Defensive: also gate at the handler, not just
                              // via `disabled`, so a future refactor or stale
                              // click can't add notif for a hidden or
                              // inaccessible room (NOTIFICATIONS ⊆ DISPLAYED).
                              if (!displayed) return;
                              toggleRoomNotif(r.id);
                            }}
                            aria-label={`Notifications for ${r.name}`}
                            style={{
                              accentColor: "var(--accent)",
                              cursor: displayed ? "pointer" : "default",
                              opacity: displayed ? 1 : 0.35,
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
        ) : null}

        <h5 style={sectionTitleStyle}>Agent Context</h5>

        <label style={subLabelStyle}>
          Profile Prompt{" "}
          <span style={hintStyle}>
            (auto-injected into the system prompt of agents you own; other
            users&apos; agents can look it up if they need context on you)
          </span>
        </label>
        <ExpandableTextarea
          title={`${user.name} · Profile Prompt`}
          hint="Auto-injected into the system prompt of agents this user owns; other users' agents can look it up if they need context on them."
          value={memberPrompt}
          onChange={setMemberPrompt}
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
            as shown - one memory per line; {mem.size} / {mem.cap ?? "…"})
          </span>
        </label>
        <ExpandableTextarea
          title={`${user.name} · Memory`}
          hint="This editor rewrites the file exactly as shown. Use one memory per line."
          value={mem.memory}
          onChange={mem.setMemory}
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

        {/* Aesthetics last: looks are secondary to the
            settings that change behavior. */}
        <h5 style={sectionTitleStyle}>Appearance</h5>
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
                disabled={saving || !dirty || !name.trim()}
                style={{
                  ...saveBtnStyle,
                  opacity: saving || !dirty || !name.trim() ? 0.5 : 1,
                  cursor:
                    saving || !dirty || !name.trim() ? "default" : "pointer",
                }}
              >
                {saving ? "Saving…" : dirty ? "Save" : "Saved"}
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
        fontSize: 10,
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
          ? "Owner - can invite users, revoke sessions, and set per-user room access"
          : "Member - can act in rooms the owner allowed; can't invite or revoke"
      }
    >
      {role}
    </span>
  );
}

// Green presence dot overlaid on the sidebar avatar for users with a live
// connection. Ringed in the page background so it reads as a badge over any
// ghost color.
const onlineDotStyle: React.CSSProperties = {
  position: "absolute",
  right: -2,
  bottom: -1,
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--green)",
  border: "1.5px solid var(--bg-base)",
};

// One labelled group of sidebar rows. A row that only opens a dialog never
// paints as selected, because nothing of it is showing in the detail pane.
function SidebarGroupRows({
  group,
  first,
  onSelect,
}: {
  group: SidebarGroup;
  first: boolean;
  onSelect: (target: Selection) => void;
}) {
  if (group.rows.length === 0) return null;
  return (
    <>
      <div style={{ ...sidebarSectionLabel, marginTop: first ? 0 : 18 }}>
        {group.label}
      </div>
      {group.rows.map((row) => (
        <button
          key={row.key}
          onClick={() => (row.target ? onSelect(row.target) : row.open?.())}
          aria-current={row.selected ? "true" : undefined}
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
            background: row.selected ? "var(--bg-hover)" : "transparent",
            borderLeft: row.selected
              ? "2px solid var(--accent)"
              : "2px solid transparent",
          }}
        >
          {row.label}
        </button>
      ))}
    </>
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
  fontSize: 12,
  color: "var(--text-muted)",
  margin: "6px 0 0",
  lineHeight: 1.4,
};
const subLabelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 12 };
const hintStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
