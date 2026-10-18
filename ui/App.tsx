import { ordinaryRooms } from "../shared/types.ts";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAppState, useDispatch, useFeatures } from "./store.tsx";
import { send } from "./ws.ts";
import {
  loadSavedView,
  loadUserDrafts,
  pruneUserDrafts,
  saveDraft,
  saveView,
} from "./view-persistence.ts";
import { OfficeView, type ViewportControls } from "./office/OfficeView.tsx";
import { LogView } from "./log-view/LogView.tsx";
import { restoreOutbox } from "./log-view/outbox.ts";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { EditAgentDialog } from "./components/EditAgentDialog.tsx";
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
import { PagerView, type PagerSelectRequest } from "./components/PagerView.tsx";
import { usePagerSync } from "./pager-sync.ts";
import { useActionablesSync } from "./actionables-sync.ts";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { UpdateOverlay } from "./components/UpdateOverlay.tsx";
import { CSS } from "./styles.ts";
import { getUsername, getDevice } from "./device-settings.ts";
import { languageSeed } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";
import { apiFetch } from "./api.ts";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import { agentTabLabel } from "./agent-face.ts";
import { LOBBY_ROOM_ID, type AgentInfo } from "../shared/types.ts";
import {
  selfTuckedRooms,
  swipeTarget,
  tabBarRooms,
} from "./office/room-cycle.ts";
import { isValidDesk, isBackSeat, hasBackRoom } from "../shared/desks.ts";
import { cycleAgent } from "./agent-cycle.ts";
import {
  pageForLocation,
  pageForPath,
  pagerIdForSearch,
  mcpSignInForSearch,
  pathForPage,
  pageForFlags,
  pageUnder,
  pageShortcut,
  backRoomShortcut,
  type Page,
} from "./routes.ts";

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
    entry.page === "pager"
    ? entry.page
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
  const {
    agents,
    logs,
    focusedAgentId,
    drafts,
    currentRoomId,
    rooms: allRooms,
    office,
    connected,
    sessionContext,
    hasReceivedInitialState,
    lobbyOpen,
    users,
  } = useAppState();
  const features = useFeatures();
  const rooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  const roomCount = rooms.length;
  const dispatch = useDispatch();
  // Clicking an empty slot opens the complete spawn form. Engine is one of its
  // fields, so the user can configure the agent in either order.
  const [spawnPickerDesk, setSpawnPickerDesk] = useState<number | null>(null);
  // The spawn dialog for a back room seat (the back screen's "+ New agent").
  const [spawnBackOpen, setSpawnBackOpen] = useState(false);
  // The current room's back room screen (task 5b503e32). Not a route: like a
  // chat it is one level deep, and a reload lands on the front.
  const [backRoomOpen, setBackRoomOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    agent: AgentInfo;
  } | null>(null);
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  // The display name is tracked for the user-switch handler, but the server now
  // derives message attribution from the session identity (the send/edit routes
  // no longer carry a username), so the value itself is no longer read in the UI.
  const [, setUsername] = useState<string | null>(() => getUsername());
  // The page the URL asked for, read once at mount. Every page flag below
  // starts from it, so a shared link renders its page on the FIRST paint - no
  // flash of the office, and no wait for the websocket.
  // A Discord page link (`/?pager=<id>`) opens the pager on that page.
  const [bootPage] = useState(() =>
    pageForLocation(window.location.pathname, window.location.search),
  );
  // Full-page Settings (like tasks/cronjobs): part of the main view
  // switch, closed via closePage/popstate.
  const [usersOpen, setUsersOpen] = useState(bootPage === "settings");
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
  const [tasksOpen, setTasksOpen] = useState(bootPage === "tasks");
  const [taskOpenRequest, setTaskOpenRequest] =
    useState<TaskOpenRequest | null>(null);
  const [cronjobsOpen, setCronjobsOpen] = useState(bootPage === "cronjobs");
  const [appsOpen, setAppsOpen] = useState(bootPage === "apps");
  const [skillsOpen, setSkillsOpen] = useState(bootPage === "skills");
  const [integrationsOpen, setIntegrationsOpen] = useState(
    bootPage === "integrations",
  );
  // One-shot: what the Integrations page opens on, beyond its defaults: an
  // MCP sign-in that came back carries its result (read once, like the pager
  // id below), and a door that names a tab carries the tab. The page takes it
  // on mount and clears it.
  const [integrationsRequest, setIntegrationsRequest] =
    useState<IntegrationsRequest | null>(() => {
      const signIn = mcpSignInForSearch(window.location.search);
      return signIn === null ? null : { signIn };
    });
  const clearIntegrationsRequest = useCallback(
    () => setIntegrationsRequest(null),
    [],
  );
  const [pagerOpen, setPagerOpen] = useState(bootPage === "pager");
  // Read once, like bootPage. The sync effect below rewrites the URL to
  // /pager, so the id lives here until the view has shown it.
  const [pagerSelectRequest, setPagerSelectRequest] =
    useState<PagerSelectRequest | null>(() => {
      const id = pagerIdForSearch(window.location.search);
      return id === null ? null : { id };
    });
  const clearPagerSelectRequest = useCallback(
    () => setPagerSelectRequest(null),
    [],
  );
  usePagerSync();
  useActionablesSync();

  // Refresh persistence: reopen the same spot (room / agent chat / tasks /
  // cronjobs) after a page reload, and restore unsent chat drafts. The
  // restore runs ONCE, after the first full_state, so every saved id can be
  // validated against what actually still exists - a killed agent, a closed
  // room, or lost access silently falls back to the normal default view (the
  // first visible room, which full_state already selected; the restore only
  // overrides it when the saved room is still valid). Without a saved view,
  // every member starts on the lobby. Gated off in the demo
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
    // has to land last to win.
    if (saved.lobby) dispatch({ type: "set_lobby_open", open: true });
    if (saved.agentId && agents.some((a) => a.id === saved.agentId)) {
      dispatch({ type: "focus", agentId: saved.agentId });
    }
    // Ruling 4: a page in the URL wins over the saved panel, and it is already
    // open from the first render. The saved spot still supplies room and agent
    // above, so a shared /tasks link lands on the task page over the chat the
    // reader left open.
    if (bootPage !== null) return;
    if (saved.panel === "tasks") setTasksOpen(true);
    else if (saved.panel === "cronjobs") setCronjobsOpen(true);
    else if (saved.panel === "apps") setAppsOpen(true);
    else if (saved.panel === "skills") setSkillsOpen(true);
    else if (saved.panel === "integrations") setIntegrationsOpen(true);
    else if (saved.panel === "pager") setPagerOpen(true);
    // "users" is the old name for the same page; a spot saved by an earlier
    // build still reopens it.
    else if (saved.panel === "settings" || saved.panel === "users")
      setUsersOpen(true);
  }, [
    bootPage,
    persistEnabled,
    restored,
    hasReceivedInitialState,
    persistUser,
    agents,
    rooms,
    dispatch,
  ]);

  // Save the view spot whenever it changes (post-restore only).
  useEffect(() => {
    if (!persistEnabled || !restored || !persistUser) return;
    saveView(persistUser, {
      roomId: currentRoomId,
      agentId: focusedAgentId,
      lobby: lobbyOpen,
      panel: usersOpen
        ? "settings"
        : tasksOpen
          ? "tasks"
          : cronjobsOpen
            ? "cronjobs"
            : appsOpen
              ? "apps"
              : skillsOpen
                ? "skills"
                : integrationsOpen
                  ? "integrations"
                  : pagerOpen
                    ? "pager"
                    : null,
    });
  }, [
    persistEnabled,
    restored,
    persistUser,
    currentRoomId,
    focusedAgentId,
    tasksOpen,
    cronjobsOpen,
    appsOpen,
    skillsOpen,
    integrationsOpen,
    pagerOpen,
    usersOpen,
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
  // On the Lobby tab the title is the office name, never "Lobby" (Nil).
  const tabLabel =
    focusedAgentName !== null
      ? agentTabLabel(focusedAgentName, focusedAgentState ?? "idle")
      : lobbyOpen
        ? (office.name ?? null)
        : (currentRoomName ?? office.name ?? null);
  useEffect(() => {
    if (!connected) return;
    document.title = tabLabel ? `${tabLabel} | Isomux` : "Isomux";
  }, [connected, tabLabel]);

  // Phone swipes walk the tab bar in order, the Lobby included (Nil): the
  // order lives in swipeTarget. Selecting a room closes the lobby; opening the
  // lobby leaves the room selection alone, like the Lobby tab does.
  const selfId = sessionContext?.userId ?? null;
  const tucked = useMemo(
    () => selfTuckedRooms(users.values(), selfId),
    [users, selfId],
  );
  const swipeRoom = useCallback(
    (direction: "next" | "prev") => {
      const tabs = tabBarRooms(rooms, tucked, currentRoomId, lobbyOpen);
      const target = swipeTarget(tabs, currentRoomId, lobbyOpen, direction);
      if (!target) return;
      if (target.kind === "lobby")
        dispatch({ type: "set_lobby_open", open: true });
      else dispatch({ type: "set_current_room", roomId: target.roomId });
    },
    [dispatch, rooms, tucked, currentRoomId, lobbyOpen],
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

  // Live-avatars: tell the server where this session's ghost should
  // appear. Fires whenever any of the relevant view states change, plus
  // once on session_context arrival (so a fresh WS gets the initial
  // position registered without waiting for user input). The server
  // dedupes on its end so identical updates don't cascade into a
  // broadcast.
  const viewMode: "office" | "log" | "away" =
    tasksOpen ||
    cronjobsOpen ||
    appsOpen ||
    skillsOpen ||
    integrationsOpen ||
    pagerOpen ||
    usersOpen
      ? "away"
      : focusedAgentId
        ? "log"
        : "office";
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
      // Read device inline rather than as a dep so we don't need to
      // wire a localStorage-change subscription. Device-label edits
      // happen in DeviceSettings, whose close transitions viewMode
      // and refires this effect with the fresh value.
      device: getDevice(),
    });
  }, [sessionContext, presenceRoomId, focusedAgentId, viewMode]);

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

  // Each page's open flag, and the one-shot state that belongs to it and is
  // cleared whenever it closes. applyPage and closeTopPage both work from it.
  const pageState = useMemo(
    (): Record<
      Page,
      { setOpen: (open: boolean) => void; clear: () => void }
    > => ({
      settings: {
        setOpen: setUsersOpen,
        clear: () => {
          setEditingUserId(null);
          setSettingsTarget(null);
        },
      },
      tasks: { setOpen: setTasksOpen, clear: () => setTaskOpenRequest(null) },
      cronjobs: { setOpen: setCronjobsOpen, clear: () => {} },
      apps: { setOpen: setAppsOpen, clear: () => {} },
      skills: { setOpen: setSkillsOpen, clear: () => {} },
      integrations: {
        setOpen: setIntegrationsOpen,
        clear: () => setIntegrationsRequest(null),
      },
      pager: {
        setOpen: setPagerOpen,
        clear: () => setPagerSelectRequest(null),
      },
    }),
    [],
  );

  // The one place a page is applied from outside the UI - boot and popstate.
  // Exactly one flag is set and the others are cleared, so no restore can
  // leave two pages open. The settings section and the preselected user are
  // deliberately dropped: neither is part of a route (ruling 3), so a Forward
  // into settings lands on the generic page instead of resurrecting whichever
  // row was open last time.
  const applyPage = useCallback(
    (page: Page | null) => {
      for (const [p, { setOpen, clear }] of Object.entries(pageState)) {
        setOpen(p === page);
        clear();
      }
    },
    [pageState],
  );

  // Open the settings page, optionally on a named row. Passing null is the
  // generic open (the bar's User button), which must CLEAR any section left
  // over from a previous visit rather than reopening it.
  const openSettings = useCallback((target: SettingsTarget | null) => {
    setSettingsTarget(target);
    setUsersOpen(true);
  }, []);

  // Integrations replaces every open page, so the one door that opens it over
  // another page (the Settings pointer to Browser Use, task f2d5cf9f) leaves
  // no page stacked under it.
  const openIntegrations = useCallback(
    (request?: IntegrationsRequest) => {
      applyPage("integrations");
      setIntegrationsRequest(request ?? null);
    },
    [applyPage],
  );

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
    setBackRoomOpen(false);
  }, [applyPage, dispatch]);

  // Which page is showing, in the same precedence as the view switch below. A
  // chat is not a page: agent chats are not routes (ruling 3), so a chat and
  // the office share the path "/".
  const pageFlags = {
    usersOpen,
    tasksOpen,
    cronjobsOpen,
    appsOpen,
    skillsOpen,
    integrationsOpen,
    pagerOpen,
  };
  const pageBelow = pageUnder(pageFlags);
  const page = pageForFlags(pageFlags);

  // Pages close top first, back to what they were opened over (tasks 586b63a5
  // and d6c09d1c): the page under the top one when two are stacked, else the
  // chat. Gate on the resolved agent, not the id, so a chat whose agent
  // disappeared while a page was open closes to the office instead of a stale
  // focus.
  const somethingUnderPage =
    page !== null && (pageBelow !== null || !!focusedAgent);

  // Drop only the page on top, with the state that belongs to it. Focus and
  // the history entry stay: we stay deep, so the sync effect replaces the
  // entry instead of pushing, and Back from what is uncovered still lands on
  // the office.
  const closeTopPage = useCallback(() => {
    if (page === null) return;
    pageState[page].setOpen(false);
    pageState[page].clear();
  }, [page, pageState]);

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
    setTasksOpen(true);
  }, []);

  const openTask = useCallback((id: string) => {
    setTaskOpenRequest({ id });
    setTasksOpen(true);
  }, []);

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape") {
        closeLog();
        setSpawnPickerDesk(null);
        setCtxMenu(null);
        setEditAgent(null);
      }
      const pageUpdate = pageShortcut(
        {
          key: e.key,
          isInput,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        },
        {
          usersOpen,
          tasksOpen,
          cronjobsOpen,
          appsOpen,
          skillsOpen,
          integrationsOpen,
          pagerOpen,
        },
      );
      if (pageUpdate !== null) {
        e.preventDefault();
        if (pageUpdate === "home") closePage();
        else {
          if (pageUpdate.tasksOpen !== undefined)
            setTasksOpen(pageUpdate.tasksOpen);
          if (pageUpdate.cronjobsOpen !== undefined)
            setCronjobsOpen(pageUpdate.cronjobsOpen);
          if (pageUpdate.appsOpen !== undefined)
            setAppsOpen(pageUpdate.appsOpen);
          if (pageUpdate.skillsOpen !== undefined)
            setSkillsOpen(pageUpdate.skillsOpen);
          if (pageUpdate.integrationsOpen !== undefined)
            setIntegrationsOpen(pageUpdate.integrationsOpen);
          if (pageUpdate.pagerOpen !== undefined)
            setPagerOpen(pageUpdate.pagerOpen);
          // "s" opens the settings of the room you are standing in; the lobby
          // has no room row, so it opens the office row instead (Nil, 2026-09-14).
          if (pageUpdate.usersOpen)
            openSettings(
              !lobbyOpen && currentRoomId
                ? { kind: "room", roomId: currentRoomId }
                : { kind: "section", section: "office" },
            );
        }
      }
      const backRoomKey = backRoomShortcut(
        {
          key: e.key,
          isInput,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
        },
        {
          hasBackRoom:
            !lobbyOpen &&
            hasBackRoom(rooms.find((r) => r.id === currentRoomId)),
          backRoomOpen,
          covered: !!focusedAgentId || page !== null,
        },
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
      // Tab/Shift+Tab in office view: switch rooms
      if (
        !isInput &&
        !focusedAgentId &&
        e.key === "Tab" &&
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
    return () => window.removeEventListener("keydown", handleKey);
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
    usersOpen,
    appsOpen,
    skillsOpen,
    integrationsOpen,
    tasksOpen,
    cronjobsOpen,
    pagerOpen,
    openSettings,
    lobbyOpen,
    backRoomOpen,
    page,
  ]);

  const isDeep = page !== null || focusedAgentId !== null || backRoomOpen;
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
  }, [isDeep, focusedAgentId, page, routing]);

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
      setBackRoomOpen(false);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyPage, dispatch, somethingUnderPage, closeTopPage, logOverBackRoom]);

  return (
    <>
      <style>{CSS}</style>
      <ConnectionBanner />
      <UpdateOverlay />
      {page === "settings" ? (
        <UserSettingsView
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
          onFocusAgent={(agentId) => {
            setTasksOpen(false);
            dispatch({ type: "focus", agentId });
          }}
        />
      ) : page === "cronjobs" ? (
        <CronjobsView
          onClose={closePage}
          onFocusAgent={(agentId) => {
            setCronjobsOpen(false);
            dispatch({ type: "focus", agentId });
          }}
        />
      ) : page === "apps" ? (
        <AppsView
          onClose={closePage}
          onFocusAgent={(agentId) => {
            setAppsOpen(false);
            dispatch({ type: "focus", agentId });
          }}
        />
      ) : page === "skills" ? (
        <SkillsView onClose={closePage} />
      ) : page === "integrations" ? (
        <IntegrationsView
          onClose={closePage}
          request={integrationsRequest}
          onRequestHandled={clearIntegrationsRequest}
        />
      ) : page === "pager" ? (
        <PagerView
          onClose={closePage}
          selectRequest={pagerSelectRequest}
          onSelectRequestHandled={clearPagerSelectRequest}
          onFocusAgent={(agentId) => {
            setPagerOpen(false);
            dispatch({ type: "focus", agentId });
          }}
          onOpenPagerSettings={() => {
            setPagerOpen(false);
            openSettings({ kind: "section", section: "pager" });
          }}
        />
      ) : focusedAgent ? (
        <LogView
          key={focusedAgent.id}
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={closeLog}
          onEditAgent={() => setEditAgent(focusedAgent)}
          onOpenTasks={openTasks}
          onOpenTask={openTask}
          onSwipeLeft={swipeAgentNext}
          onSwipeRight={swipeAgentPrev}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnPickerDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          onOpenBackRoom={() => setBackRoomOpen(true)}
          backRoomOpen={backRoomOpen}
          onCloseBackRoom={goHome}
          onSpawnBack={() => setSpawnBackOpen(true)}
          onOpenSettings={() => openSettings(null)}
          onOpenUserSettingsForUser={(userId) => {
            setEditingUserId(userId);
            openSettings(null);
          }}
          onEditOfficePrompt={() =>
            openSettings({ kind: "section", section: "office" })
          }
          onEditRoomSettings={(roomId) =>
            openSettings({ kind: "room", roomId })
          }
          onOpenThemePicker={() =>
            openSettings({ kind: "section", section: "theme" })
          }
          onOpenTasks={openTasks}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenApps={() => setAppsOpen(true)}
          onOpenSkills={() => setSkillsOpen(true)}
          onOpenIntegrations={() => openIntegrations()}
          onOpenPager={() => setPagerOpen(true)}
          onOpenUpdate={() =>
            openSettings({ kind: "section", section: "updates" })
          }
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
          viewportControlsRef={viewportControlsRef}
        />
      )}
      {spawnBackOpen && currentRoomId && (
        <EditAgentDialog
          deskIndex={null}
          defaultCwd="~"
          spawnAgentType="claude"
          roomId={currentRoomId}
          onClose={() => setSpawnBackOpen(false)}
        />
      )}
      {spawnPickerDesk !== null && currentRoomId && (
        <EditAgentDialog
          deskIndex={spawnPickerDesk}
          defaultCwd="~"
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
            setEditAgent(agent);
            setCtxMenu(null);
          }}
        />
      )}
      {editAgent && (
        <EditAgentDialog
          // The live record, so a change the server sends while the dialog
          // is open (limitedClaudeFamilies after a variables save) reaches it.
          agent={agents.find((a) => a.id === editAgent.id) ?? editAgent}
          onClose={() => setEditAgent(null)}
        />
      )}
    </>
  );
}
