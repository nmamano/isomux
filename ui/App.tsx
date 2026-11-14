import { ordinaryRooms } from "../shared/types.ts";
import { LinkedImageLightbox } from "./log-view/attachment-download.tsx";
import { LogPrefetcher } from "./log-prefetch.ts";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRecordingRules } from "./hooks/useRecordingRules.ts";
import {
  useAppState,
  useDispatch,
  useFeatures,
  useRoomList,
} from "./store.tsx";
import { send } from "./ws.ts";
import {
  loadSavedView,
  loadUserDraftAttachments,
  loadUserDrafts,
  pruneUserDraftAttachments,
  pruneUserDrafts,
  pruneUserFoldedAsks,
  saveDraft,
  saveDraftAttachments,
  saveView,
} from "./view-persistence.ts";
import { OfficeView, type ViewportControls } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import {
  asDraftAttachments,
  type DraftAttachment,
} from "./log-view/draft-attachments.ts";
import { restoreOutbox } from "./log-view/outbox.ts";
import { ContextMenu } from "./components/ContextMenu.tsx";
import {
  EditAgentDialog,
  type AgentSettingsSection,
} from "./components/EditAgentDialog.tsx";
import {
  UserSettingsView,
  type Selection as SettingsTarget,
} from "./components/UserSettingsView.tsx";
import { TaskView, type TaskOpenRequest } from "./components/TaskView.tsx";
import { CronjobsView } from "./components/CronjobsView.tsx";
import { AppsView } from "./components/AppsView.tsx";
import { SkillsView } from "./components/SkillsView.tsx";
import {
  IntegrationsView,
  type IntegrationsRequest,
} from "./integrations/IntegrationsView.tsx";
import { AsksView } from "./components/AsksView.tsx";
import { InboxView } from "./components/InboxView.tsx";
import { AgentChatPanel } from "./components/AgentChatPanel.tsx";
import { ChatSidebar, type SidebarPage } from "./components/ChatSidebar.tsx";
import { PhoneSidebarDrawer } from "./components/PhoneSidebarDrawer.tsx";
import { SidebarSlot } from "./components/SidebarSlot.tsx";
import { useSidebarPins } from "./sidebar-pins.ts";
import { newAgentSeat, sidebarStartsOpen } from "./chat-sidebar.ts";
import { PageLeaveGuard, type LeaveGuard } from "./page-leave-guard.ts";
import {
  askIdForPage,
  documentTitle,
  syncAppBadge,
  useInboxCounts,
} from "./inbox.ts";
import { useAsksSync, useOthersAsksSync } from "./asks-sync.ts";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { UpdateOverlay } from "./components/UpdateOverlay.tsx";
import { UiBuildNotice } from "./components/UiBuildNotice.tsx";
import { CSS, OFFICE_PAGE_CSS } from "./styles.ts";
import {
  getUsername,
  getDevice,
  getChatSidebar,
  setChatSidebar,
} from "./device-settings.ts";
import { languageSeed } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";
import { apiFetch } from "./api.ts";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import { agentTabLabel } from "./agent-face.ts";
import { LOBBY_ROOM_ID, type AgentInfo } from "../shared/types.ts";
import { swipeTarget } from "./office/room-cycle.ts";
import { isValidDesk, isBackSeat, hasBackRoom } from "../shared/desks.ts";
import { cycleAgent } from "./agent-cycle.ts";
import {
  pageForLocation,
  pageForPath,
  agentIdForPath,
  askIdForPath,
  pagerIdForSearch,
  mcpSignInForSearch,
  integrationsTabForPath,
  pathForPage,
  presencePageFor,
  pageShortcut,
  backRoomShortcut,
  createLoneShiftTracker,
  type Page,
} from "./routes.ts";
import {
  pageStackAfter,
  pageUnder,
  topPage,
  type PageStack,
  type PageStackAction,
} from "./page-stack.ts";
import { OfficeLinkOpener } from "./office-link.tsx";
import { AskSignInResult, type AskSignIn } from "./log-view/ask-sign-in.ts";
import { TaskOpener } from "./log-view/task-links.tsx";
import { AskRefsProvider } from "./log-view/ask-refs.tsx";
import { TaskLookupBridge } from "./task-lookup.ts";
import type { OfficeLink } from "../shared/office-links.ts";
import { useCan } from "./hooks/useCan.ts";
import {
  humanChatForPath,
  humanChatId,
  MEMBERS_CHAT,
  type HumanChatKey,
} from "./human-chat.ts";
import { HumanChatView } from "./members-chat/HumanChatView.tsx";

/**
 * The page a history entry names, `null` for an entry that means the office,
 * and `undefined` for an entry we cannot read - one from an older build, one
 * pushed by something else on the page, or one whose page value is not a route
 * any more. `undefined` is the caller's signal to fall back to the pathname
 * rather than trust the entry.
 */
function pageFromEntry(state: unknown): Page | null | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const entry = state as { isomux?: unknown; page?: unknown };
  if (entry.isomux !== true) return undefined;
  if (entry.page === null) return null;
  return entry.page === "tasks" ||
    entry.page === "cronjobs" ||
    entry.page === "apps" ||
    entry.page === "skills" ||
    entry.page === "integrations" ||
    entry.page === "settings" ||
    entry.page === "asks"
    ? entry.page
    : // The Inbox's Pages tab until pages became asks (task 74e8fc07).
      entry.page === "pager"
      ? "asks"
      : undefined;
}

/**
 * `routing` is how the app is DEPLOYED, not something it can work out for
 * itself. The office owns its origin's root, so its full-page views are
 * real URLs. The landing demo serves this same App under /demo
 * (ui/demo-entry.tsx, built to site/demo/), where writing "/tasks" would name a
 * public URL that does not exist - so it passes false and keeps the pre-routing
 * behaviour: entries are still pushed, without a path. Giving the demo real
 * routes is its own slice.
 */
