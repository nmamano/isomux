import { versionOf } from "../../shared/blob-version.ts";
import { AuditPane } from "./AuditList.tsx";
import { ordinaryRooms } from "../../shared/types.ts";
// The full-page Settings surface (master-detail), replacing the old crowded modal
// (UserManagementModal). Entered and exited like the Tasks page: rendered in
// App's main view switch, closed via the header back arrow, ESC, or the
// browser back button (popstate).
//
// Layout: a sidebar (master) shows the Office, You and Device groups ABOVE
// the Rooms and Members lists, which start collapsed so the fixed entries
// stay reachable however long the roster grows, then the Housekeeping group,
// with Sign out pinned at the bottom; the detail area shows the selected
// user's editor,
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
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import { useMemoryEditor } from "../hooks/useMemoryEditor.ts";
import { RECORDING_PRIVATE_ATTR } from "../recording-mode.ts";
import {
  setUsername as saveLocalUsername,
  getUsername,
} from "../device-settings.ts";
import {
  LOBBY_ROOM_ID,
  type NotifRoomsSetting,
  type UserRecord,
} from "../../shared/types.ts";
import { memberPinKey } from "../../shared/sidebar-pins.ts";
import type {
  InstructionsReq,
  InstructionsRes,
  PinnedReq,
  ApiTokenListRes,
  ApiTokenWire,
} from "../../shared/contract-shapes.ts";
import { type UserView, isFullUserView } from "../user-merge.ts";
import {
  GHOST_COLOR_PALETTE,
  GHOST_VARIANTS,
  isHexColor,
  normalizeHexColor,
  type GhostVariant,
} from "../../shared/avatar.ts";
import { GhostGraphic } from "../office/ghostVariants.tsx";
import { BuildingIcon, DeviceIcon, UserIcon } from "./NavIcons.tsx";
import {
  EnterprisePane,
  useEnterpriseAvailable,
} from "./EnterpriseContractSection.tsx";
import {
  SidebarGroupHeader,
  SidebarGroupRows,
  type SidebarGroup as SharedSidebarGroup,
  type SidebarRow as SharedSidebarRow,
} from "./SidebarGroups.tsx";
import {
  dialogHint,
  dialogInput,
  dialogLabel,
  filledDangerBtn,
  settingsSectionTitle,
} from "./dialog-styles.ts";
import { DevicePane } from "./DevicePane.tsx";
import { SidebarPage } from "./SidebarPage.tsx";
import { OfficePane } from "./OfficePane.tsx";
import { OfficeMovePane } from "./OfficeMovePane.tsx";
import { StoragePane } from "./StoragePane.tsx";
import { UsagePane } from "./UsagePane.tsx";
import { RoomPane } from "./RoomPane.tsx";
import { createRoom } from "../office/create-room.ts";
import { useCreatesRooms } from "../hooks/useCan.ts";
import { ThemePane } from "./ThemePane.tsx";
import { RecordingPane } from "./RecordingPane.tsx";
import { UpdatePane } from "./UpdatePane.tsx";
import { ExternalAccessPane } from "./ExternalAccessPane.tsx";
import { useUnsavedChangesPrompt } from "./UnsavedChangesPrompt.tsx";
import { useLeaveGuard } from "../page-leave-guard.ts";
import { InvitesPane, PendingMemberSignInLink } from "./InvitesPane.tsx";
import { SessionsPane } from "./SessionsPane.tsx";
import { MyDevicesPane, NewDevicePane } from "./MyDevicesPane.tsx";
import { ChatChoiceBox, PreferencesPane } from "./PreferencesPane.tsx";
import {
  RemovedMembersPane,
  useRemovedMembersSeed,
} from "./RemovedMembersPane.tsx";
import { ApiTokenCards, useMemberRooms } from "./ApiTokensPane.tsx";
import {
  ExpandableTextarea,
  isExpandedEditorOpen,
} from "./ExpandableTextarea.tsx";
import { formatSince, useAccessListsSeed } from "./access-shared.tsx";
import { isConfirmArmed, useConfirmStep } from "../hooks/useConfirmStep.ts";
import { useI18n, type UiTranslator } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import {
  roomViewLevel,
  withRoomViewLevel,
  type RoomViewLevel,
} from "../../shared/room-view-level.ts";
import {
  RoomViewLevelControl,
  RoomViewLevelLegend,
} from "./RoomViewLevelControl.tsx";
import { PushThisDevice } from "./PushDevicesBlock.tsx";
import { forgetThisDevice } from "../push-subscription.ts";
import {
  getSettingsGroupsOpen,
  setSettingsGroupOpen,
} from "../device-settings.ts";
import { MemberAccessControl } from "./MemberAccessControl.tsx";
import { MemberOsUserSection } from "./MemberOsUserSection.tsx";
import { MemberPinnedAgents } from "./MemberPinnedAgents.tsx";
import type { MemberLevel } from "../member-access.ts";
import { samePack } from "../../shared/pack-fit.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import { PHONE_TOP } from "../safe-area.ts";
import {
  MEMBER_FIELD_PART,
  dirtyParts,
  memberParts,
  resolvePart,
  type MemberField,
  type MemberPart,
  type RoomPart,
} from "../settings-parts.ts";
import {
  EditAgentDialog,
  type AgentSettingsSection,
} from "./EditAgentDialog.tsx";
import {
  SettingsItemPage,
  settingsSectionBox,
  SettingsPartBody,
  SettingsSaveFooter,
  type SettingsItemEscape,
  type SettingsItemView,
} from "./SettingsItemPage.tsx";

// Sections that render INSIDE this page. The sidebar also carries rows that
// still open a dialog (office, room, device label, theme, updates); those are
// not sections because nothing of theirs mounts in the detail pane yet.
//
// "signInLinks" is the pane formerly labelled "My devices": it holds invite
// links and sessions for signing in elsewhere, not devices, and the label now
// says so. The connections panes moved to their own page, Integrations; the
// office bar, the phone menu and the i key open it, never Settings (Nil,
// 2026-10-14: two ways in read as two places). Pager and API tokens followed
// them there (task db800fd8).
export type SettingsSection =
  | "audit"
  | "office"
  | "enterprise"
  | "storage"
  | "usage"
  | "access"
  | "invites"
  | "sessions"
  | "prefs"
  | "signInLinks"
  | "newDevice"
  | "updates"
  | "move"
  | "deviceLabel"
  | "theme"
  | "recording";

// What a sidebar row does: open a selection, or create a room (the Rooms
// group's New room row), which is an action and never a selection.
type SidebarTarget = Selection | { kind: "newRoom" };
type SidebarRow = SharedSidebarRow<SidebarTarget>;
type SidebarGroup = SharedSidebarGroup<SidebarTarget>;

// What the detail pane shows: a user's editor, or one settings section.
// null = nothing selected - on mobile that means the list is showing; on
// desktop the detail renders a placeholder. User selections are keyed by the
// STABLE user id (not the lowercased-name map key), so a rename from this or
// another session never dangles the selection.
// Structural equality over the three arms. Re-selecting the row you are
// already on must be a no-op, or it would run the unsaved-changes prompt
// against a pane you never left.
function sameItem(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "section" && b.kind === "section")
    return a.section === b.section;
  if (a.kind === "user" && b.kind === "user") return a.id === b.id;
  if (a.kind === "room" && b.kind === "room") return a.roomId === b.roomId;
  if (a.kind === "agent" && b.kind === "agent") return a.agentId === b.agentId;
  return a.kind === "newMember" || a.kind === "removedMembers";
}

// A listed item: its selection names a part.
function hasParts(selection: Selection): boolean {
  return (
    selection.kind === "user" ||
    selection.kind === "room" ||
    selection.kind === "agent" ||
    selection.kind === "newMember"
  );
}

// The open part of an item selection, if it names one.
function partOf(selection: Selection): string | null | undefined {
  return "part" in selection ? selection.part : undefined;
}

// A listed item (a member, a room, an agent) also names its open part
// (ui/settings-parts.ts). Absent: the first part on a desktop, the item's
// part list on a phone; null: the part list.
export type Selection =
  | { kind: "user"; id: string; part?: MemberPart | null }
  | { kind: "section"; section: SettingsSection }
  // Rooms are not a fixed set, so a room cannot be a section name. It carries
  // its id instead, which is also how the room-tab double-click points here.
  | { kind: "room"; roomId: string; part?: RoomPart | null }
  // An agent's settings (task 1f79f2e3): its doors open Settings on it.
  | { kind: "agent"; agentId: string; part?: AgentSettingsSection | null }
  // An owner creating a member: the member editor with no record behind it.
  | { kind: "newMember"; part?: MemberPart | null }
  // The members removed in the last 30 days (task 321e7b8e), owners only.
  | { kind: "removedMembers" };

// A member part's label, in the list column and on your own You rows.
function memberPartLabel(t: UiTranslator["t"], part: MemberPart): string {
  switch (part) {
    case "general":
      return t("settings.part.general");
    case "access":
      return t("settings.memberAccess.title");
    case "osUser":
      return t("settings.osUser.title");
    case "signIn":
      return t("settings.part.signIn");
    case "rooms":
      return t("common.rooms");
    case "instructions":
      return t("common.instructionsAndMemory");
    case "chat":
      return t("settings.profile.chat");
  }
}

