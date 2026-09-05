import { useState, useEffect, useCallback, useRef } from "react";
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
import { AgentListView } from "./components/AgentListView.tsx";
import { ContextMenu } from "./components/ContextMenu.tsx";
import { EditAgentDialog } from "./components/EditAgentDialog.tsx";
import {
  UserSettingsView,
  type Selection as SettingsTarget,
} from "./components/UserSettingsView.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { CronjobsView } from "./components/CronjobsView.tsx";
import { AppsView } from "./components/AppsView.tsx";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { CSS } from "./styles.ts";
import { getUsername, getDevice } from "./device-settings.ts";
import { languageSeed } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";
import { apiFetch } from "./api.ts";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import { agentTabLabel } from "./agent-face.ts";
import type { AgentInfo } from "../shared/types.ts";
import { isValidDesk } from "../shared/desks.ts";
import { pageForPath, pathForPage, type Page } from "./routes.ts";

/** Cycle to the next/previous agent in the current room, matching Tab/Shift+Tab logic. */
function cycleAgent(
  agents: AgentInfo[],
  drafts: Map<string, string>,
  currentRoomId: string | null,
  focusedAgentId: string | null,
  direction: "next" | "prev",
): string | null {
  const roomAgents = agents.filter((a) => a.roomId === currentRoomId);
  const sorted = [...roomAgents].sort((a, b) => a.desk - b.desk);
  const nonIdle = sorted.filter(
    (a) =>
      (a.state !== "idle" && a.state !== "stopped") ||
      (drafts.get(a.id) ?? "").length > 0,
  );
  const pool = nonIdle.length > 0 ? nonIdle : sorted;
  if (pool.length === 0) return null;
  const idx = pool.findIndex((a) => a.id === focusedAgentId);
  if (idx !== -1 && pool.length <= 1) return null;
  const next =
    idx === -1
      ? direction === "prev"
        ? pool[pool.length - 1]
        : pool[0]
      : direction === "prev"
        ? pool[(idx - 1 + pool.length) % pool.length]
        : pool[(idx + 1) % pool.length];
  return next.id;
}

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
    entry.page === "settings"
    ? entry.page
    : undefined;
}