export function App({ routing = true }: { routing?: boolean }) {
  useRecordingRules();
  const {
    agents,
    logs,
    focusedAgentId,
    drafts,
    draftAttachments,
    currentRoomId,
    rooms: allRooms,
    office,
    connected,
    sessionContext,
    hasReceivedInitialState,
    lobbyOpen,
    rideArrival,
    isMobile,
    openHumanChat,
  } = useAppState();
  const features = useFeatures();
  const rooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  const roomCount = rooms.length;
  const dispatch = useDispatch();
  // Clicking an empty slot opens the complete spawn form. Engine is one of its
  // fields, so the user can configure the agent in either order.
  const [spawnPickerDesk, setSpawnPickerDesk] = useState<number | null>(null);
  // A member with a permission pack spawns only with agentManagement write.
  const canSpawn = useCan("agentManagement", "write");
  // The spawn dialog for a back room seat (the back screen's "+ New agent").
  const [spawnBackOpen, setSpawnBackOpen] = useState(false);
  // The current room's back room screen (task 5b503e32). Not a route: like a
  // chat it is one level deep, and a reload lands on the front.
  const [backRoomOpen, setBackRoomOpen] = useState(false);
  const [loneShift] = useState(createLoneShiftTracker);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    agent: AgentInfo;
  } | null>(null);
  // The Agent settings page (task 59538509): the agent, the section a door
  // named, and the view it opened over (agentPageView below).
  const [agentPage, setAgentPage] = useState<{
    agentId: string;
    section?: AgentSettingsSection;
    over: string;
  } | null>(null);
  // The desktop chat sidebar (task c61316be): open or collapsed, as this
  // device last chose, else by the window's width.
  const [sidebarOpen, setSidebarOpenState] = useState(() =>
    sidebarStartsOpen(
      getChatSidebar(),
      typeof window === "undefined" ? 0 : window.innerWidth,
    ),
  );
  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
    setChatSidebar(open ? "open" : "closed");
  }, []);
  // The phone's sidebar drawer (task 3cced5be): the same sidebar, over the
  // view. It always starts closed and never reads or writes the desktop
  // choice above.
  const [phoneDrawer, setPhoneDrawer] = useState(false);
  // The sidebar's New agent: the room and the seat it picked.
  // The page on top's leave guard (ui/page-leave-guard.ts).
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  const [sidebarSpawn, setSidebarSpawn] = useState<{
    roomId: string;
    desk: number | null;
  } | null>(null);
  // The display name is tracked for the user-switch handler, but the server now
  // derives message attribution from the session identity (the send/edit routes
  // no longer carry a username), so the value itself is no longer read in the UI.
  const [, setUsername] = useState<string | null>(() => getUsername());
  // The page the URL asked for, read once at mount. The page stack below
  // starts from it, so a shared link renders its page on the FIRST paint - no
  // flash of the office, and no wait for the websocket.
  // A Discord page link (`/?pager=<id>`) opens the Inbox on that page's ask.
  const [bootPage] = useState(() =>
    pageForLocation(window.location.pathname, window.location.search),
  );
  // The open full pages, bottom first (ui/page-stack.ts): the top one shows,
  // and closing it uncovers the one it was opened over. A chat is not a page:
  // agent chats are not routes (ruling 3), so a chat and the office share the
  // path "/".
  const [pageStack, setPageStack] = useState<PageStack>(() =>
    bootPage === null ? [] : [bootPage],
  );
  // Every change is a functional update, so two keydowns before a render
  // compose.
  const changePages = useCallback(
    (action: PageStackAction) =>
      setPageStack((prev) => pageStackAfter(prev, action)),
    [],
  );
  const page = topPage(pageStack);
  const pageBelow = pageUnder(pageStack);
  // Live-avatars: when a ghost is clicked, the user-settings page opens
  // preopened to that user. Null = generic open (no preselection),
  // string = open with that user selected. Reset to null on close so a
  // subsequent generic open (UserIcon button) lands on the current user
  // the usual way.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  // Which settings row to open on. Every door that used to open its own
  // dialog - the bar's Device, Theme and Room buttons, a room tab, the update
  // pill - now names a row instead, and the page opens there.
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(
    null,
  );
  // Bumped by every door into Settings and used as the page's key, so a door
  // taken while Settings is open mounts a fresh page on its own target.
  const [settingsDoor, setSettingsDoor] = useState(0);
  const [taskOpenRequest, setTaskOpenRequest] =
    useState<TaskOpenRequest | null>(null);
  // One-shot: what the Integrations page opens on, beyond its defaults: an
  // MCP sign-in that came back carries its result (read once, like the ask
  // id below), and a door or a URL that names a tab carries the tab. The page
  // takes it on mount and clears it.
  const [integrationsRequest, setIntegrationsRequest] =
    useState<IntegrationsRequest | null>(() => {
      // Only for an Integrations boot page: a page's one-shot state goes
      // when the page is not open. A sign-in that came back to an ask is
      // that ask's (askSignIn below).
      if (bootPage !== "integrations") return null;
      const signIn = mcpSignInForSearch(window.location.search);
      const tab = integrationsTabForPath(window.location.pathname);
      if (signIn === null && tab === null) return null;
      return {
        ...(signIn === null ? {} : { signIn }),
        ...(tab === null ? {} : { tab }),
      };
    });
  const clearIntegrationsRequest = useCallback(
    () => setIntegrationsRequest(null),
    [],
  );
  // The ask pinned above the Asks list (task 84aadfab): an ask chip's, an
  // ask link's or the /inbox/asks/<askId> address's, read once. It goes when
  // the Asks tab closes.
  const [askFocus, setAskFocus] = useState<string | null>(() =>
    askIdForPath(window.location.pathname),
  );
  // A Discord or push link from before pages were asks (`/?pager=<id>`, task
  // 74e8fc07): the Asks tab is open from the first paint, and the page's ask
  // is pinned once the office names it. Read once, like the path.
  const [bootPageId] = useState(() => pagerIdForSearch(window.location.search));
  useEffect(() => {
    if (bootPageId === null) return;
    let live = true;
    void askIdForPage(bootPageId).then((askId) => {
      if (live && askId !== null) setAskFocus(askId);
    });
    return () => {
      live = false;
    };
  }, [bootPageId]);
  if (!pageStack.includes("asks") && askFocus !== null) setAskFocus(null);
  const clearAskFocus = useCallback(() => setAskFocus(null), []);
  // One-shot: the result of an MCP sign-in started in an ask card, which came
  // back to /inbox/asks/<askId>?mcpSignIn=<code> (task e3d1bc63). That ask's
  // card takes it.
  const [askSignIn, setAskSignIn] = useState<AskSignIn | null>(() => {
    const askId = askIdForPath(window.location.pathname);
    const code = mcpSignInForSearch(window.location.search);
    return askId && code !== null ? { askId, code } : null;
  });
  const askSignInResult = useMemo(
    () => ({ result: askSignIn, take: () => setAskSignIn(null) }),
    [askSignIn],
  );
  // The agent the Asks tab filters to once (a chat stack's View in Inbox,
  // task 586ebfe1). It goes when the Asks tab closes, like the pin.
  const [askAgentFilter, setAskAgentFilter] = useState<string | null>(null);
  if (!pageStack.includes("asks") && askAgentFilter !== null)
    setAskAgentFilter(null);
  const clearAskAgentFilter = useCallback(() => setAskAgentFilter(null), []);
  // The other pages' one-shot state goes the same way: when its page leaves
  // the stack, whichever action took it out.
  if (!pageStack.includes("tasks") && taskOpenRequest !== null)
    setTaskOpenRequest(null);
  if (!pageStack.includes("integrations") && integrationsRequest !== null)
    setIntegrationsRequest(null);
  if (!pageStack.includes("settings")) {
    if (editingUserId !== null) setEditingUserId(null);
    if (settingsTarget !== null) setSettingsTarget(null);
  }
  const openInbox = useCallback(
    () => changePages({ type: "open", page: "asks" }),
    [changePages],
  );
  useAsksSync();
  useOthersAsksSync();

  // Refresh persistence: reopen the same spot (room / agent chat / tasks /
  // cronjobs) after a page reload, and restore unsent chat drafts. The
  // restore runs ONCE, after the first full_state, so every saved id can be
  // validated against what actually still exists - a killed agent, a closed
  // room, or lost access silently falls back to the normal default view (the
  // first visible room, which full_state already selected; the restore only
  // overrides it when the saved room is still valid). Without a saved view,
  // every member starts on the lobby, and an elevator ride always does;
  // StoreProvider draws that view from the first frame. Gated off in the demo
  // (llmConnected=false),
  // where restoring a previous visitor's spot would break the scripted
  // landing-page experience. `restored` is state (not a ref) on purpose: the
  // save effects below read it from the SAME render, so on the restore
  // commit they still see false and can't clobber the saved data with the
  // pre-restore defaults before it has been applied. Both persisted surfaces
  // are user-owned: view loads reject an owner mismatch, and draft keys are
  // user-namespaced, so a user switch on the same browser can't leak user
  // A's drafts or view spot into user B's session. The session_context
  // username is the server-authoritative identity and arrives before
  // full_state on every WS open, so gating on it costs nothing in practice.
  const persistEnabled = features.llmConnected;
  const persistUser = sessionContext?.username ?? null;
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!persistEnabled || restored || !hasReceivedInitialState || !persistUser)
      return;
    // One-shot hydration from an external system (localStorage) - the flag
    // flip must be state (see above) and can only happen here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestored(true);
    // Drafts: only re-dispatch for agents that still exist, and prune this
    // user's saved keys for agents that don't (killed, or no longer
    // visible). Only our own namespace is pruned - another user's agents
    // can't be validated against this session's ACL-filtered list.
    const liveAgentIds = new Set(agents.map((a) => a.id));
    const savedDrafts = loadUserDrafts(persistUser);
    for (const [agentId, text] of Object.entries(savedDrafts)) {
      if (liveAgentIds.has(agentId)) {
        dispatch({ type: "set_draft", agentId, text });
      }
    }
    pruneUserDrafts(persistUser, liveAgentIds);
    // Appended, not replaced: an item attached before this ran stays.
    const savedAttachments = loadUserDraftAttachments(persistUser);
    for (const [agentId, attachments] of Object.entries(savedAttachments)) {
      if (liveAgentIds.has(agentId)) {
        dispatch({
          type: "add_draft_attachments",
          agentId,
          items: asDraftAttachments(attachments),
        });
      }
    }
    pruneUserDraftAttachments(persistUser, liveAgentIds);
    pruneUserFoldedAsks(persistUser, liveAgentIds);
    restoreOutbox(persistUser, liveAgentIds);
    const saved = loadSavedView(persistUser);
    if (!saved) {
      dispatch({ type: "set_lobby_open", open: true });
      return;
    }
    // Room and agent restore independently on purpose: agents can be moved
    // across rooms, and the view selection deliberately doesn't follow the
    // focused agent (matches live behavior in the presence effect below).
    if (saved.roomId && rooms.some((r) => r.id === saved.roomId)) {
      dispatch({ type: "set_current_room", roomId: saved.roomId });
    }
    // After the room: selecting a room closes the lobby, so the lobby flag
    // has to land last to win. An elevator ride steps out into the lobby,
    // with no saved chat or page over it.
    if (saved.lobby || rideArrival)
      dispatch({ type: "set_lobby_open", open: true });
    if (rideArrival) return;
    if (saved.agentId && agents.some((a) => a.id === saved.agentId)) {
      dispatch({ type: "focus", agentId: saved.agentId });
    }
    // Ruling 4: a page in the URL wins over the saved panel, and it is already
    // open from the first render. The saved spot still supplies room and agent
    // above, so a shared /tasks link lands on the task page over the chat the
    // reader left open.
    if (bootPage !== null || saved.panel === null) return;
    // "users" is the old name for the settings page; a spot saved by an
    // earlier build still reopens it.
    changePages({
      type: "open",
      page: saved.panel === "users" ? "settings" : saved.panel,
    });
  }, [
    bootPage,
    persistEnabled,
    restored,
    hasReceivedInitialState,
    persistUser,
    agents,
    rooms,
    rideArrival,
    dispatch,
    changePages,
  ]);

  // Save the view spot whenever it changes (post-restore only).
  useEffect(() => {
    if (!persistEnabled || !restored || !persistUser) return;
    saveView(persistUser, {
      roomId: currentRoomId,
      agentId: focusedAgentId,
      lobby: lobbyOpen,
      panel: page,
    });
  }, [
    persistEnabled,
    restored,
    persistUser,
    currentRoomId,
    focusedAgentId,
    page,
    lobbyOpen,
  ]);

  // Write drafts through to their per-composer keys (post-restore only) by
  // diffing against the previous Map: only the changed composer's key is
  // written, and a cleared/sent draft (entry deleted by set_draft "") removes
  // its key. Per-composer keys - not a whole-map mirror - is what keeps
  // multi-tab safe: a second tab that never saw this tab's draft can't
  // clobber it, because it only ever writes the keys IT changes.
  const prevDraftsRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!persistEnabled || !restored || !persistUser) return;
    const prev = prevDraftsRef.current;
    prevDraftsRef.current = drafts;
    for (const [agentId, text] of drafts) {
      if (prev?.get(agentId) !== text) saveDraft(persistUser, agentId, text);
    }
    if (prev) {
      for (const agentId of prev.keys()) {
        if (!drafts.has(agentId)) saveDraft(persistUser, agentId, "");
      }
    }
  }, [persistEnabled, restored, persistUser, drafts]);

  // The same write-through for the draft attachments (saveDraftAttachments
  // keeps only the uploaded references).
  const prevDraftAttachmentsRef = useRef<Map<string, DraftAttachment[]> | null>(
    null,
  );
  useEffect(() => {
    if (!persistEnabled || !restored || !persistUser) return;
    const prev = prevDraftAttachmentsRef.current;
    prevDraftAttachmentsRef.current = draftAttachments;
    for (const [agentId, items] of draftAttachments) {
      if (prev?.get(agentId) !== items)
        saveDraftAttachments(persistUser, agentId, items);
    }
    if (prev) {
      for (const agentId of prev.keys()) {
        if (!draftAttachments.has(agentId))
          saveDraftAttachments(persistUser, agentId, []);
      }
    }
  }, [persistEnabled, restored, persistUser, draftAttachments]);

  const selfUser = useSelfUser();
  // One-shot language seed: the browser's language takes
  // effect without a first Save. A record that never chose a language gets the
  // detected browser language committed once (English is never seeded - a null
  // record already behaves as English). A failed write re-arms and retries on
  // the next record update.
  const langSeededRef = useRef(false);
  useEffect(() => {
    if (langSeededRef.current || !selfUser) return;
    const seed = languageSeed(selfUser, navigator.language);
    if (seed === null) {
      langSeededRef.current = true;
      return;
    }
    langSeededRef.current = true;
    const body: PreferencesReq = { language: seed };
    apiFetch<void>("PATCH", "/api/me/preferences", body).catch(() => {
      langSeededRef.current = false;
    });
  }, [selfUser]);

  const viewportControlsRef = useRef<ViewportControls | null>(null);
  const focusedAgent = focusedAgentId
    ? agents.find((a) => a.id === focusedAgentId)
    : null;
  // A back agent's log, however it was opened (the back screen, search, the
  // pager, the task board, Next/Prev), steps back to its room's back screen.
  // Render-phase derived state: the render that sees a focused back agent
  // opens the back screen, and React re-renders once with it.
  const focusedInBack = !!focusedAgent && isBackSeat(focusedAgent.desk);
  if (focusedInBack && !backRoomOpen) setBackRoomOpen(true);

  // The Agent settings page shows in the place of the view it opened over,
  // and only while that view is the one under it: whatever changes the view
  // (Back, a chat, the office, an ask link) drops the page with it. An agent
  // that is gone drops it too.
  const agentPageView = [
    page ?? "",
    focusedAgentId ?? "",
    openHumanChat ? humanChatId(openHumanChat) : "",
    backRoomOpen ? "back" : "front",
    currentRoomId ?? "",
  ].join("|");
  const agentPageAgent = agentPage
    ? (agents.find((a) => a.id === agentPage.agentId) ?? null)
    : null;
  if (
    agentPage &&
    (agentPage.over !== agentPageView || agentPageAgent === null)
  )
    setAgentPage(null);
  const agentPageShown = agentPage !== null && agentPageAgent !== null;
  // Opens an agent's settings over the view that shows now. The doors that
  // can leave a page with unsaved edits go through leaveThen first.
  const openAgentSettings = (agentId: string, section?: AgentSettingsSection) =>
    setAgentPage({ agentId, section, over: agentPageView });

  // Keep the browser tab title in sync with what's open - the focused agent,
  // else the current room, else the office name - so tabs on different agents
  // or rooms are distinguishable. The server renders the office name into
  // index.html for cold loads; this effect only takes over once full_state has
  // landed (connected=true) so it doesn't briefly overwrite the server-rendered
  // title while office.name is still null from the initial empty store.
  //
  // A focused agent also gets an ASCII face for its state (agent-face.ts), so
  // a background tab shows whether it's still working or waiting on you.
  const focusedAgentName = focusedAgent?.name ?? null;
  const focusedAgentState = focusedAgent?.state ?? null;
  const currentRoomName =
    rooms.find((r) => r.id === currentRoomId)?.name ?? null;
  // A new agent starts in the room's folder, or in "~" where it has none.
  const newAgentCwd = rooms.find((r) => r.id === currentRoomId)?.cwd ?? "~";
  // On the Lobby tab the title is the office name, never "Lobby" (Nil).
  const tabLabel =
    focusedAgentName !== null
      ? agentTabLabel(focusedAgentName, focusedAgentState ?? "idle")
      : lobbyOpen
        ? (office.name ?? null)
        : (currentRoomName ?? office.name ?? null);
  // Messaging apps put the unread count in front of the title, and the
  // installed app shows it on its icon: the bar's red badge, the Inbox items
  // this browser has not shown yet (task 598298ba).
  const unseenInboxCount = useInboxCounts().newAsks;
  useEffect(() => {
    if (!connected) return;
    document.title = documentTitle(tabLabel, unseenInboxCount);
  }, [connected, tabLabel, unseenInboxCount]);
  useEffect(() => {
    if (connected) syncAppBadge(unseenInboxCount);
  }, [connected, unseenInboxCount]);

  // Phone swipes walk the tab bar in order, the Lobby included (Nil): the
  // order lives in swipeTarget. Selecting a room closes the lobby; opening the
  // lobby leaves the room selection alone, like the Lobby tab does.
  const { tabs } = useRoomList();
  const swipeRoom = useCallback(
    (direction: "next" | "prev") => {
      const target = swipeTarget(tabs, currentRoomId, lobbyOpen, direction);
      if (!target) return;
      if (target.kind === "lobby")
        dispatch({ type: "set_lobby_open", open: true });
      else dispatch({ type: "set_current_room", roomId: target.roomId });
    },
    [dispatch, tabs, currentRoomId, lobbyOpen],
  );
  const swipeRoomNext = useCallback(() => swipeRoom("next"), [swipeRoom]);
  const swipeRoomPrev = useCallback(() => swipeRoom("prev"), [swipeRoom]);

  const swipeAgentNext = useCallback(() => {
    const nextId = cycleAgent(
      agents,
      drafts,
      currentRoomId,
      focusedAgentId,
      "next",
    );
    if (nextId) dispatch({ type: "focus", agentId: nextId });
  }, [dispatch, agents, drafts, currentRoomId, focusedAgentId]);

  const swipeAgentPrev = useCallback(() => {
    const nextId = cycleAgent(
      agents,
      drafts,
      currentRoomId,
      focusedAgentId,
      "prev",
    );
    if (nextId) dispatch({ type: "focus", agentId: nextId });
  }, [dispatch, agents, drafts, currentRoomId, focusedAgentId]);

  // Browser back button: navigate within the app instead of leaving the page.
  // Model: office = home, any other view = one level deep. Only one history
  // entry is ever pushed at a time, but Back can step through more than one
  // UI level: a page opened over a chat or over another page pops back to
  // what is under it first (the popstate handler re-pushes the entry), then
  // to the office. Every "return to office" path goes through goHome(), which
  // gets there one of two ways depending on the ref below - history.back()
  // when we pushed the entry, and a replace when we did not.

  // How the CURRENT history entry relates to us, which is what ruling 8 turns
  // on. "none": no page open, the office sits on whatever entry the load made.
  // "adopted": a page is open on an entry we did NOT push - a shared link
  // opened cold - so the browser's Back leaves the site and goHome() has to
  // replace instead. "pushed": a page is open on an entry we pushed, and Back
  // returns to what is underneath, as it always did.
  const entryRef = useRef<"none" | "adopted" | "pushed">(
    bootPage === null ? "none" : "adopted",
  );

  // The one-shot state that belongs to each page. It goes when its page
  // leaves the stack (the resets above); a page that stays in the stack while
  // it is opened again needs it cleared here.
  const pageState = useMemo(
    (): Record<Page, { clear: () => void }> => ({
      settings: {
        clear: () => {
          setEditingUserId(null);
          setSettingsTarget(null);
        },
      },
      tasks: { clear: () => setTaskOpenRequest(null) },
      cronjobs: { clear: () => {} },
      apps: { clear: () => {} },
      skills: { clear: () => {} },
      integrations: { clear: () => setIntegrationsRequest(null) },
      asks: { clear: () => setAskFocus(null) },
    }),
    [],
  );

  // The one place the whole stack is replaced - boot, popstate, an agent's
  // chat and the office. It leaves at most one page open. The settings
  // section and the preselected user are deliberately dropped: neither is
  // part of a route (ruling 3), so a Forward into settings lands on the
  // generic page instead of resurrecting whichever row was open last time.
  const applyPage = useCallback(
    (page: Page | null) => {
      changePages({ type: "only", page });
      for (const { clear } of Object.values(pageState)) clear();
    },
    [changePages, pageState],
  );

  // Open the settings page, optionally on a named row. Passing null is the
  // generic open (the bar's User button), which must CLEAR any section left
  // over from a previous visit rather than reopening it.
  const openSettings = useCallback(
    (target: SettingsTarget | null) => {
      setSettingsTarget(target);
      setSettingsDoor((n) => n + 1);
      changePages({ type: "open", page: "settings" });
    },
    [changePages],
  );

  const openIntegrations = useCallback(
    (request?: IntegrationsRequest) => {
      setIntegrationsRequest(request ?? null);
      changePages({ type: "open", page: "integrations" });
    },
    [changePages],
  );

  // Opens an agent's chat from anywhere outside its desk (a page, a link):
  // every page closes, the back screen and the lobby close, and the agent's
  // room becomes the current room (for the receptionist, the lobby opens),
  // so Back lands next to the agent (task 1faeb586). A back agent's chat
  // reopens the back screen through focusedInBack.
  const openAgentChat = useCallback(
    (agentId: string) => {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) return;
      applyPage(null);
      setBackRoomOpen(false);
      // The lobby is not a room: its receptionist's chat opens over the
      // lobby, and the room the member last stood in stays the current room
      // (the sidebar's New agent spawns there).
      if (agent.roomId === LOBBY_ROOM_ID)
        dispatch({ type: "set_lobby_open", open: true });
      else dispatch({ type: "set_current_room", roomId: agent.roomId });
      dispatch({ type: "focus", agentId: agent.id });
    },
    [agents, applyPage, dispatch],
  );

  // An ask's link opens its page on top of whatever it was clicked on - a
  // chat, the Inbox or another page - so Close and Back return there. The
  // page's one-shot state is cleared first, so Settings opens on no stale
  // row. A link to an agent goes through openAgentChat.
  const openOfficeLink = useCallback(
    (link: OfficeLink) => {
      if ("agentId" in link) {
        openAgentChat(link.agentId);
        return;
      }
      pageState[link.page].clear();
      if (link.tab) setIntegrationsRequest({ tab: link.tab });
      if (link.askId) setAskFocus(link.askId);
      if (link.onlyAgent) setAskAgentFilter(link.onlyAgent);
      changePages({ type: "open", page: link.page });
    },
    [pageState, changePages, openAgentChat],
  );

  // An agent's address (/agents/<agentId>, the app widget's link) opens that
  // chat as an ask link does. Read once at mount, like the ask id: the path
  // effect below rewrites the address to "/". It waits for the saved-spot
  // restore, so it wins over the saved room, chat, page and lobby, and it is
  // tried once: an agent that appears later in the session does not take the
  // view.
  const [bootAgentId, setBootAgentId] = useState(() =>
    agentIdForPath(window.location.pathname),
  );
  useEffect(() => {
    if (
      bootAgentId === null ||
      !hasReceivedInitialState ||
      (persistEnabled && !restored)
    )
      return;
    // One-shot, like the restore: the request is spent on its first try.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootAgentId(null);
    openOfficeLink({ agentId: bootAgentId });
  }, [
    bootAgentId,
    hasReceivedInitialState,
    persistEnabled,
    restored,
    openOfficeLink,
  ]);

  const goHome = useCallback(() => {
    if (entryRef.current === "pushed") {
      window.history.back(); // popstate handler will reset state
      return;
    }
    // Ruling 8: we never pushed this entry, so there is nothing underneath to
    // go back to and history.back() would leave the office. Replace the entry
    // with the office instead. Close, Escape and the office button all come
    // through here, so they all obey the ruling without their own code.
    if (entryRef.current === "adopted")
      window.history.replaceState({ isomux: true, page: null }, "", "/");
    entryRef.current = "none";
    applyPage(null);
    dispatch({ type: "focus", agentId: null });
    dispatch({ type: "open_human_chat", chat: null });
    setBackRoomOpen(false);
  }, [applyPage, dispatch]);

  // The sidebar's Office row: every page and the chat close, and the room
  // view of the open agent shows. A back agent returns to its back room screen, which stays deep, so the history entry
  // stays. Anything else leaves for the office the way goHome does, but with
  // the state reset first: from a page over a chat, the popstate handler
  // alone would close only the top page.
  const leaveToOffice = useCallback(() => {
    applyPage(null);
    dispatch({ type: "focus", agentId: null });
    dispatch({ type: "open_human_chat", chat: null });
    setBackRoomOpen(false);
    if (entryRef.current === "pushed") {
      window.history.back();
      return;
    }
    if (entryRef.current === "adopted")
      window.history.replaceState({ isomux: true, page: null }, "", "/");
    entryRef.current = "none";
  }, [applyPage, dispatch]);
  const goOffice = useCallback(() => {
    // The room view the open agent sits in: its room, or the lobby.
    const roomId = focusedAgent?.roomId ?? null;
    if (focusedInBack) {
      applyPage(null);
      if (roomId !== null) dispatch({ type: "set_current_room", roomId });
      dispatch({ type: "focus", agentId: null });
      return;
    }
    leaveToOffice();
    if (roomId === LOBBY_ROOM_ID)
      dispatch({ type: "set_lobby_open", open: true });
    else if (roomId !== null) dispatch({ type: "set_current_room", roomId });
  }, [focusedAgent, focusedInBack, applyPage, dispatch, leaveToOffice]);
  // A human chat, full screen in the main pane (task 019e4d7c): every page
  // and the agent chat close, as for openAgentChat; the room in view stays,
  // so Back lands where the member was.
  const openHumanChatView = useCallback(
    (chat: HumanChatKey) => {
      applyPage(null);
      setBackRoomOpen(false);
      dispatch({ type: "open_human_chat", chat });
    },
    [applyPage, dispatch],
  );
  // An owner's gear on a member: Settings on that member, over what is open.
  const openMemberSettings = useCallback(
    (userId: string) => {
      setEditingUserId(userId);
      openSettings(null);
    },
    [openSettings],
  );

  // /chats/members or /chats/<userId> (a web push link) opens that chat, as
  // an agent's address does: read once at mount, after the saved-spot restore.
  const [bootHumanChat, setBootHumanChat] = useState(() =>
    humanChatForPath(window.location.pathname),
  );
  useEffect(() => {
    if (
      bootHumanChat === null ||
      !hasReceivedInitialState ||
      (persistEnabled && !restored)
    )
      return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBootHumanChat(null);
    openHumanChatView(bootHumanChat);
  }, [
    bootHumanChat,
    hasReceivedInitialState,
    persistEnabled,
    restored,
    openHumanChatView,
  ]);

  // Live-avatars: tell the server where this session's ghost should
  // appear. Fires whenever any of the relevant view states change, plus
  // once on session_context arrival (so a fresh WS gets the initial
  // position registered without waiting for user input). The server
  // dedupes on its end so identical updates don't cascade into a
  // broadcast.
  const viewMode: "office" | "log" | "away" =
    page !== null ? "away" : focusedAgentId ? "log" : "office";
  // When a focused agent moves rooms (owner drags them across with
  // move_agent), the viewer's selection (currentRoomId) doesn't follow.
  // The ghost should anchor to wherever the agent IS, not where the viewer
  // last clicked, so use the focused agent's roomId when focused and fall
  // back to the viewer's selection otherwise. Depending on the scalar id
  // rather than the focusedAgent object identity keeps the effect quiet
  // through unrelated agent_updated noise (state/log changes).
  const presenceRoomId =
    focusedAgent?.roomId ?? (lobbyOpen ? LOBBY_ROOM_ID : currentRoomId);
  useEffect(() => {
    if (!sessionContext) return;
    send({
      type: "presence_update",
      currentRoomId: presenceRoomId,
      focusedAgentId,
      viewMode,
      // The page's wall item, so other members see the ghost beside it.
      page: presencePageFor(page),
      // Read device inline rather than as a dep so we don't need to
      // wire a localStorage-change subscription. Device-label edits
      // happen in DeviceSettings, whose close transitions viewMode
      // and refires this effect with the fresh value.
      device: getDevice(),
    });
  }, [sessionContext, presenceRoomId, focusedAgentId, viewMode, page]);

  // The chat panel over the Inbox (AgentChatPanel): its agent, or null. It
  // closes when the member leaves the Inbox or its agent goes, so it does not
  // come back with either.
  const [inboxChat, setInboxChat] = useState<string | null>(null);
  if (
    inboxChat !== null &&
    (page !== "asks" || !agents.some((a) => a.id === inboxChat))
  )
    setInboxChat(null);

  // Pages close top first, back to what they were opened over (tasks 586b63a5
  // and d6c09d1c): the page under the top one when two are stacked, else the
  // chat. Gate on the resolved agent, not the id, so a chat whose agent
  // disappeared while a page was open closes to the office instead of a stale
  // focus.
  const somethingUnderPage =
    page !== null &&
    (pageBelow !== null || !!focusedAgent || openHumanChat !== null);

  // Drop only the page on top; the state that belongs to it goes with it.
  // Focus and the history entry stay: we stay deep, so the sync effect
  // replaces the entry instead of pushing, and Back from what is uncovered
  // still lands on the office.
  const closeTopPage = useCallback(() => {
    if (page !== null) changePages({ type: "close", page });
  }, [page, changePages]);

  // Every page's way out - its Close button, Escape, and a second a or i -
  // comes through here; Back takes the same decision in the popstate handler.
  const closePage = useCallback(() => {
    if (somethingUnderPage) closeTopPage();
    else goHome();
  }, [somethingUnderPage, closeTopPage, goHome]);

  // A back agent's log sits over the back screen, the way tasks sit over a
  // chat: closing it returns to the back screen, not the front. A page open
  // over the log (Apps, Settings, Tasks...) closes the normal way instead.
  const logOverBackRoom = backRoomOpen && !!focusedAgent && page === null;
  // Escape and the chat's Back button. With a page showing, Escape closes
  // that page instead.
  const closeLog = useCallback(() => {
    if (page !== null) closePage();
    else if (logOverBackRoom) dispatch({ type: "focus", agentId: null });
    else goHome();
  }, [page, closePage, logOverBackRoom, dispatch, goHome]);

  const closeTasks = useCallback(() => {
    setTaskOpenRequest(null);
    closePage();
  }, [closePage]);

  const openTasks = useCallback(() => {
    setTaskOpenRequest(null);
    changePages({ type: "open", page: "tasks" });
  }, [changePages]);

  const openTask = useCallback(
    (id: string) => {
      setTaskOpenRequest({ id });
      changePages({ type: "open", page: "tasks" });
    },
    [changePages],
  );

  // An ask chip opens its ask pinned on the Inbox's Asks tab, as an ask's
  // link to it does.
  const openAsk = useCallback(
    (id: string) => openOfficeLink({ page: "asks", askId: id }),
    [openOfficeLink],
  );

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function isInputTarget(target: EventTarget | null) {
      const tag = (target as HTMLElement)?.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        !!(target as HTMLElement)?.isContentEditable
      );
    }
    function backRoomState() {
      return {
        hasBackRoom:
          !lobbyOpen && hasBackRoom(rooms.find((r) => r.id === currentRoomId)),
        backRoomOpen,
        covered: !!focusedAgentId || page !== null,
      };
    }
    // The lone Shift tracker listens in the capture phase: a component that
    // stops a keydown's propagation must still spoil a Shift press.
    function feedLoneShift(e: KeyboardEvent) {
      loneShift.keydown(e.key, e.repeat);
    }
    function resetLoneShift() {
      loneShift.reset();
    }
    // A lone Shift goes from the back room to the front. The keyup's own
    // modifiers go to the rule, so a Shift tapped with Ctrl, Alt or Meta held
    // does nothing.
    function handleKeyUp(e: KeyboardEvent) {
      if (!loneShift.keyup(e.key)) return;
      if (agentPageShown) return;
      const backRoomKey = backRoomShortcut(
        {
          key: e.key,
          loneShift: true,
          isInput: isInputTarget(e.target),
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        },
        backRoomState(),
      );
      if (backRoomKey === "close") goHome();
    }
    function handleKey(e: KeyboardEvent) {
      // The Agent settings page holds a form over the view: no view key
      // may change the view under it (its own Escape goes through its
      // discard prompt, or to a menu or dialog over it). Leaving it must
      // pass its guard, as on Settings.
      if (agentPageShown) {
        // Over the page, Escape closes the menu over it.
        if (e.key === "Escape") setCtxMenu(null);
        return;
      }
      const isInput = isInputTarget(e.target);
      if (e.key === "Escape") {
        closeLog();
        setSpawnPickerDesk(null);
        setCtxMenu(null);
      }
      const pageAction = pageShortcut(
        {
          key: e.key,
          isInput,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        },
        pageStack,
      );
      if (pageAction !== null) {
        e.preventDefault();
        if (pageAction === "home") closePage();
        // "s" opens the settings of the room you are standing in; the lobby
        // has no room row, so it opens the office row instead (Nil, 2026-09-14).
        else if (pageAction.page === "settings")
          openSettings(
            !lobbyOpen && currentRoomId
              ? { kind: "room", roomId: currentRoomId }
              : { kind: "section", section: "office" },
          );
        else changePages(pageAction);
      }
      const backRoomKey = backRoomShortcut(
        {
          key: e.key,
          isInput,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        },
        backRoomState(),
      );
      if (backRoomKey === "open") {
        e.preventDefault();
        setBackRoomOpen(true);
      } else if (backRoomKey === "close") {
        e.preventDefault();
        goHome();
      }
      // Viewport zoom/pan shortcuts (only from office view): 0 → reset, +/= → zoom in, - → zoom out.
      // "=" accepted as an alias for "+" so users don't need Shift on US layouts.
      // Ref is null when OfficeView isn't mounted (log view, etc.) - don't swallow the key in those cases.
      const vp = viewportControlsRef.current;
      if (
        vp &&
        !isInput &&
        !focusedAgentId &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (e.key === "0") {
          e.preventDefault();
          vp.resetView();
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          vp.zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          vp.zoomOut();
        }
      }
      // Number keys: focus the agent at that desk in the current room (only
      // from office view). The keys are 1-based while desks are 0-based
      // everywhere else (state, API, drag-and-drop), so "1" is desk 0.
      if (
        !isInput &&
        !focusedAgentId &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const deskIndex = Number(e.key) - 1;
        const agent = isValidDesk(deskIndex)
          ? agents.find(
              (a) => a.desk === deskIndex && a.roomId === currentRoomId,
            )
          : undefined;
        if (agent) {
          e.preventDefault();
          dispatch({ type: "focus", agentId: agent.id });
        }
      }
      // Tab/Shift+Tab in office view: switch rooms, unless Shift+Tab just
      // left the back room.
      if (
        !isInput &&
        !focusedAgentId &&
        e.key === "Tab" &&
        backRoomKey === null &&
        roomCount > 1 &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        // Walk the tab bar in order, the Lobby included, through the same
        // path as a phone swipe: from the lobby, Tab reaches the first room
        // rather than the room after the one last visited (Nil, 2026-09-09).
        swipeRoom(e.shiftKey ? "prev" : "next");
      }
      // Tab: cycle to next agent within current room (Shift+Tab: previous) when viewing an agent
      // Skip if autocomplete already consumed this Tab (it calls preventDefault)
      if (
        focusedAgentId &&
        e.key === "Tab" &&
        agents.length > 1 &&
        !e.defaultPrevented
      ) {
        e.preventDefault();
        const nextId = cycleAgent(
          agents,
          drafts,
          currentRoomId,
          focusedAgentId,
          e.shiftKey ? "prev" : "next",
        );
        if (nextId) dispatch({ type: "focus", agentId: nextId });
      }
    }
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keydown", feedLoneShift, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("pointerdown", resetLoneShift, true);
    window.addEventListener("blur", resetLoneShift);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keydown", feedLoneShift, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("pointerdown", resetLoneShift, true);
      window.removeEventListener("blur", resetLoneShift);
    };
  }, [
    dispatch,
    goHome,
    closeLog,
    closePage,
    focusedAgentId,
    agents,
    drafts,
    rooms,
    currentRoomId,
    roomCount,
    swipeRoom,
    pageStack,
    changePages,
    openSettings,
    lobbyOpen,
    backRoomOpen,
    agentPageShown,
    page,
    loneShift,
  ]);

  // The view under the phone's drawer is deep.
  const deepView =
    page !== null ||
    focusedAgentId !== null ||
    openHumanChat !== null ||
    backRoomOpen;
  // The open drawer is one more layer: over the office it takes an entry of
  // its own, so Back closes it. Over a deep view it shares that view's
  // entry, and Back closes it in the popstate handler; under a cold link
  // (ruling 8) it pushes nothing.
  const isDeep = deepView || phoneDrawer;
  useEffect(() => {
    const write = (method: "pushState" | "replaceState") => {
      const entry = { isomux: true, page };
      if (routing) window.history[method](entry, "", pathForPage(page));
      else window.history[method](entry, "");
    };
    if (isDeep && entryRef.current === "none") {
      write("pushState");
      entryRef.current = "pushed";
    } else if (isDeep) {
      // Deep → deep transition (e.g. tasks→log, agent cycling): keep one
      // entry, and keep whether we pushed it - ruling 8 turns on that, not on
      // which page is showing. This is also the boot path: an adopted entry is
      // rewritten here to carry its page, which is how /users canonicalises to
      // /settings without a second history call.
      write("replaceState");
    } else if (entryRef.current !== "none") {
      // Returned to office - entry was consumed by history.back()
      entryRef.current = "none";
    }
  }, [isDeep, focusedAgentId, openHumanChat, page, phoneDrawer, routing]);

  // Any path that is not a route shows the office, and the office is "/" - so
  // normalise rather than leave it sitting at /garbage. The entry the load made
  // is rewritten in place; nothing is pushed, so this cannot be navigated back
  // into. A page path is not handled here: the effect above owns it.
  useEffect(() => {
    if (!routing || bootPage !== null || window.location.pathname === "/")
      return;
    window.history.replaceState({ isomux: true, page: null }, "", "/");
  }, [bootPage, routing]);

  useEffect(() => {
    function handlePopState(e: PopStateEvent) {
      const restored = pageFromEntry(e.state);
      const target =
        restored === undefined
          ? pageForPath(window.location.pathname)
          : restored;
      if (phoneDrawer) {
        // Back with the drawer open closes the drawer only. Over a chat the
        // sync effect re-pushes the entry the Back took, as for a page over
        // a chat; over the office the drawer's own entry is gone.
        entryRef.current = "none";
        setPhoneDrawer(false);
        return;
      }
      if (target !== null) {
        // The entry names a page: a Forward back into one, or a Back out of
        // something deeper. Open it and stay deep. Only a "none" ref is
        // upgraded - that is the forward-after-back case, where an office
        // entry really is underneath us again. An adopted entry stays adopted,
        // so a cold-loaded link can never talk itself into calling back().
        if (entryRef.current === "none") entryRef.current = "pushed";
        applyPage(target);
        return;
      }
      entryRef.current = "none";
      if (somethingUnderPage) {
        // Back from a page over a chat or over another page steps back to
        // what is under it, not the office. We stay deep, so the sync effect
        // re-pushes the entry the Back just consumed; a Back from the chat
        // then lands on the office as usual. The re-push relies on `page`
        // changing, which it always does when a layer closes: it is the sync
        // effect's dep. A pop that changed only focus would not re-push.
        closeTopPage();
        return;
      }
      if (logOverBackRoom) {
        // Back from a back agent's log steps to the back screen; the sync
        // effect re-pushes the entry, as for tasks over a chat.
        dispatch({ type: "focus", agentId: null });
        return;
      }
      applyPage(null);
      dispatch({ type: "focus", agentId: null });
      dispatch({ type: "open_human_chat", chat: null });
      setBackRoomOpen(false);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [
    applyPage,
    dispatch,
    somethingUnderPage,
    closeTopPage,
    logOverBackRoom,
    phoneDrawer,
  ]);

  // The drawer's backdrop and hide button. It goes at once; over the office
  // its own entry goes too, as leaveToOffice does. A second tap before the
  // popstate finds no drawer, so it cannot go back twice.
  const closeDrawer = useCallback(() => {
    setPhoneDrawer(false);
    if (!deepView && entryRef.current === "pushed") window.history.back();
  }, [deepView]);

  // The sidebar shows beside the office view, the chat and every page, on a
  // desktop; never on a phone or in the site's embed. The shell stays while
  // the sidebar collapses and while the view changes under it, so neither the
  // sidebar nor the chat mounts again.
  const sidebarView = !isMobile && !features.embed;
  // On a phone (not in the embed), the sidebar is a drawer (task 3cced5be).
  const phoneSidebar = isMobile && !features.embed;
  // A window that stops being a phone (a phone turned to landscape) closes
  // the drawer and takes its entry away.
  useEffect(() => {
    // The close must also take the drawer's history entry, which only an
    // effect may do.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!phoneSidebar && phoneDrawer) closeDrawer();
  }, [phoneSidebar, phoneDrawer, closeDrawer]);
  const drawerShown = phoneSidebar && phoneDrawer;
  // The button that shows the sidebar: the drawer on a phone, the collapsed
  // sidebar on a desktop.
  const showSidebar = phoneSidebar
    ? () => setPhoneDrawer(true)
    : sidebarView && !sidebarOpen
      ? () => setSidebarOpen(true)
      : undefined;
  const sidebarShown = sidebarView && sidebarOpen;
  // The member's Pinned and Recent agents: one pending list for the sidebar's
  // pin buttons and the desk menu, so a pin from either builds on the other.
  const pins = useSidebarPins();

  // The pages and the chat, as before the sidebar. The Agent settings page
  // takes the place of the view it opened over.
  const content =
    agentPage && agentPageAgent ? (
      <EditAgentDialog
        // One form per agent: another agent's page starts from its own.
        key={agentPageAgent.id}
        // The live record, so a change the server sends while the page is
        // open (limitedClaudeFamilies after a variables save) reaches it.
        agent={agentPageAgent}
        initialSection={agentPage.section}
        covered={
          ctxMenu !== null ||
          sidebarSpawn !== null ||
          spawnPickerDesk !== null ||
          spawnBackOpen
        }
        onClose={() => setAgentPage(null)}
      />
    ) : page === "settings" ? (
      <UserSettingsView
        key={settingsDoor}
        initialUserId={editingUserId}
        initialTarget={settingsTarget}
        onSwitchUser={(name) => setUsername(name)}
        onClose={closePage}
      />
    ) : page === "tasks" ? (
      <TaskView
        onClose={closeTasks}
        openTaskRequest={taskOpenRequest}
        onTaskOpenRequestHandled={() => setTaskOpenRequest(null)}
        onFocusAgent={openAgentChat}
      />
    ) : page === "cronjobs" ? (
      <CronjobsView onClose={closePage} onFocusAgent={openAgentChat} />
    ) : page === "apps" ? (
      <AppsView onClose={closePage} onFocusAgent={openAgentChat} />
    ) : page === "skills" ? (
      <SkillsView onClose={closePage} />
    ) : page === "integrations" ? (
      <IntegrationsView
        onClose={closePage}
        request={integrationsRequest}
        onRequestHandled={clearIntegrationsRequest}
      />
    ) : page === "asks" ? (
      <InboxView onClose={closePage} chatOpen={inboxChat !== null}>
        <AsksView
          onFocusAgent={openAgentChat}
          onChatAgent={setInboxChat}
          focusAskId={askFocus}
          onClearFocus={clearAskFocus}
          filterAgentId={askAgentFilter}
          onFilterAgentHandled={clearAskAgentFilter}
        />
        {inboxChat && (
          <AgentChatPanel
            agentId={inboxChat}
            onSelectAgent={setInboxChat}
            onClose={() => setInboxChat(null)}
            onOpenFullChat={openAgentChat}
          />
        )}
      </InboxView>
    ) : openHumanChat ? (
      <HumanChatView
        // One view per chat: its load state and errors stay with it.
        key={humanChatId(openHumanChat)}
        chat={openHumanChat}
        onBack={goHome}
        onSelectChat={openHumanChatView}
        onOpenMemberSettings={openMemberSettings}
        sidebarOpen={sidebarShown}
        onShowSidebar={showSidebar}
      />
    ) : focusedAgent ? (
      <LogView
        key={focusedAgent.id}
        agent={focusedAgent}
        logs={logs.get(focusedAgent.id) ?? []}
        onBack={closeLog}
        onEditAgent={(section) => openAgentSettings(focusedAgent.id, section)}
        onOpenTasks={openTasks}
        onOpenTask={openTask}
        onOpenInbox={openInbox}
        onSwipeLeft={swipeAgentNext}
        onSwipeRight={swipeAgentPrev}
        sidebarOpen={sidebarShown}
        onShowSidebar={showSidebar}
      />
    ) : (
      <OfficeView
        onSpawn={(desk) => {
          if (canSpawn) setSpawnPickerDesk(desk);
        }}
        onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
        onOpenBackRoom={() => setBackRoomOpen(true)}
        backRoomOpen={backRoomOpen}
        onCloseBackRoom={goHome}
        onSpawnBack={() => {
          if (canSpawn) setSpawnBackOpen(true);
        }}
        onOpenSettings={() => openSettings(null)}
        onOpenUserSettingsForUser={openMemberSettings}
        onEditOfficePrompt={() =>
          openSettings({ kind: "section", section: "office" })
        }
        onEditRoomSettings={(roomId) => openSettings({ kind: "room", roomId })}
        onOpenThemePicker={() =>
          openSettings({ kind: "section", section: "theme" })
        }
        onOpenTasks={openTasks}
        onOpenCronjobs={() => changePages({ type: "open", page: "cronjobs" })}
        onOpenApps={() => changePages({ type: "open", page: "apps" })}
        onOpenSkills={() => changePages({ type: "open", page: "skills" })}
        onOpenIntegrations={() => openIntegrations()}
        onOpenInbox={openInbox}
        onOpenUpdate={() =>
          openSettings({ kind: "section", section: "updates" })
        }
        onSwipeLeft={swipeRoomNext}
        onSwipeRight={swipeRoomPrev}
        viewportControlsRef={viewportControlsRef}
        sidebarOpen={sidebarShown}
        onShowSidebar={showSidebar}
        onOpenMembersChat={() => openHumanChatView(MEMBERS_CHAT)}
      />
    );

  // A sidebar row that leaves the page on top asks the page first, so its
  // unsaved edits go through its own discard prompt.
  const leaveThen = useCallback((go: () => void) => {
    const guard = leaveGuardRef.current;
    if (guard) guard(go);
    else go();
  }, []);
  // A drawer row: the drawer closes first, so a page's discard prompt never
  // shows under it.
  const leaveFromDrawer = useCallback(
    (go: () => void) => {
      setPhoneDrawer(false);
      leaveThen(go);
    },
    [leaveThen],
  );
  const openSidebarPage = (target: SidebarPage) => {
    if (target === "tasks") openTasks();
    else if (target === "integrations") openIntegrations();
    else changePages({ type: "open", page: target });
  };
  // A room header's "+": its first free front desk, else its back room.
  const spawnFromSidebar = (roomId: string) =>
    setSidebarSpawn({ roomId, desk: newAgentSeat(agents, roomId) });
  // The sidebar, beside the view on a desktop or in the phone's drawer.
  // `then` runs a row that leaves for another view. The pin, the
  // context menu and the dialogs (agent settings, a room's "+") open over
  // the drawer and keep it.
  const chatSidebar = ({
    closing,
    onCollapse,
    then,
  }: {
    closing: boolean;
    onCollapse: () => void;
    then: (go: () => void) => void;
  }) => (
    <ChatSidebar
      closing={closing}
      pins={pins}
      onRoomSettings={(roomId) =>
        then(() => openSettings({ kind: "room", roomId }))
      }
      onOfficeSettings={() =>
        then(() => openSettings({ kind: "section", section: "office" }))
      }
      openAgentId={focusedAgent?.id ?? null}
      page={page}
      officeShown={page === null && !focusedAgent && openHumanChat === null}
      backRoomOpen={backRoomOpen}
      viewReady={restored || (!persistEnabled && hasReceivedInitialState)}
      onCollapse={onCollapse}
      onOffice={() => then(goOffice)}
      onNewAgent={canSpawn ? spawnFromSidebar : null}
      onOpenPage={(target) => then(() => openSidebarPage(target))}
      onOpenAgent={(agentId) => then(() => openAgentChat(agentId))}
      onAgentContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
      onAgentSettings={(agent) => then(() => openAgentSettings(agent.id))}
      onOpenHumanChat={(chat) => then(() => openHumanChatView(chat))}
      onOpenMemberSettings={(userId) => then(() => openMemberSettings(userId))}
      onOpenSettings={() => {
        if (page !== "settings") then(() => openSettings(null));
      }}
    />
  );

  return (
    <OfficeLinkOpener.Provider value={openOfficeLink}>
      <AskSignInResult.Provider value={askSignInResult}>
        <TaskOpener.Provider value={openTask}>
          {/* Before AskRefsProvider, so its snapshot of the store is fresh
              before the chips' layout effects of the same commit. */}
          <TaskLookupBridge />
          <LogPrefetcher backOpen={backRoomOpen} />
          <AskRefsProvider open={openAsk}>
            <style>{CSS + OFFICE_PAGE_CSS}</style>
            <LinkedImageLightbox />
            <ConnectionBanner />
            <UpdateOverlay />
            <UiBuildNotice />
            {sidebarView ? (
              <div
                data-chat-shell=""
                style={{
                  display: "flex",
                  height: "calc(100vh - var(--banner-h, 0px))",
                }}
              >
                <SidebarSlot open={sidebarOpen}>
                  {(closing) =>
                    chatSidebar({
                      closing,
                      onCollapse: () => setSidebarOpen(false),
                      then: leaveThen,
                    })
                  }
                </SidebarSlot>
                <div style={{ flex: 1, minWidth: 0, height: "100%" }}>
                  <PageLeaveGuard.Provider value={leaveGuardRef}>
                    {content}
                  </PageLeaveGuard.Provider>
                </div>
              </div>
            ) : (
              content
            )}
            {drawerShown && (
              <PhoneSidebarDrawer onClose={closeDrawer}>
                {() =>
                  chatSidebar({
                    closing: false,
                    onCollapse: closeDrawer,
                    then: leaveFromDrawer,
                  })
                }
              </PhoneSidebarDrawer>
            )}
            {spawnBackOpen && currentRoomId && (
              <EditAgentDialog
                deskIndex={null}
                defaultCwd={newAgentCwd}
                spawnAgentType="claude"
                roomId={currentRoomId}
                onClose={() => setSpawnBackOpen(false)}
              />
            )}
            {sidebarSpawn && (
              <EditAgentDialog
                deskIndex={sidebarSpawn.desk}
                defaultCwd={
                  rooms.find((r) => r.id === sidebarSpawn.roomId)?.cwd ?? "~"
                }
                spawnAgentType="claude"
                roomId={sidebarSpawn.roomId}
                onClose={() => setSidebarSpawn(null)}
              />
            )}
            {spawnPickerDesk !== null && currentRoomId && (
              <EditAgentDialog
                deskIndex={spawnPickerDesk}
                defaultCwd={newAgentCwd}
                spawnAgentType="claude"
                roomId={currentRoomId}
                onClose={() => setSpawnPickerDesk(null)}
              />
            )}
            {ctxMenu && (
              <ContextMenu
                x={ctxMenu.x}
                y={ctxMenu.y}
                agent={ctxMenu.agent}
                onClose={() => setCtxMenu(null)}
                onEdit={(agent) => {
                  setCtxMenu(null);
                  leaveThen(() => openAgentSettings(agent.id));
                }}
                pin={
                  sidebarView || phoneSidebar
                    ? {
                        pinned: pins.pinned.includes(ctxMenu.agent.id),
                        onToggle: () => pins.togglePin(ctxMenu.agent.id),
                      }
                    : undefined
                }
              />
            )}
          </AskRefsProvider>
        </TaskOpener.Provider>
      </AskSignInResult.Provider>
    </OfficeLinkOpener.Provider>
  );
}