// The data attributes of your own part rows in the You group while one of
// them is open: they are then the open item's part rows. The group's other
// rows get none.
function selfRowAttrs(row: SidebarRow): Record<string, string> {
  const part = row.target.kind === "user" ? row.target.part : null;
  if (!part || !row.partOfOpenItem) return {};
  return {
    "data-settings-part": part,
    ...(row.dirty ? { "data-settings-part-dirty": "" } : {}),
  };
}

// The groups whose header opens and closes them: the two whose rows come
// from live data and can run long.
const COLLAPSIBLE_GROUPS = new Set(["rooms", "members"]);

// The collapsible group that holds a selection, if it is closed in `open`,
// added to a copy of it. Your own profile is the You > General row, and the
// New member row shows in a closed Members group, so they open nothing.
function withGroupOf(
  open: Set<string>,
  selection: Selection | null,
  session: { userId: string } | null | undefined,
): Set<string> {
  const group =
    selection?.kind === "room"
      ? "rooms"
      : selection?.kind === "user" && selection.id !== session?.userId
        ? "members"
        : null;
  return group === null || open.has(group) ? open : new Set(open).add(group);
}

export function UserSettingsView({
  initialUserId,
  onSwitchUser,
  onClose,
  initialTarget,
  covered = false,
}: {
  // Live-avatars: when set, the page opens with this user's editor selected
  // (used by ghost click → settings shortcut). Read once on mount; updates to
  // this prop while the page is mounted do NOT re-sync the selection. App.tsx
  // keys the page on each door into Settings, so a door taken while the page
  // is open mounts a fresh page that applies the new target.
  initialUserId?: string | null;
  // Which sidebar row to open on. Every door into this page carries its own
  // target - the update pill lands on Updates, the bar's Theme button on
  // Theme, a room tab on that room - so the page never has to guess where the
  // reader meant to go. Read once on mount, like initialUserId.
  initialTarget?: Selection | null;
  onSwitchUser: (name: string | null) => void;
  onClose: () => void;
  // A menu or a dialog is open over the page: Escape is theirs.
  covered?: boolean;
}) {
  const {
    users,
    rooms,
    agents,
    isMobile,
    sessionContext,
    onlineUserIds,
    activeSessions,
    removedMembers,
  } = useAppState();
  const i18n = useI18n();
  const { t } = i18n;
  const isOwner = sessionContext?.role === "owner";
  const createsRooms = useCreatesRooms();
  const dispatch = useDispatch();
  useRemovedMembersSeed(isOwner);
  const enterpriseAvailable = useEnterpriseAvailable(isOwner);
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

  // Rooms and Members start collapsed (task db800fd8). A header click opens
  // or closes its group and is kept on the device; a selection that lands in
  // a closed group opens it for this visit only, so the open row is never
  // hidden and a header click always changes what shows.
  const [openGroups, setOpenGroups] = useState(() =>
    withGroupOf(getSettingsGroupsOpen(), selection, sessionContext),
  );
  function show(next: Selection | null) {
    setSelection(next);
    setOpenGroups((open) => withGroupOf(open, next, sessionContext));
  }
  function toggleGroup(id: string) {
    const open = !openGroups.has(id);
    setOpenGroups((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    setSettingsGroupOpen(id, open);
  }

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
        const next: Selection = { kind: "user", id: u.id };
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelection(next);
        setOpenGroups((open) => withGroupOf(open, next, sessionContext));
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
  // The drilled item's state that Escape needs, kept fresh by
  // SettingsItemPage.
  const itemEscapeRef = useRef<SettingsItemEscape | null>(null);
  function leaveEdit(after?: () => void) {
    if (selection !== null && detailCloseRef.current) {
      detailCloseRef.current(after);
    } else {
      after?.();
    }
  }
  // A click outside the page (the desktop sidebar) leaves through the same
  // dirty check.
  useLeaveGuard((after) => leaveEdit(after));

  function select(next: Selection) {
    // Any explicit choice consumes the pending hydration default (above) so
    // a late-arriving roster can't override it.
    defaultAppliedRef.current = true;
    if (selection !== null && sameItem(selection, next)) {
      // Another part of the open item: the form stays, nothing to leave.
      if (partOf(next) !== partOf(selection)) show(next);
      return;
    }
    leaveEdit(() => show(next));
  }
  // A sidebar row: open its selection, or run New room.
  function pick(target: SidebarTarget) {
    if (target.kind === "newRoom") newRoom();
    else select(target);
  }
  // Settings > Rooms > New room: one click, one room. It leaves the open
  // editor through the unsaved-changes check, creates the room and opens its
  // General part. The ref, not the disabled row, stops a second click in the
  // same tick.
  const creatingRoom = useRef(false);
  const [newRoomState, setNewRoomState] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  function newRoom() {
    if (creatingRoom.current) return;
    defaultAppliedRef.current = true;
    leaveEdit(() => {
      if (creatingRoom.current) return;
      creatingRoom.current = true;
      setNewRoomState({ kind: "pending" });
      createRoom(dispatch)
        .then((room) => {
          setNewRoomState({ kind: "idle" });
          show({ kind: "room", roomId: room.id, part: "general" });
        })
        .catch((err) =>
          setNewRoomState({
            kind: "failed",
            message:
              err instanceof ApiError
                ? err.message
                : t("office.newRoom.failed"),
          }),
        )
        .finally(() => {
          creatingRoom.current = false;
        });
    });
  }
  // A part row of the open item.
  function selectPart(part: string | null) {
    defaultAppliedRef.current = true;
    setSelection((cur) =>
      cur && hasParts(cur) ? ({ ...cur, part } as Selection) : cur,
    );
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
  // This device needs a new invite to sign in again: Sign out asks first.
  const signOutStep = useConfirmStep();

  // ESC: mobile detail → back to the list; otherwise leave the page. Both
  // routed through the dirty check. Capture + stopPropagation so App's own
  // Escape handler (closeLog, which knows nothing of unsaved edits) never sees
  // it. No deps - re-registers every render so the closures stay fresh.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // An expanded editor collapses on Escape instead of navigating this
      // page; our capture listener runs first, so stand down for it.
      if (isExpandedEditorOpen()) return;
      // An armed confirm step takes Escape to end itself.
      if (isConfirmArmed()) return;
      // A menu or a dialog over the page takes it.
      if (covered) return;
      e.stopPropagation();
      // A drilled item: its prompt first, then a phone's part goes back to
      // the part list. No way out while it saves.
      const item = itemEscapeRef.current;
      if (item?.prompt.open) {
        item.prompt.cancel();
        return;
      }
      if (item?.busy) return;
      if (isMobile && item && item.part !== null) {
        item.onPart(null);
        return;
      }
      if (isMobile && selection) {
        backToList();
      } else {
        leaveEdit(() => onClose());
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  const selectedAgent =
    selection?.kind === "agent"
      ? (agents.find((a) => a.id === selection.agentId) ?? null)
      : null;
  const selectedUser =
    selection?.kind === "user"
      ? ([...users.values()].find((u) => u.id === selection.id) ?? null)
      : null;

  // The record a new member starts from; the editor diffs against it.
  const [newMemberDraft] = useState(newMemberRecord);

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
  const selfRecord =
    [...users.values()].find((u) => u.id === selfUserId) ?? null;
  // Your own record, when you may edit it (yourself, a full record).
  const selfEditable =
    selfRecord && isFullUserView(selfRecord) && canEdit(selfRecord)
      ? selfRecord
      : null;
  const selfOpen =
    selfEditable !== null &&
    selection?.kind === "user" &&
    selection.id === selfEditable.id;
  // Your own form's parts with their dots, handed up by the form while one
  // of your rows is open (SelfPartsReport).
  const [selfReport, setSelfReport] = useState<SelfParts | null>(null);
  // Your own member parts, as rows of the You group (task 1f79f2e3): from
  // your open form (its dots), else from your saved record.
  const selfRows = (): SidebarRow[] => {
    if (!selfUserId) return [];
    const reported = selfOpen ? selfReport : null;
    const parts =
      reported?.parts ??
      (selfRecord && isFullUserView(selfRecord)
        ? memberParts({
            viewerIsOwner: isOwner,
            isMe: true,
            creating: false,
            targetIsOwner: selfRecord.role === "owner",
          })
        : (["general"] as MemberPart[])
      ).map((id) => ({ id, label: memberPartLabel(t, id), dirty: false }));
    return parts.map((p) => ({
      key: `self:${p.id}`,
      label: p.label,
      selected:
        selfOpen &&
        (reported?.part ??
          ((selection?.kind === "user" && selection.part) || "general")) ===
          p.id,
      target: { kind: "user" as const, id: selfUserId, part: p.id },
      dirty: p.dirty,
      partOfOpenItem: selfOpen,
    }));
  };
  const buildGroups = (): SidebarGroup[] =>
    accountAvailable
      ? [
          {
            id: "office",
            label: t("settings.sidebar.office"),
            icon: BuildingIcon,
            rows: [
              sectionRow("office", t("settings.sidebar.office")),
              ...(isOwner
                ? [
                    sectionRow("access", t("settings.sidebar.access")),
                    sectionRow("invites", t("settings.sidebar.invites")),
                  ]
                : []),
              // The Enterprise Contract box, owners only and never on Hosted.
              ...(isOwner && enterpriseAvailable
                ? [sectionRow("enterprise", t("settings.sidebar.enterprise"))]
                : []),
              sectionRow("updates", t("settings.sidebar.updates")),
            ],
          },
          {
            id: "you",
            label: t("common.you"),
            icon: UserIcon,
            rows: [
              // Your own member parts: the same editor as another member's,
              // as flat rows here, so one path leads to your own settings.
              ...selfRows(),
              sectionRow("prefs", t("settings.sidebar.languageAndChat")),
              sectionRow("signInLinks", t("settings.sidebar.signInLinks")),
              {
                ...sectionRow("newDevice", t("settings.sidebar.newDevice")),
                add: true,
              },
            ],
          },
          {
            id: "device",
            label: t("common.device"),
            icon: DeviceIcon,
            rows: [
              sectionRow("deviceLabel", t("settings.sidebar.deviceLabel")),
              sectionRow("theme", t("common.theme")),
              sectionRow("recording", t("settings.sidebar.recording")),
            ],
          },
          {
            id: "rooms",
            label: t("common.rooms"),
            // Dynamic: one row per room the viewer can see, so the rows carry a
            // glyph and read as a list of live things - like the roster below,
            // and unlike the fixed rows above.
            dynamic: true,
            rows: [
              ...rooms.map((room) => ({
                key: `room:${room.id}`,
                label: room.name,
                selected:
                  selection?.kind === "room" && selection.roomId === room.id,
                target: { kind: "room" as const, roomId: room.id },
              })),
              // Last, and shown while the group is closed, like New member.
              ...(createsRooms
                ? [
                    {
                      key: "newRoom",
                      label: t("office.newRoom.door"),
                      selected: false,
                      target: { kind: "newRoom" as const },
                      add: true as const,
                      disabled: newRoomState.kind === "pending",
                      error:
                        newRoomState.kind === "failed"
                          ? newRoomState.message
                          : null,
                    },
                  ]
                : []),
            ],
          },
          {
            id: "members",
            label: t("settings.sidebar.members"),
            rows: [],
            roster: true,
          },
          // Mostly read-only panes a member rarely needs, out of the way at
          // the end (Nil, 2026-10-23).
          {
            id: "housekeeping",
            label: t("settings.sidebar.housekeeping"),
            rows: [
              ...(isOwner
                ? [
                    sectionRow("sessions", t("settings.sidebar.sessions")),
                    sectionRow("audit", t("audit.title")),
                  ]
                : []),
              sectionRow("usage", t("settings.sidebar.usage")),
              // Storage is owner-only, matching the server: prune is gated on
              // officeOwner and the usage read strips paths for anyone else.
              // Moving the office (task 78733adf) is an owner action, on Hosted
              // too.
              ...(isOwner
                ? [
                    sectionRow("storage", t("settings.sidebar.storage")),
                    sectionRow("move", t("settings.sidebar.move")),
                  ]
                : []),
            ],
          },
        ]
      : [];

  async function signOut() {
    setLogoutBlockedReason(null);
    // First, while the session still works: this device stops getting the
    // member's pages.
    if (sessionContext) await forgetThisDevice(sessionContext.username);
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

  // The header props of a group that opens and closes; none for the rest.
  const collapsible = (id: string) =>
    COLLAPSIBLE_GROUPS.has(id)
      ? { collapsed: !openGroups.has(id), onToggle: () => toggleGroup(id) }
      : {};

  // The Settings list column.
  const renderList = () => {
    // The roster splits the sidebar in two. Slicing on it keeps group ORDER
    // in buildGroups alone, so adding or moving a group never means editing
    // the JSX below.
    const sidebarGroups = buildGroups();
    const rosterIndex = sidebarGroups.findIndex((group) => group.roster);
    const groupsBeforeRoster =
      rosterIndex === -1 ? [] : sidebarGroups.slice(0, rosterIndex);
    const groupsAfterRoster =
      rosterIndex === -1 ? [] : sidebarGroups.slice(rosterIndex + 1);
    const rosterGroup = rosterIndex === -1 ? null : sidebarGroups[rosterIndex];
    return (
      <>
        {/* Groups render in the order of sidebarGroups. The roster group
              is rendered in place rather than as rows, so the ordering
              lives in that one array and not here. */}
        {groupsBeforeRoster.map((group, i) => (
          <SidebarGroupRows
            key={group.id}
            group={group}
            first={i === 0}
            onSelect={(target) => pick(target)}
            rowAttrs={selfRowAttrs}
            {...collapsible(group.id)}
          />
        ))}

        <SidebarGroupHeader
          groupId="members"
          label={rosterGroup?.label ?? t("settings.sidebar.members")}
          first={groupsBeforeRoster.length === 0}
          {...collapsible("members")}
        />
        {openGroups.has("members") && (
          <>
            {userList.map((u) => {
              const isMe = sessionContext?.userId === u.id;
              // Your own row lights You > General instead.
              const selected =
                !isMe && selection?.kind === "user" && selection.id === u.id;
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
                isOwner && u.pendingSignIn === true,
                i18n,
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
                      ? () =>
                          // Yourself: You > General, the one path to your
                          // own settings. select runs on a click, never
                          // during render.
                          // eslint-disable-next-line react-hooks/refs
                          select(
                            isMe
                              ? { kind: "user", id: u.id, part: "general" }
                              : { kind: "user", id: u.id },
                          )
                      : undefined
                  }
                  aria-current={selected ? "true" : undefined}
                  title={editable ? undefined : t("settings.members.editHint")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    textAlign: "left",
                    font: "inherit",
                    padding: "8px 14px",
                    border: "none",
                    cursor: editable ? "pointer" : "default",
                    background: selected ? "var(--bg-hover)" : "transparent",
                    borderLeft: selected
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                    color: editable ? "inherit" : "var(--text-hint)",
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
                      <span
                        style={onlineDotStyle}
                        title={t("settings.members.onlineNow")}
                      />
                    )}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: editable
                          ? "var(--text-primary)"
                          : "var(--text-hint)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      <span
                        {...noTranslate()}
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
                          {t("settings.you")}
                        </span>
                      )}
                      <RoleBadge role={u.role} />
                    </div>
                    {summary && (
                      <div
                        style={{
                          fontSize: 10,
                          color: "var(--text-muted)",
                          fontFamily: "var(--font-ui)",
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
          </>
        )}
        {/* Outside the open check: it stays under a collapsed list. */}
        {isOwner && (
          <button
            onClick={() => select({ kind: "newMember" })}
            aria-current={selection?.kind === "newMember" ? "true" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              font: "inherit",
              fontSize: 13,
              color: "var(--text-muted)",
              padding: "8px 14px",
              border: "none",
              cursor: "pointer",
              background:
                selection?.kind === "newMember"
                  ? "var(--bg-hover)"
                  : "transparent",
              borderLeft:
                selection?.kind === "newMember"
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 22, textAlign: "center", fontSize: 16 }}
            >
              +
            </span>
            {t("settings.members.newMember")}
          </button>
        )}
        {isOwner && removedMembers.length > 0 && (
          <button
            onClick={() => select({ kind: "removedMembers" })}
            aria-current={
              selection?.kind === "removedMembers" ? "true" : undefined
            }
            data-removed-members-row=""
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              font: "inherit",
              fontSize: 13,
              color: "var(--text-muted)",
              padding: "8px 14px",
              border: "none",
              cursor: "pointer",
              background:
                selection?.kind === "removedMembers"
                  ? "var(--bg-hover)"
                  : "transparent",
              borderLeft:
                selection?.kind === "removedMembers"
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
            }}
          >
            <span aria-hidden="true" style={{ width: 22 }} />
            {t("settings.removedMembers.row", {
              count: removedMembers.length,
            })}
          </button>
        )}

        {groupsAfterRoster.map((group) => (
          <SidebarGroupRows
            key={group.id}
            group={group}
            first={false}
            onSelect={(target) => pick(target)}
            rowAttrs={selfRowAttrs}
            {...collapsible(group.id)}
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
          {t("settings.profilesNote")}
        </p>

        {sessionContext && (
          <div style={{ padding: "0 14px" }}>
            <button
              {...signOutStep.bind("signOut")}
              onClick={() =>
                signOutStep.confirm("signOut", () => void signOut())
              }
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: filledDangerBtn.border,
                background: filledDangerBtn.background,
                color: filledDangerBtn.color,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={t("settings.signOutHint")}
            >
              {t(
                signOutStep.armed ? "common.confirmQuestion" : "common.signOut",
              )}
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
                  color: "var(--red-text)",
                }}
              >
                {logoutBlockedReason}
              </p>
            )}
          </div>
        )}
      </>
    );
  };

  // The page with the Settings list in its list column.
  const listPage = (
    list: React.ReactNode,
    detail: React.ReactNode,
  ): React.ReactElement => (
    <SidebarPage
      title={t("common.settings")}
      onClose={() => leaveEdit(() => onClose())}
      listShown={selection === null}
      onBackToList={backToList}
      backLabel={t("common.settings")}
      listLabel={t("common.settings")}
      detailAttrs={{ "data-testid": "settings-content" }}
      list={list}
    >
      {detail}
    </SidebarPage>
  );

  // A listed item drilled in (task 1f79f2e3): its parts replace the list
  // column, under a back row to the Settings list.
  const itemPage = <P extends string>(
    item: string,
    backLabel: string,
    view: SettingsItemView<P>,
  ) => (
    <SettingsItemPage
      item={item}
      backLabel={backLabel}
      view={view}
      onPart={selectPart}
      onBackToSettings={() => {
        defaultAppliedRef.current = true;
        leaveEdit(() => setSelection(null));
      }}
      onClose={() => leaveEdit(() => onClose())}
      escapeRef={itemEscapeRef}
    />
  );

  if (selection?.kind === "agent") {
    // An agent that is gone leaves the Settings list.
    if (!selectedAgent) {
      setSelection(null);
      return null;
    }
    return (
      <EditAgentDialog
        // One form per agent: another agent's page starts from its own.
        key={selectedAgent.id}
        // The live record, so a change the server sends while the page is
        // open (limitedClaudeFamilies after a variables save) reaches it.
        agent={selectedAgent}
        part={selection.part}
        onPart={selectPart}
        closeRef={detailCloseRef}
        onClose={() => setSelection(null)}
        onClosePage={onClose}
      >
        {(view) =>
          itemPage(`agent:${selectedAgent.id}`, selectedAgent.name, view)
        }
      </EditAgentDialog>
    );
  }

  if (selection?.kind === "room") {
    const room = rooms.find((r) => r.id === selection.roomId);
    return (
      <RoomPane
        key={selection.roomId}
        roomId={selection.roomId}
        part={selection.part}
        onPart={selectPart}
        closeRef={detailCloseRef}
        onDeleted={() => setSelection(null)}
      >
        {(view) => itemPage(`room:${selection.roomId}`, room?.name ?? "", view)}
      </RoomPane>
    );
  }

  if (selection?.kind === "newMember" && isOwner) {
    return (
      <UserEditPanel
        key="newMember"
        user={newMemberDraft}
        creating
        isMobile={isMobile}
        part={selection.part}
        onPart={selectPart}
        closeRef={detailCloseRef}
        onClose={() => setSelection(null)}
        // Create keeps the part it was pressed on.
        onCreated={(id) => show({ kind: "user", id, part: selection.part })}
      >
        {(view) => itemPage("newMember", t("settings.members.newMember"), view)}
      </UserEditPanel>
    );
  }

  // The record's way out of a rename or a delete of the member this device
  // is signed in as.
  const onRenamedFor = (edited: UserView) => (newName: string) => {
    // Selection is id-keyed, so a rename never dangles it.
    // If the edited user is the current device's user and they
    // renamed (case-changing too), keep localStorage in sync so
    // the next claim_user doesn't fork a new empty record.
    const localKey = getUsername()?.toLowerCase();
    if (localKey && localKey === edited.name.toLowerCase()) {
      saveLocalUsername(newName);
      onSwitchUser(newName);
    }
  };
  const onDeletedFor = (edited: UserView) => () => {
    // If the deleted user is the current device's user, clear
    // localStorage so the picker auto-opens on the next render.
    const localKey = getUsername()?.toLowerCase();
    if (localKey && localKey === edited.name.toLowerCase()) {
      saveLocalUsername("");
      if (typeof localStorage !== "undefined")
        localStorage.removeItem("isomux-username");
      onSwitchUser(null);
    }
    setSelection(null);
  };

  if (
    selectedUser &&
    isFullUserView(selectedUser) &&
    selectedUser.id !== selfUserId
  ) {
    return (
      <UserEditPanel
        key={selectedUser.id}
        user={selectedUser}
        isMobile={isMobile}
        part={selection?.kind === "user" ? selection.part : undefined}
        onPart={selectPart}
        closeRef={detailCloseRef}
        onClose={() => setSelection(null)}
        onRenamed={onRenamedFor(selectedUser)}
        onDeleted={onDeletedFor(selectedUser)}
      >
        {(view) => itemPage(`user:${selectedUser.id}`, selectedUser.name, view)}
      </UserEditPanel>
    );
  }

  // A section that saves lays itself out (SettingsFormLayout): its fields in
  // the section's padded column and its footer across the pane. Owner-only
  // sections render null for members (unreachable via the sidebar, which only
  // offers "devices" to them). A pane that holds unsaved form state registers
  // into detailCloseRef, so navigating away routes through its own discard
  // prompt.
  const formPane =
    selection?.kind !== "section" ? null : selection.section === "access" &&
      isOwner ? (
      <ExternalAccessPane closeRef={detailCloseRef} />
    ) : selection.section === "prefs" && sessionContext ? (
      <PreferencesPane closeRef={detailCloseRef} />
    ) : selection.section === "office" ? (
      <OfficePane closeRef={detailCloseRef} />
    ) : selection.section === "deviceLabel" ? (
      <DevicePane closeRef={detailCloseRef} />
    ) : selection.section === "recording" ? (
      <RecordingPane closeRef={detailCloseRef} />
    ) : selection.section === "storage" && isOwner ? (
      <StoragePane closeRef={detailCloseRef} />
    ) : null;

  const sectionDetail = (
    <>
      {formPane ? (
        formPane
      ) : selection?.kind === "section" ? (
        <div
          style={{
            ...settingsSectionBox(isMobile),
            paddingTop:
              isMobile && selection.section === "usage"
                ? `max(16px, ${PHONE_TOP})`
                : undefined,
          }}
        >
          {selection.section === "invites" && isOwner ? (
            <InvitesPane />
          ) : selection.section === "sessions" && isOwner ? (
            <SessionsPane />
          ) : selection.section === "signInLinks" && sessionContext ? (
            <MyDevicesPane />
          ) : selection.section === "newDevice" && sessionContext ? (
            <NewDevicePane />
          ) : selection.section === "enterprise" && isOwner ? (
            <EnterprisePane />
          ) : selection.section === "usage" ? (
            <UsagePane />
          ) : selection.section === "audit" && isOwner ? (
            <AuditPane />
          ) : selection.section === "move" && isOwner ? (
            <OfficeMovePane />
          ) : selection.section === "updates" ? (
            <UpdatePane onClose={() => leaveEdit(() => onClose())} />
          ) : selection.section === "theme" ? (
            <ThemePane />
          ) : null}
        </div>
      ) : selection?.kind === "removedMembers" && isOwner ? (
        <div
          style={{
            padding: isMobile ? "0 16px 24px" : "0 24px 24px",
            maxWidth: 720,
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <RemovedMembersPane onRestored={(id) => show({ kind: "user", id })} />
        </div>
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
          {t("settings.selectHint")}
        </div>
      )}
    </>
  );

  // The Settings list page is one element for every state that is not a
  // drill-in, so the list column never mounts again under an open pane.
  // Your own member form lives in the pane while one of your rows is open,
  // and hands its parts and their dots up to the list (SelfPartsReport).
  return listPage(
    renderList(),
    selfEditable && selfOpen ? (
      <UserEditPanel
        key={selfEditable.id}
        user={selfEditable}
        isMobile={isMobile}
        // Your own rows always name a part: they are not a drill-in.
        part={(selection?.kind === "user" && selection.part) || "general"}
        onPart={selectPart}
        closeRef={detailCloseRef}
        onClose={() => setSelection(null)}
        onRenamed={onRenamedFor(selfEditable)}
        onDeleted={onDeletedFor(selfEditable)}
      >
        {(view) => (
          <>
            <SelfPartsReport
              parts={view.parts}
              part={view.part}
              onReport={setSelfReport}
            />
            {view.part !== null && (
              <>
                <div
                  style={{
                    flex: 1,
                    padding: isMobile ? "14px 16px 24px" : "20px 24px 24px",
                    maxWidth: 720,
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                >
                  <SettingsPartBody part={view.part}>
                    {view.body}
                  </SettingsPartBody>
                </div>
                {view.footer}
              </>
            )}
          </>
        )}
      </UserEditPanel>
    ) : (
      sectionDetail
    ),
  );
}

// Your own form's part rows: the parts, their labels and dots, and the open
// one.
type SelfParts = {
  parts: { id: MemberPart; label: string; dirty: boolean }[];
  part: MemberPart | null;
};

// Hands your own form's part rows up to the Settings list, which draws them
// as rows of the You group: the list is the form's parent's, not the
// form's. Reports only a change, and nothing once the form is gone.
function SelfPartsReport({
  parts,
  part,
  onReport,
}: SelfParts & { onReport: (report: SelfParts | null) => void }) {
  const signature = JSON.stringify({ parts, part });
  useEffect(() => {
    onReport(JSON.parse(signature) as SelfParts);
  }, [signature, onReport]);
  useEffect(() => () => onReport(null), [onReport]);
  return null;
}

function newMemberRecord(): UserRecord {
  return {
    id: "",
    name: "",
    notifRooms: [],
    createdAt: 0,
    role: "member",
    // A random palette color, as the server's per-id default would be.
    avatarColor:
      GHOST_COLOR_PALETTE[
        Math.floor(Math.random() * GHOST_COLOR_PALETTE.length)
      ],
    avatarVariant: "classic",
    allowedRooms: [],
    hidden: [],
    order: [],
    tucked: [],
    pushRooms: [],
    memberPrompt: null,
    language: null,
  };
}

const NO_ROOM_IDS: string[] = [];
const NO_PINS: string[] = [];

// Rooms table layout, one grid for the header and every room row: an edge
// gutter, the room name, one track per checkbox column, an edge gutter. A
// checkbox column has its full width when there is room and narrows to its
// header on a narrow screen; the room name keeps at least ROOM_NAME_MIN_PX.
const ROOM_NAME_MIN_PX = 88;
// Fits the view control's five step names side by side.
const VIEW_COLUMN_PX = 230;
function roomTableColumns(columnWidths: number[]): string {
  return [
    "12px",
    `minmax(${ROOM_NAME_MIN_PX}px, 1fr)`,
    ...columnWidths.map((w) => `minmax(min-content, ${w}px)`),
    "12px",
  ].join(" ");
}
const roomColumnHeader: React.CSSProperties = {
  textAlign: "center",
  padding: "4px 2px 6px",
};

// The same ids in the same order.
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameRoomSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const id of a) if (!setB.has(id)) return false;
  return true;
}

// The tab bar's order: the rooms in `order` first, then every other room in
// the order it arrived (the office order).
function roomsInMemberOrder<T extends { id: string }>(
  rooms: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (room: T, i: number) => rank.get(room.id) ?? order.length + i;
  return rooms
    .map((room, i) => ({ room, key: at(room, i) }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.room);
}

// One-line roster summary under the user's name. Replaces the
// old rooms/env/profile line, which truncated into invisibility and answered
// nothing anyone asked; this one answers "are they here, and if not, when
// were they last?". Kept short enough to never ellipsize at sidebar width.
// `stats` is non-null only for OWNER viewers (session count / last-seen are
// owner-only signals); everyone else gets a bare "online" or, when offline,
// no line at all - same as the old public-view behavior.
// `pending` (owner viewers only) marks an owner-created member who has not
// accepted a sign-in link yet.
function summarizeRoster(
  online: boolean,
  stats: { count: number; lastSeenAt: number } | null,
  pending: boolean,
  i18n: UiTranslator,
): string {
  const { t, tn } = i18n;
  if (online) {
    if (!stats) return t("settings.members.online");
    return tn("settings.members.onlineSessions", stats.count);
  }
  if (pending) return t("settings.members.neverSignedIn");
  if (!stats) return "";
  return t("settings.members.lastSeen", {
    when: formatSince(i18n, stats.lastSeenAt),
  });
}

// An office owner's view of one member's API tokens. Revoke has the effect of
// the member's own revoke. Keyed on the username at the call site, like
// MemberVariableNames.
function MemberApiTokens({ username }: { username: string }) {
  // The owner reaches every room, so their rooms name any token room.
  const rooms = useMemberRooms();
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ApiTokenWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/users/${encodeURIComponent(username)}/api-tokens`;

  useEffect(() => {
    let live = true;
    apiFetch<ApiTokenListRes>("GET", path)
      .then((res) => {
        if (!live) return;
        // A body without the array is a broken read, not an empty list.
        if (Array.isArray(res.apiTokens)) setTokens(res.apiTokens);
        else setError(t("settings.apiTokens.loadFailed"));
      })
      .catch(() => {
        if (live) setError(t("settings.apiTokens.loadFailed"));
      });
    return () => {
      live = false;
    };
    // The catalog only words the error; a language change is no reason to
    // refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function revoke(id: string) {
    setError(null);
    apiFetch<void>("DELETE", `${path}/${encodeURIComponent(id)}`)
      .then(() =>
        setTokens(
          (current) => current?.filter((token) => token.id !== id) ?? null,
        ),
      )
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.apiTokens.revokeFailed"),
        ),
      );
  }

  return (
    <>
      <h5 style={sectionTitleStyle}>{t("settings.memberApiTokens.title")}</h5>
      <p style={sectionHintStyle}>{t("settings.memberApiTokens.hint")}</p>
      {error && (
        <p style={{ ...sectionHintStyle, color: "var(--red-text)" }}>{error}</p>
      )}
      {tokens === null ? (
        !error && <p style={sectionHintStyle}>{t("common.loading")}</p>
      ) : tokens.length === 0 ? (
        <p style={sectionHintStyle}>{t("settings.apiTokens.empty")}</p>
      ) : (
        <div style={{ marginTop: 10 }}>
          <ApiTokenCards tokens={tokens} onRevoke={revoke} rooms={rooms} />
        </div>
      )}
    </>
  );
}

type UserEditPanelProps = {
  user: UserRecord;
  // Create mode: `user` is a blank draft, Save creates the member
  // (POST /api/users) and hands the new id to onCreated. Sections that need a
  // stored record (memory, variable names, delete) are hidden until then.
  creating?: boolean;
  isMobile: boolean;
  onClose: () => void;
  onRenamed?: (newName: string) => void;
  onDeleted?: () => void;
  onCreated?: (id: string) => void;
  // Parent (UserSettingsView) calls `closeRef.current(after?)` when it wants
  // to navigate away from the currently-edited user (switch selection, close
  // the page, ESC, mobile back). The panel decides whether to gate on a
  // "Discard unsaved changes?" confirmation. The optional `after` runs once
  // the close is committed - used by the parent to chain "discard then select
  // Y" / "discard then close the page". Same pattern as TaskView's closeRef.
  closeRef?: React.MutableRefObject<((after?: () => void) => void) | null>;
  // The open part (task 1f79f2e3): absent, the first part on a desktop and
  // the part list on a phone; null, the part list.
  part: MemberPart | null | undefined;
  onPart: (part: MemberPart | null) => void;
  // Settings draws the member's parts: drilled in for another member, as
  // You rows for yourself.
  children: (view: SettingsItemView<MemberPart>) => React.ReactNode;
};

// A member's settings, as parts. One form across every part: moving between
// them keeps it mounted, and the one Save writes every part. Cancel and
// Discard set every field back to the saved record, in place, so the
// Settings list it draws for yourself does not mount again.
function UserEditPanel({
  user,
  creating = false,
  isMobile,
  onClose,
  onRenamed,
  onDeleted,
  onCreated,
  closeRef,
  part,
  onPart,
  children,
}: UserEditPanelProps) {
  const { rooms, allRooms, sessionContext, agents, users } = useAppState();
  const { t } = useI18n();
  // Owner-only fields: role and allowedRooms. The server rejects
  // changes to those fields from non-owner sessions even on self-edit,
  // but we also hide the editor here so members don't see disabled
  // controls they can't use.
  const isOwner = sessionContext?.role === "owner";
  // Self-edit vs owner-editing-another. Notifications are
  // SELF-only (view.*), so they render only when isMe; an owner editing a
  // member manages record fields + access, not their prefs.
  const isMe = !creating && sessionContext?.userId === user.id;
  // The TARGET's access is rule-based for owners (they reach every room without
  // materialized grants), literal allowedRooms for members. Drives the self-pref
  // rendering (Notifications) and whether a save writes grants.
  const targetIsOwner = user.role === "owner";
  const [officeOwner, setOfficeOwner] = useState(targetIsOwner);
  // Whose access the Rooms table edits: the drafted role (task 2c57281c), so
  // a demote picks the member's rooms in the same save.
  const ownerTarget = officeOwner;
  // Use the unfiltered global rooms list when available so the owner
  // can manage other users' access to rooms they've hidden from their
  // own view, and so the Notifications list reflects every room the
  // target user might actually see. Members fall back to their
  // projected `rooms` (which already match what they can see).
  const editorRooms = ordinaryRooms(allRooms.length > 0 ? allRooms : rooms);
  const [name, setName] = useState(user.name);
  const [notifSetting, setNotifSetting] = useState<NotifRoomsSetting>(
    user.notifRooms,
  );
  // Like tucked below: a tuck made in the tab bar also drops the room's
  // notifications on the server, so the change lands here when the member
  // has not edited the column.
  const [notifBase, setNotifBase] = useState<NotifRoomsSetting>(
    user.notifRooms,
  );
  if (!sameRoomSet(notifBase, user.notifRooms)) {
    setNotifBase(user.notifRooms);
    if (sameRoomSet(notifSetting, notifBase)) setNotifSetting(user.notifRooms);
  }
  const [allowedSetting, setAllowedSetting] = useState<string[]>(
    user.allowedRooms,
  );
  // The member's permission pack (task 134b8f77); null is full access.
  const [packSetting, setPackSetting] = useState<MemberPack | null>(
    user.pack ?? null,
  );
  // "Show tool calls" (task e7579473) and "Show messages between agents"
  // (task d5c0f33d): an owner sets them for another member and in the New
  // member form; the member's own are in their Settings pane.
  const editsShowToolCalls = isOwner && !isMe;
  const [showToolCalls, setShowToolCalls] = useState(
    user.showToolCalls === true,
  );
  const showToolCallsChanged =
    editsShowToolCalls && showToolCalls !== (user.showToolCalls === true);
  const [showAgentMessages, setShowAgentMessages] = useState(
    user.showAgentMessages === true,
  );
  const showAgentMessagesChanged =
    editsShowToolCalls &&
    showAgentMessages !== (user.showAgentMessages === true);
  const chatChanged = showToolCallsChanged || showAgentMessagesChanged;
  // The level the draft left when an edit made it Custom; feeds the legend.
  const [startedFrom, setStartedFrom] = useState<MemberLevel | null>(null);
  // Per-user DISPLAY preference: room ids the user has hidden
  // from their own view. SELF-only, like notifications - an owner editing a
  // member manages access, not their view. Saved as the complement (the
  // "shown" list) via PUT /api/me/view/shown. Access holds the view, and the
  // view is one ordered level per room (shared/room-view-level.ts).
  const [hiddenSetting, setHiddenSetting] = useState<string[]>(user.hidden);
  // Rooms tucked into the tab bar's overflow chip. The bar writes the same
  // field, so a tuck made there while this form is open lands here when the
  // member has not edited the column. A record from a server older than
  // this field has no `tucked`.
  const userTucked = user.tucked ?? NO_ROOM_IDS;
  const [tuckedSetting, setTuckedSetting] = useState<string[]>(userTucked);
  const [tuckedBase, setTuckedBase] = useState<string[]>(userTucked);
  if (!sameRoomSet(tuckedBase, userTucked)) {
    setTuckedBase(userTucked);
    if (sameRoomSet(tuckedSetting, tuckedBase)) setTuckedSetting(userTucked);
  }
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
  // view column could never offer re-showing one. GET /api/me/rooms
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
  // An owner sets up another member's sidebar Pinned list (task 35596be5).
  // Like tucked: a pin the member makes meanwhile lands here when the owner
  // has not edited the list; once they have, their draft wins at Save.
  // The lists compare on the entries the owner can name: an owner sees every
  // agent and member, so another entry is dead, and the server drops it at
  // the next write. A saved list with a dead entry thus reads clean, and
  // still adopts a pin the member makes after the save.
  const editsPins = isOwner && !isMe && !creating;
  const userPins = user.pinnedAgents ?? NO_PINS;
  const nameablePins = new Set([
    ...agents.map((a) => a.id),
    ...[...users.values()]
      .filter((u) => u.id !== user.id)
      .map((u) => memberPinKey(u.id)),
  ]);
  const samePins = (a: readonly string[], b: readonly string[]) =>
    sameList(
      a.filter((key) => nameablePins.has(key)),
      b.filter((key) => nameablePins.has(key)),
    );
  const [pinsSetting, setPinsSetting] = useState<string[]>(userPins);
  const [pinsBase, setPinsBase] = useState<string[]>(userPins);
  if (!sameList(pinsBase, userPins)) {
    setPinsBase(userPins);
    if (samePins(pinsSetting, pinsBase)) setPinsSetting(userPins);
  }
  const pinsChanged = editsPins && !samePins(pinsSetting, userPins);
  // Rooms whose turn ends push to the member's devices (the Push level).
  // Like tucked: the room settings pane writes the same field, so a change
  // saved there lands here when the member has not edited the column.
  const userPush = user.pushRooms ?? NO_ROOM_IDS;
  const [pushSetting, setPushSetting] = useState<string[]>(userPush);
  const [pushBase, setPushBase] = useState<string[]>(userPush);
  if (!sameRoomSet(pushBase, userPush)) {
    setPushBase(userPush);
    if (sameRoomSet(pushSetting, pushBase)) setPushSetting(userPush);
  }
  // Rows of the Rooms table - RENDERING only; the destructive shown-complement
  // written on save is computed from a fresh /api/me/rooms read in handleSave,
  // never from these rows. Owner viewers: the unfiltered global list (they
  // manage access to every room). Member self-edit: the fetched accessible
  // list, falling back to the projected rooms until it lands.
  const rowsForPrefs: { id: string; name: string }[] = roomsInMemberOrder(
    !isOwner && isMe ? (meRooms ?? editorRooms) : editorRooms,
    // The viewer's own tab order, also when an owner edits another member.
    rooms.map((r) => r.id),
  );
  // A row's drafted view level. A room without access reads as hidden, and
  // its control is locked.
  function draftLevel(roomId: string): RoomViewLevel {
    if (!accessibleForPrefs.includes(roomId)) return "hidden";
    return roomViewLevel(
      {
        hidden: hiddenSetting,
        tucked: tuckedSetting,
        notifRooms: notifSetting,
        pushRooms: pushSetting,
      },
      roomId,
    );
  }
  const anyPush = rowsForPrefs.some((r) => draftLevel(r.id) === "push");
  const [memberPrompt, setMemberPrompt] = useState<string>(
    user.memberPrompt ?? "",
  );
  // Keep the version tied to the draft's baseline, never a live WS refresh.
  const [promptBaseline, setPromptBaseline] = useState(user.memberPrompt ?? "");
  const [promptVersion, setPromptVersion] = useState(() =>
    versionOf(user.memberPrompt ?? ""),
  );
  const [promptConflict, setPromptConflict] = useState<InstructionsRes | null>(
    null,
  );
  // Member-scoped memory for this user, edited via the unified /api/memory verbs
  // (load + version-guarded save), keyed by the stable userId so it survives a
  // rename. Saved separately from the user PATCH.
  const mem = useMemoryEditor("member", user.id, !creating);
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
  // A save succeeded since the page opened: the footer reads Saved while the
  // form equals what was saved.
  const [savedHere, setSavedHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Holds the server's lockout-prevention reason if delete_user is refused.
  // Same shape as the logout_blocked / revoke_blocked surfaces elsewhere -
  // shown inline next to Delete so the member sees why the row didn't go.
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
          err instanceof ApiError
            ? err.message
            : t("settings.profile.deleteFailed"),
        );
        setConfirmDelete(false);
      });
  }

  // One room's view level sets its entry in all four lists at once
  // (shared/room-view-level.ts). The server holds the same invariant
  // (clampViewFields).
  function setRoomLevel(roomId: string, level: RoomViewLevel) {
    const next = withRoomViewLevel(
      {
        hidden: hiddenSetting,
        tucked: tuckedSetting,
        notifRooms: notifSetting,
        pushRooms: pushSetting,
      },
      roomId,
      level,
    );
    setHiddenSetting(next.hidden);
    setTuckedSetting(next.tucked);
    setNotifSetting(next.notifRooms);
    setPushSetting(next.pushRooms);
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

  // The fields that hold an unsaved edit. The parts' dots read them through
  // MEMBER_FIELD_PART (ui/settings-parts.ts).
  function dirtyFields(): MemberField[] {
    const fields: MemberField[] = [];
    if (isOwner && officeOwner !== targetIsOwner) fields.push("role");
    // Name is trim-saved (see handleSave), so compare trimmed to avoid
    // false-positive dirtiness on trailing whitespace the user can't see.
    if (name.trim() !== user.name) fields.push("name");
    if ((memberPrompt.trim() || null) !== (promptBaseline || null))
      fields.push("prompt");
    if (mem.dirty) fields.push("memory");
    if (
      avatarColor !== user.avatarColor ||
      avatarVariant !== user.avatarVariant
    )
      fields.push("avatar");
    // A drafted owner has no room grants and no pack.
    if (!officeOwner && !sameRoomSet(allowedSetting, user.allowedRooms))
      fields.push("allowedRooms");
    if (isOwner && !officeOwner && !samePack(packSetting, user.pack))
      fields.push("pack");
    if (
      !sameRoomSet(notifSetting, user.notifRooms) ||
      (isMe &&
        (!sameRoomSet(hiddenSetting, user.hidden) ||
          !sameRoomSet(tuckedSetting, userTucked) ||
          !sameRoomSet(pushSetting, userPush)))
    )
      fields.push("roomView");
    if (!creating && showToolCallsChanged) fields.push("showToolCalls");
    if (!creating && showAgentMessagesChanged) fields.push("showAgentMessages");
    if (pinsChanged) fields.push("pins");
    return fields;
  }
  function isDirty(): boolean {
    return dirtyFields().length > 0;
  }

  // Parent-driven close path (closeRef) and the panel's own Cancel. A clean
  // form runs onClose + after at once; a dirty one shows the "Discard unsaved
  // changes?" prompt and stashes `after` - e.g. "select user Y" or "close the
  // page" - for Discard, or for a save that finishes while the prompt is open.
  // Every field back to the saved record.
  function revert() {
    setOfficeOwner(targetIsOwner);
    setName(user.name);
    setNotifSetting(user.notifRooms);
    setAllowedSetting(user.allowedRooms);
    setPackSetting(user.pack ?? null);
    setShowToolCalls(user.showToolCalls === true);
    setShowAgentMessages(user.showAgentMessages === true);
    setStartedFrom(null);
    setHiddenSetting(user.hidden);
    setTuckedSetting(userTucked);
    setPinsSetting(userPins);
    setPushSetting(userPush);
    setMemberPrompt(promptBaseline);
    setPromptConflict(null);
    mem.reset();
    setAvatarColor(user.avatarColor);
    setAvatarVariant(user.avatarVariant);
    setError(null);
    setConfirmDelete(false);
    setDeleteBlockedReason(null);
  }

  const discardPrompt = useUnsavedChangesPrompt(isDirty(), {
    closeRef,
    onDiscard: revert,
    onLeave: onClose,
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
    if (creating) {
      void handleCreate(trimmed);
      return;
    }
    setSaving(true);
    setError(null);
    const renamed = trimmed !== user.name;
    const origName = user.name; // URL target BEFORE any rename takes effect
    const normalizedColor = isHexColor(avatarColor)
      ? normalizeHexColor(avatarColor)
      : user.avatarColor;
    const memoryChanged = mem.dirty;
    const promptChanged =
      (memberPrompt.trim() || null) !== (promptBaseline || null);
    const recordChanged =
      (isOwner && officeOwner !== targetIsOwner) ||
      renamed ||
      normalizedColor !== user.avatarColor ||
      avatarVariant !== user.avatarVariant;
    // The field the write in flight carries: a refusal opens its part.
    let writing: MemberField | null = null;
    const refuse = (message: string, field: MemberField | null) => {
      setError(message);
      if (field !== null) onPart(MEMBER_FIELD_PART[field]);
    };
    try {
      // The update_user split is sequenced to preserve the WS atomicity
      // guarantees and dodge the rename->404. (1) Owner access change FIRST,
      // against the ORIGINAL username, so a combined rename + grant doesn't 404
      // the access PUT after the record renames; setAccess prune-clamps the
      // target's notif/default server-side in one write. A role change
      // carries the pack and rooms in its PATCH instead (task 2c57281c): a
      // demote is one write, and a promotion writes no grants.
      const roleChanged = isOwner && officeOwner !== targetIsOwner;
      const packChanged =
        isOwner && !officeOwner && !samePack(packSetting, user.pack);
      const roomsChanged =
        !officeOwner && !sameRoomSet(allowedSetting, user.allowedRooms);
      if (
        isOwner &&
        !targetIsOwner &&
        !roleChanged &&
        (packChanged || roomsChanged)
      ) {
        // Owners are rule-based (no materialized grants), so an owner target
        // never writes allowedRooms - only a member's access is editable here.
        writing = packChanged ? "pack" : "allowedRooms";
        await apiFetch(
          "PUT",
          `/api/users/${encodeURIComponent(origName)}/access`,
          {
            allowedRooms: allowedSetting,
            ...(packChanged ? { pack: packSetting } : {}),
          },
        );
      }
      // (1b) The instructions, against the original name, before a rename can
      // move the route. The answer carries the stored text and its version.
      if (promptChanged) {
        writing = "prompt";
        const body: InstructionsReq = {
          instructions: memberPrompt.trim() || null,
          version: promptVersion,
        };
        const saved = await apiFetch<InstructionsRes>(
          "PUT",
          `/api/users/${encodeURIComponent(origName)}/instructions`,
          body,
        );
        setPromptBaseline(saved.instructions ?? "");
        setPromptVersion(saved.version);
        setPromptConflict(null);
      }
      // (1c) The member's chat choices that changed, against the original
      // name.
      if (chatChanged) {
        writing = showToolCallsChanged ? "showToolCalls" : "showAgentMessages";
        await apiFetch(
          "PATCH",
          `/api/users/${encodeURIComponent(origName)}/chat`,
          {
            ...(showToolCallsChanged ? { showToolCalls } : {}),
            ...(showAgentMessagesChanged ? { showAgentMessages } : {}),
          },
        );
      }
      // (1d) The member's Pinned list, against the original name.
      if (pinsChanged) {
        writing = "pins";
        const body: PinnedReq = { pinned: pinsSetting };
        await apiFetch(
          "PUT",
          `/api/users/${encodeURIComponent(origName)}/pinned`,
          body,
        );
      }
      // (2) Record fields (name/avatar), against the original name.
      if (recordChanged) {
        writing = renamed ? "name" : roleChanged ? "role" : "avatar";
        await apiFetch("PATCH", `/api/users/${encodeURIComponent(origName)}`, {
          role: roleChanged ? (officeOwner ? "owner" : "member") : undefined,
          name: renamed ? trimmed : undefined,
          avatarColor: normalizedColor,
          avatarVariant,
          // A demote: the pack (none is Full access) and the rooms.
          ...(roleChanged && !officeOwner && packSetting
            ? { pack: packSetting }
            : {}),
          ...(roleChanged && roomsChanged
            ? { allowedRooms: allowedSetting }
            : {}),
        });
      }
      // (2b) Member memory is a separate version-guarded REPLACE keyed by the stable
      // userId (rename-safe). A 409 means it changed under us - surface + keep open.
      if (memoryChanged) {
        const m = await mem.save();
        if (!m.ok) {
          refuse(m.message, "memory");
          return;
        }
      }
      writing = "roomView";
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
          refuse(t("settings.profile.roomListFailed"), "roomView");
          return;
        }
        await apiFetch("PUT", "/api/me/view/shown", {
          shown: accessibleNow
            .filter((r) => !hiddenSetting.includes(r.id))
            .map((r) => r.id),
        });
      }
      // Tucked before notifications: the server drops a tucked room's
      // notifications, so an untuck must land first.
      if (isMe && !sameRoomSet(tuckedSetting, userTucked)) {
        await apiFetch("PUT", "/api/me/view/tucked", {
          tucked: tuckedSetting,
        });
      }
      // notif-rooms takes the full list.
      if (isMe && !sameRoomSet(notifSetting, user.notifRooms)) {
        await apiFetch("PUT", "/api/me/view/notif-rooms", {
          notifRooms: notifSetting,
        });
      }
      if (isMe && !sameRoomSet(pushSetting, userPush)) {
        await apiFetch("PUT", "/api/me/view/push-rooms", {
          pushRooms: pushSetting,
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
      setSavedHere(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict") {
        // Read the current text for comparison; keep the member's draft intact.
        try {
          const current = await apiFetch<InstructionsRes>(
            "GET",
            `/api/users/${encodeURIComponent(origName)}/instructions`,
          );
          setPromptBaseline(current.instructions ?? "");
          setPromptVersion(current.version);
          setPromptConflict(current);
          refuse(t("settings.profile.promptConflict"), "prompt");
        } catch {
          refuse(err.message, "prompt");
        }
      } else {
        refuse(
          err instanceof ApiError ? err.message : t("common.saveFailed"),
          writing,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate(trimmed: string) {
    setSaving(true);
    setError(null);
    try {
      const r = await apiFetch<{ user: UserRecord }>("POST", "/api/users", {
        name: trimmed,
        role: officeOwner ? "owner" : "member",
        instructions: memberPrompt.trim() || null,
        avatarColor: isHexColor(avatarColor)
          ? normalizeHexColor(avatarColor)
          : user.avatarColor,
        avatarVariant,
        ...(!officeOwner && allowedSetting.length > 0
          ? { allowedRooms: allowedSetting }
          : {}),
        ...(!officeOwner && packSetting ? { pack: packSetting } : {}),
        // Unticked is the default, so the body leaves it out.
        ...(showToolCalls ? { showToolCalls: true } : {}),
        ...(showAgentMessages ? { showAgentMessages: true } : {}),
      });
      onCreated?.(r.user.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.saveFailed"));
      if (err instanceof ApiError && err.code === "name_taken")
        onPart(MEMBER_FIELD_PART.name);
      setSaving(false);
    }
  }

  // Drives the footer's Cancel and Save (SettingsSaveFooter).
  const dirty = isDirty();
  // The parts with an unsaved edit, from the same field table a refused
  // save opens its part by (ui/settings-parts.ts).
  const dirtySet = dirtyParts(MEMBER_FIELD_PART, dirtyFields());
  const ids = memberParts({
    viewerIsOwner: isOwner,
    isMe,
    creating,
    targetIsOwner: officeOwner,
  });
  const open = resolvePart(part, ids, isMobile);

  const bodies: Record<MemberPart, React.ReactNode> = {
    general: (
      <>
        <h4 className="agent-settings-group-title">
          {t("settings.part.general")}
        </h4>
        <label style={subLabelStyle}>{t("settings.profile.displayName")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 32))}
          maxLength={32}
          style={{ ...inputStyle, maxWidth: 340 }}
        />

        {/* Aesthetics last: looks are secondary to the
            settings that change behavior. */}
        <h5 style={sectionTitleStyle}>{t("settings.profile.appearance")}</h5>
        <label style={subLabelStyle}>
          {t("common.avatar")}{" "}
          <span style={hintStyle}>{t("settings.profile.avatarHint")}</span>
        </label>
        <AvatarPicker
          color={avatarColor}
          variant={avatarVariant}
          onColorChange={setAvatarColor}
          onVariantChange={setAvatarVariant}
        />

        {/* The item's destructive action, at the end of its first part. */}
        {!creating && (
          <div style={{ marginTop: 24 }}>
            {confirmDelete && (
              <p
                data-delete-member-note=""
                style={{
                  margin: "0 0 8px",
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.4,
                }}
              >
                {t("settings.profile.deleteNote")}
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
                  color: "var(--red-text)",
                }}
              >
                {deleteBlockedReason}
              </p>
            )}
            <button
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              disabled={saving}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: confirmDelete
                  ? "1px solid var(--red)"
                  : filledDangerBtn.border,
                background: confirmDelete
                  ? "var(--red-text)"
                  : filledDangerBtn.background,
                color: confirmDelete ? "var(--bg-base)" : "var(--red-text)",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title={t("settings.profile.deleteHint")}
            >
              {confirmDelete ? t("common.confirmQuestion") : t("common.delete")}
            </button>
          </div>
        )}
      </>
    ),
    access: (
      <>
        {isOwner && (
          <MemberAccessControl
            owner={officeOwner}
            pack={packSetting}
            startedFrom={startedFrom}
            savedOwner={!creating && targetIsOwner}
            onChange={(next) => {
              setOfficeOwner(next.owner);
              setPackSetting(next.pack);
              setStartedFrom(next.startedFrom);
            }}
            headingStyle={sectionTitleStyle}
            disabled={saving}
          />
        )}
      </>
    ),
    osUser: (
      <>
        {isOwner && !creating && (
          <MemberOsUserSection
            username={user.name}
            headingStyle={sectionTitleStyle}
            hintStyle={sectionHintStyle}
          />
        )}
      </>
    ),
    signIn: (
      <>
        {isOwner && !creating && !isMe && (
          <PendingMemberSignInLink user={user} />
        )}
        {isOwner && !isMe && !creating && (
          <MemberApiTokens key={`tokens:${user.name}`} username={user.name} />
        )}
      </>
    ),
    rooms: (
      <>
        {/* Rooms: ONE table for the per-room settings - Access, and within
            it one view level per room (Hidden < Tucked < Shown <
            Sound < Push). Access is owner-managed on member targets; the
            view column is a SELF-only pref (owner-editing-member: Access
            only; self-edit: the view column). A member viewer only ever
            mounts this panel for themselves (canEdit), so !isOwner ⇒ isMe. */}
        {(isOwner && (!ownerTarget || isMe)) || (!isOwner && isMe) ? (
          <>
            <h5 style={sectionTitleStyle}>{t("common.rooms")}</h5>
            {isOwner && !ownerTarget && (
              <p style={sectionHintStyle}>{t("settings.profile.accessHint")}</p>
            )}
            {isMe && (
              <RoomViewLevelLegend
                style={{ marginTop: 8, fontSize: 12 }}
                push={
                  anyPush ? <PushThisDevice username={user.name} /> : undefined
                }
              />
            )}
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-base)",
                padding: "4px 0",
                marginTop: 8,
                display: "grid",
                gridTemplateColumns: roomTableColumns([
                  ...(isOwner && !ownerTarget ? [80] : []),
                  // On a phone the view control has a row of its own.
                  ...(isMe && !isMobile ? [VIEW_COLUMN_PX] : []),
                ]),
                alignItems: "center",
              }}
            >
              <div
                style={{
                  display: "contents",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                <span style={{ gridColumn: 2, padding: "4px 0 6px" }}>
                  {t("settings.profile.roomColumn")}
                </span>
                {isOwner && !ownerTarget && (
                  <span style={roomColumnHeader}>
                    {t("settings.profile.accessColumn")}
                  </span>
                )}
                {isMe && (
                  <span
                    style={{
                      ...roomColumnHeader,
                      textAlign: "left",
                      ...(isMobile && {
                        gridColumn: "2 / -2",
                        padding: "0 0 6px",
                      }),
                    }}
                  >
                    {t("settings.room.yourView")}
                  </span>
                )}
              </div>
              <div
                style={{
                  gridColumn: "1 / -1",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              />
              {rowsForPrefs.length === 0 ? (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    padding: "8px 12px",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  {t("common.noRooms")}
                </div>
              ) : (
                rowsForPrefs.map((r) => {
                  const hasAccess = accessibleForPrefs.includes(r.id);
                  const level = draftLevel(r.id);
                  return (
                    <div
                      key={r.id}
                      style={{ display: "contents", fontSize: 12 }}
                    >
                      <span
                        {...noTranslate()}
                        style={{
                          gridColumn: 2,
                          minWidth: 0,
                          padding: "6px 0",
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
                      {isOwner && !ownerTarget && (
                        <span
                          style={{
                            padding: "6px 0",
                            display: "flex",
                            justifyContent: "center",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={hasAccess}
                            onChange={() => toggleRoomAllowed(r.id)}
                            aria-label={t("settings.profile.accessTo", {
                              room: r.name,
                            })}
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
                            padding: isMobile ? "0 0 8px" : "4px 2px",
                            display: "flex",
                            minWidth: 0,
                            gridColumn: isMobile ? "2 / -2" : undefined,
                          }}
                        >
                          <RoomViewLevelControl
                            level={level}
                            onChange={(l) => {
                              // Defensive handler-level gate: the view is
                              // within access.
                              if (!hasAccess) return;
                              setRoomLevel(r.id, l);
                            }}
                            roomName={r.name}
                            disabled={!hasAccess}
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

        {editsPins && (
          <MemberPinnedAgents
            pinned={pinsSetting}
            targetUserId={user.id}
            reachableRoomIds={
              officeOwner ? null : new Set([LOBBY_ROOM_ID, ...allowedSetting])
            }
            onChange={setPinsSetting}
            disabled={saving}
            headingStyle={sectionTitleStyle}
          />
        )}
      </>
    ),
    instructions: (
      <>
        <h5 style={sectionTitleStyle}>{t("common.instructionsAndMemory")}</h5>

        <label style={subLabelStyle}>
          {t("settings.profile.profilePrompt")}{" "}
          <span style={hintStyle}>
            {t("settings.profile.profilePromptHint")}
          </span>
        </label>
        <ExpandableTextarea
          title={t("settings.profile.profilePromptTitle", {
            user: creating ? name.trim() : user.name,
          })}
          hint={t("settings.profile.profilePromptExpandedHint")}
          value={memberPrompt}
          onChange={setMemberPrompt}
          placeholder={t("settings.profile.profilePromptPlaceholder")}
          rows={5}
          recordingPrivate={`member:${creating ? "new" : user.id}:instructions`}
          style={{
            ...inputStyle,
            minHeight: 90,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.45,
          }}
        />

        {promptConflict && (
          <label style={subLabelStyle}>
            {t("settings.profile.currentPrompt")}
            <textarea
              readOnly
              {...{
                [RECORDING_PRIVATE_ATTR]: `member:${user.id}:instructions-current`,
              }}
              value={promptConflict.instructions ?? ""}
              style={{ ...inputStyle, minHeight: 90, width: "100%" }}
            />
          </label>
        )}

        {!creating && (
          <>
            <label style={subLabelStyle}>
              {t("common.memory")}{" "}
              <span style={hintStyle}>
                {t("settings.profile.memoryHint", {
                  size: mem.loaded ? mem.size : "…",
                  cap: mem.cap ?? "…",
                })}
              </span>
            </label>
            <ExpandableTextarea
              title={t("settings.profile.memoryTitle", { user: user.name })}
              hint={t("common.memoryEditorHint")}
              status={t("common.memorySize", {
                size: mem.loaded ? mem.size : "…",
                cap: mem.cap ?? "…",
              })}
              value={mem.memory}
              onChange={mem.setMemory}
              placeholder={
                mem.loaded
                  ? t("settings.profile.memoryPlaceholder")
                  : t("common.loadingMemory")
              }
              recordingPrivate={`member:${user.id}:memory`}
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
          </>
        )}
      </>
    ),
    chat: (
      <>
        {editsShowToolCalls && (
          <>
            <h5 style={sectionTitleStyle}>{t("settings.profile.chat")}</h5>
            <ChatChoiceBox
              choice="showToolCalls"
              checked={showToolCalls}
              onChange={setShowToolCalls}
            />
            <div style={{ marginTop: 12 }}>
              <ChatChoiceBox
                choice="showAgentMessages"
                checked={showAgentMessages}
                onChange={setShowAgentMessages}
              />
            </div>
          </>
        )}
      </>
    ),
  };

  return children({
    parts: ids.map((id) => ({
      id,
      label: memberPartLabel(t, id),
      dirty: dirtySet.has(id),
    })),
    part: open,
    subtitle: creating ? (
      t("settings.members.newMember")
    ) : (
      <span {...noTranslate()}>{user.name}</span>
    ),
    body: open === null ? null : bodies[open],
    footer: (
      <SettingsSaveFooter
        error={error}
        prompt={discardPrompt}
        dirty={dirty}
        saving={saving}
        saved={savedHere}
        canSave={!!name.trim()}
        // Cancel throws the edits away and stays, as on the room and agent
        // parts; the back row and the header's close leave.
        onCancel={revert}
        onSave={() => void handleSave()}
        saveLabel={creating ? t("settings.members.create") : undefined}
      />
    ),
    prompt: discardPrompt,
    busy: saving,
  });
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
  const { t } = useI18n();
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
        color: isOwner ? "var(--accent-text)" : "var(--text-ghost)",
        background: "transparent",
        flexShrink: 0,
      }}
      title={
        isOwner ? t("settings.role.ownerHint") : t("settings.role.memberHint")
      }
    >
      {isOwner ? t("settings.role.owner") : t("settings.role.member")}
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

// Section headers inside the user editor: a titled rule that groups the
// fields the old modal ran together in one long column.
const sectionTitleStyle: React.CSSProperties = settingsSectionTitle;
const sectionHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  margin: "6px 0 0",
  lineHeight: 1.4,
};
const subLabelStyle: React.CSSProperties = { ...dialogLabel, marginTop: 12 };
const hintStyle: React.CSSProperties = dialogHint;
const inputStyle: React.CSSProperties = dialogInput;