/**
 * `routing` is how the app is DEPLOYED, not something it can work out for
 * itself. The office owns its origin's root, so its four full-page views are
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
    isMobile,
    mobileViewMode,
    drafts,
    currentRoomId,
    rooms,
    office,
    connected,
    sessionContext,
    hasReceivedInitialState,
  } = useAppState();
  const features = useFeatures();
  const roomCount = rooms.length;
  const dispatch = useDispatch();
  // Clicking an empty slot opens the complete spawn form. Engine is one of its
  // fields, so the user can configure the agent in either order.
  const [spawnPickerDesk, setSpawnPickerDesk] = useState<number | null>(null);
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
  const [bootPage] = useState(() => pageForPath(window.location.pathname));
  // Full-page Settings (like tasks/cronjobs): part of the main view
  // switch, closed via goHome/popstate.
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
  const [cronjobsOpen, setCronjobsOpen] = useState(bootPage === "cronjobs");
  const [appsOpen, setAppsOpen] = useState(bootPage === "apps");

  // Refresh persistence: reopen the same spot (room / agent chat / tasks /
  // cronjobs) after a page reload, and restore unsent chat drafts. The
  // restore runs ONCE, after the first full_state, so every saved id can be
  // validated against what actually still exists - a killed agent, a closed
  // room, or lost access silently falls back to the normal default view (the
  // first visible room, which full_state already selected; the restore only
  // overrides it when the saved room is still valid). Gated off in the demo
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
    const saved = loadSavedView(persistUser);
    if (!saved) return;
    // Room and agent restore independently on purpose: agents can be moved
    // across rooms, and the view selection deliberately doesn't follow the
    // focused agent (matches live behavior in the presence effect below).
    if (saved.roomId && rooms.some((r) => r.id === saved.roomId)) {
      dispatch({ type: "set_current_room", roomId: saved.roomId });
    }
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
      panel: usersOpen
        ? "settings"
        : tasksOpen
          ? "tasks"
          : cronjobsOpen
            ? "cronjobs"
            : appsOpen
              ? "apps"
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
    usersOpen,
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
  const tabLabel =
    focusedAgentName !== null
      ? agentTabLabel(focusedAgentName, focusedAgentState ?? "idle")
      : (currentRoomName ?? office.name ?? null);
  useEffect(() => {
    if (!connected) return;
    document.title = tabLabel ? `${tabLabel} | Isomux` : "Isomux";
  }, [connected, tabLabel]);

  const swipeRoomNext = useCallback(() => {
    if (roomCount <= 1) return;
    const idx = rooms.findIndex((r) => r.id === currentRoomId);
    const next = rooms[(idx + 1) % roomCount];
    if (next) dispatch({ type: "set_current_room", roomId: next.id });
  }, [dispatch, rooms, currentRoomId, roomCount]);

  const swipeRoomPrev = useCallback(() => {
    if (roomCount <= 1) return;
    const idx = rooms.findIndex((r) => r.id === currentRoomId);
    const prev = rooms[(idx - 1 + roomCount) % roomCount];
    if (prev) dispatch({ type: "set_current_room", roomId: prev.id });
  }, [dispatch, rooms, currentRoomId, roomCount]);

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
    tasksOpen || cronjobsOpen || appsOpen || usersOpen
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
  const presenceRoomId = focusedAgent?.roomId ?? currentRoomId;
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
  // UI level: tasks opened over a chat pops back to that chat first (the
  // popstate handler re-pushes the entry), then to the office. Every "return
  // to office" path goes through goHome(), which gets there one of two ways
  // depending on the ref below - history.back() when we pushed the entry, and
  // a replace when we did not.

  // How the CURRENT history entry relates to us, which is what ruling 8 turns
  // on. "none": no page open, the office sits on whatever entry the load made.
  // "adopted": a page is open on an entry we did NOT push - a shared link
  // opened cold - so the browser's Back leaves the site and goHome() has to
  // replace instead. "pushed": a page is open on an entry we pushed, and Back
  // returns to what is underneath, as it always did.
  const entryRef = useRef<"none" | "adopted" | "pushed">(
    bootPage === null ? "none" : "adopted",
  );

  // The one place a page is applied from outside the UI - boot and popstate.
  // Exactly one flag is set and the other three are cleared, so no restore can
  // leave two pages open. The settings section and the preselected user are
  // deliberately dropped: neither is part of a route (ruling 3), so a Forward
  // into settings lands on the generic page instead of resurrecting whichever
  // row was open last time.
  const applyPage = useCallback((page: Page | null) => {
    setTasksOpen(page === "tasks");
    setCronjobsOpen(page === "cronjobs");
    setAppsOpen(page === "apps");
    setUsersOpen(page === "settings");
    setEditingUserId(null);
    setSettingsTarget(null);
  }, []);

  // Open the settings page, optionally on a named row. Passing null is the
  // generic open (the bar's User button), which must CLEAR any section left
  // over from a previous visit rather than reopening it.
  const openSettings = useCallback((target: SettingsTarget | null) => {
    setSettingsTarget(target);
    setUsersOpen(true);
  }, []);

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
  }, [applyPage, dispatch]);

  // Tasks opened over a chat: the focused agent stays set while TaskView
  // renders on top of it (render priority: tasks > log), so "return to the
  // chat" is just dropping the tasks flag. Gate on the resolved agent, not
  // the id, so a chat whose agent disappeared while tasks was open falls
  // back to the office path instead of a stale focus.
  const tasksOverChat = tasksOpen && !!focusedAgent;

  // Closing the task view returns to the chat it was opened from, when there
  // is one; otherwise to the office (goHome). Dropping only the tasks flag
  // keeps us one level deep, so the history entry survives (deep→deep is a
  // replaceState in the sync effect below) and a subsequent Back/Escape from
  // the chat still lands on the office.
  const closeTasks = useCallback(() => {
    if (tasksOverChat) setTasksOpen(false);
    else goHome();
  }, [tasksOverChat, goHome]);

  // Keyboard shortcuts: Escape → office, 1-8 → jump to agent at desk
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape") {
        goHome();
        setSpawnPickerDesk(null);
        setCtxMenu(null);
        setEditAgent(null);
      }
      // "t": toggle the task board from anywhere (office view or while viewing an
      // agent), as long as you're not typing into a field. Disabled while the
      // Settings page is open - jumping away from it would bypass its
      // unsaved-edits check.
      if (
        !isInput &&
        e.key === "t" &&
        !usersOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setTasksOpen((v) => !v);
      }
      // "s": open the Settings page from anywhere, the same way "t" reaches
      // the task board. It only OPENS - pressing it again does not close the
      // page, because leaving that way would skip its unsaved-edits check.
      // Escape (handled by the page itself) is the way back out.
      if (
        !isInput &&
        e.key === "s" &&
        !usersOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        openSettings(null);
      }
      // Viewport zoom/pan shortcuts (only from office view): 0 → reset, +/= → zoom in, - → zoom out.
      // "=" accepted as an alias for "+" so users don't need Shift on US layouts.
      // Ref is null when OfficeView isn't mounted (mobile list, log view, etc.) - don't swallow the key in those cases.
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
        const idx = rooms.findIndex((r) => r.id === currentRoomId);
        const nextIdx = e.shiftKey
          ? (idx - 1 + roomCount) % roomCount
          : (idx + 1) % roomCount;
        const next = rooms[nextIdx];
        if (next) dispatch({ type: "set_current_room", roomId: next.id });
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
    focusedAgentId,
    agents,
    drafts,
    rooms,
    currentRoomId,
    roomCount,
    usersOpen,
    openSettings,
  ]);

  // Which page is showing, in the same precedence as the view switch below. A
  // chat is not a page: agent chats are not routes (ruling 3), so a chat and
  // the office share the path "/".
  const page: Page | null = usersOpen
    ? "settings"
    : tasksOpen
      ? "tasks"
      : cronjobsOpen
        ? "cronjobs"
        : appsOpen
          ? "apps"
          : null;
  const isDeep = page !== null || focusedAgentId !== null;
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
      if (tasksOverChat) {
        // Back from tasks-over-a-chat steps back to the chat, not the
        // office. We stay deep (focus is still set), so the sync effect
        // re-pushes the entry the Back just consumed; a second Back then
        // lands on the office as usual.
        setTasksOpen(false);
        return;
      }
      applyPage(null);
      dispatch({ type: "focus", agentId: null });
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyPage, dispatch, tasksOverChat]);

  return (
    <>
      <style>{CSS}</style>
      <ConnectionBanner />
      {usersOpen ? (
        <UserSettingsView
          initialUserId={editingUserId}
          initialTarget={settingsTarget}
          onSwitchUser={(name) => setUsername(name)}
          onClose={goHome}
        />
      ) : tasksOpen ? (
        <TaskView
          onClose={closeTasks}
          onFocusAgent={(agentId) => {
            setTasksOpen(false);
            dispatch({ type: "focus", agentId });
          }}
        />
      ) : cronjobsOpen ? (
        <CronjobsView onClose={goHome} />
      ) : appsOpen ? (
        <AppsView
          onClose={goHome}
          onFocusAgent={(agentId) => {
            setAppsOpen(false);
            dispatch({ type: "focus", agentId });
          }}
        />
      ) : focusedAgent ? (
        <LogView
          key={focusedAgent.id}
          agent={focusedAgent}
          logs={logs.get(focusedAgent.id) ?? []}
          onBack={goHome}
          onEditAgent={() => setEditAgent(focusedAgent)}
          onOpenTasks={() => setTasksOpen(true)}
          onSwipeLeft={swipeAgentNext}
          onSwipeRight={swipeAgentPrev}
        />
      ) : isMobile && mobileViewMode === "list" ? (
        <AgentListView
          onFocus={(agentId) => dispatch({ type: "focus", agentId })}
          onSpawn={() => setSpawnPickerDesk(0)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          onOpenSettings={() => openSettings(null)}
          onEditRoomSettings={(roomId) =>
            openSettings({ kind: "room", roomId })
          }
          onOpenThemePicker={() =>
            openSettings({ kind: "section", section: "theme" })
          }
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenApps={() => setAppsOpen(true)}
          onOpenUpdate={() =>
            openSettings({ kind: "section", section: "updates" })
          }
          onToggleView={() => dispatch({ type: "toggle_mobile_view" })}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnPickerDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
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
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenApps={() => setAppsOpen(true)}
          onOpenUpdate={() =>
            openSettings({ kind: "section", section: "updates" })
          }
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
          viewportControlsRef={viewportControlsRef}
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
        <EditAgentDialog agent={editAgent} onClose={() => setEditAgent(null)} />
      )}
    </>
  );
}
