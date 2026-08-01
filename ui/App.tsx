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
import { OfficePromptModal } from "./components/OfficePromptModal.tsx";
import { RoomSettingsModal } from "./components/RoomSettingsModal.tsx";
import { DeviceSettingsModal } from "./components/DeviceSettingsModal.tsx";
import { UserSettingsView } from "./components/UserSettingsView.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { CronjobsView } from "./components/CronjobsView.tsx";
import { UpdateModal } from "./components/UpdateModal.tsx";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { CSS } from "./styles.ts";
import {
  getUsername,
  getDevice,
  readLegacySlideMode,
  clearLegacySlideMode,
} from "./device-settings.ts";
import { languageSeed } from "./preference-form.ts";
import { useSelfUser } from "./hooks/useSelfUser.ts";
import { apiFetch } from "./api.ts";
import type { PreferencesReq } from "../shared/contract-shapes.ts";
import { agentTabLabel } from "./agent-face.ts";
import type { AgentBackendType, AgentInfo } from "../shared/types.ts";
import { isValidDesk } from "../shared/desks.ts";
import { EngineChooserDialog } from "./components/EngineChooserDialog.tsx";

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

export function App() {
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
  // Spawn flow: clicking an empty slot opens the engine chooser. Picking an
  // engine in the chooser sets spawnReady, which opens EditAgentDialog with
  // agentType locked. Cancelling either step clears state.
  const [spawnPickerDesk, setSpawnPickerDesk] = useState<number | null>(null);
  const [spawnReady, setSpawnReady] = useState<{
    desk: number;
    agentType: AgentBackendType;
  } | null>(null);
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
  const [editingDeviceSettings, setEditingDeviceSettings] = useState(false);
  // Full-page User Settings (like tasks/cronjobs): part of the main view
  // switch, closed via goHome/popstate.
  const [usersOpen, setUsersOpen] = useState(false);
  // Live-avatars: when a ghost is clicked, the user-settings page opens
  // preopened to that user. Null = generic open (no preselection),
  // string = open with that user selected. Reset to null on close so a
  // subsequent generic open (UserIcon button) lands on the current user
  // the usual way.
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingOfficePrompt, setEditingOfficePrompt] = useState(false);
  const [editingRoomSettings, setEditingRoomSettings] = useState<string | null>(
    null,
  );
  const [tasksOpen, setTasksOpen] = useState(false);
  const [cronjobsOpen, setCronjobsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);

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
    if (saved.panel === "tasks") setTasksOpen(true);
    else if (saved.panel === "cronjobs") setCronjobsOpen(true);
    else if (saved.panel === "users") setUsersOpen(true);
  }, [
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
        ? "users"
        : tasksOpen
          ? "tasks"
          : cronjobsOpen
            ? "cronjobs"
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

  // One-shot Slide Mode migration (task 49d4e2f6): the gate used to be a
  // per-device localStorage flag and is now a per-user preference. A device
  // that had the experiment ON hands that ON to the user record once, so
  // nobody who enabled it loses it; a device where it was OFF only clears its
  // stale key, because turning the preference off for the whole account on
  // behalf of a browser the user may barely use would be the wrong guess.
  // Runs once the self record is known (we need to compare against the stored
  // preference). A FAILED write keeps the key and re-arms, so a flaky network
  // costs a retry rather than the setting; every other path clears it and the
  // migration never runs again on this device.
  const selfUser = useSelfUser();
  const slideMigratedRef = useRef(false);
  useEffect(() => {
    if (slideMigratedRef.current || !selfUser) return;
    const legacy = readLegacySlideMode();
    if (legacy === null) {
      slideMigratedRef.current = true;
      return;
    }
    slideMigratedRef.current = true;
    if (legacy && !selfUser.slideMode) {
      const body: PreferencesReq = { slideMode: true };
      apiFetch<void>("PATCH", "/api/me/preferences", body)
        .then(() => clearLegacySlideMode())
        .catch(() => {
          // Leave the key in place so the next load retries: dropping it after
          // a failed write would silently lose the setting.
          slideMigratedRef.current = false;
        });
    } else {
      clearLegacySlideMode();
    }
  }, [selfUser]);

  // One-shot language seed (Nil, 2026-08-01): the browser's language takes
  // effect without a first Save. A record that never chose a language gets the
  // detected browser language committed once (English is never seeded - a null
  // record already behaves as English). A failed write re-arms and retries on
  // the next record update, like the slide migration above.
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
  const anyModalOpen =
    editingDeviceSettings ||
    editingOfficePrompt ||
    editingRoomSettings !== null ||
    updateOpen;
  const viewMode: "office" | "log" | "away" =
    tasksOpen || cronjobsOpen || usersOpen || anyModalOpen
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
  // popstate handler re-pushes the entry), then to the office. All "return
  // to office" paths go through goHome(), which calls history.back() so the
  // popstate handler does the actual cleanup.
  const deepRef = useRef(false);

  const goHome = useCallback(() => {
    if (deepRef.current) {
      window.history.back(); // popstate handler will reset state
    } else {
      // Safety fallback - shouldn't happen, but don't break if it does
      setTasksOpen(false);
      setCronjobsOpen(false);
      setUsersOpen(false);
      setEditingUserId(null);
      dispatch({ type: "focus", agentId: null });
    }
  }, [dispatch]);

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
        setSpawnReady(null);
        setCtxMenu(null);
        setEditAgent(null);
      }
      // "t": toggle the task board from anywhere (office view or while viewing an
      // agent), as long as you're not typing into a field. Disabled while the
      // User Settings page is open - jumping away from it would bypass its
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
  ]);

  // Sync history stack with view state
  const isDeep =
    tasksOpen || cronjobsOpen || usersOpen || focusedAgentId !== null;
  useEffect(() => {
    if (isDeep && !deepRef.current) {
      window.history.pushState({ isomux: true }, "");
      deepRef.current = true;
    } else if (isDeep && deepRef.current) {
      // Deep → deep transition (e.g. tasks→log, agent cycling): keep one entry
      window.history.replaceState({ isomux: true }, "");
    } else if (!isDeep && deepRef.current) {
      // Returned to office - entry was consumed by history.back()
      deepRef.current = false;
    }
  }, [isDeep, focusedAgentId, tasksOpen, cronjobsOpen, usersOpen]);

  useEffect(() => {
    function handlePopState() {
      deepRef.current = false;
      if (tasksOverChat) {
        // Back from tasks-over-a-chat steps back to the chat, not the
        // office. We stay deep (focus is still set), so the sync effect
        // re-pushes the entry the Back just consumed; a second Back then
        // lands on the office as usual.
        setTasksOpen(false);
        return;
      }
      setTasksOpen(false);
      setCronjobsOpen(false);
      setUsersOpen(false);
      setEditingUserId(null);
      dispatch({ type: "focus", agentId: null });
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [dispatch, tasksOverChat]);

  return (
    <>
      <style>{CSS}</style>
      <ConnectionBanner />
      {editingDeviceSettings && (
        <DeviceSettingsModal onClose={() => setEditingDeviceSettings(false)} />
      )}
      {usersOpen ? (
        <UserSettingsView
          initialUserId={editingUserId}
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
          onOpenUserSettings={() => setUsersOpen(true)}
          onOpenDeviceSettings={() => setEditingDeviceSettings(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onEditRoomSettings={() => {
            const rid = currentRoomId;
            if (rid) setEditingRoomSettings(rid);
          }}
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenUpdate={() => setUpdateOpen(true)}
          onToggleView={() => dispatch({ type: "toggle_mobile_view" })}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
        />
      ) : (
        <OfficeView
          onSpawn={(desk) => setSpawnPickerDesk(desk)}
          onContextMenu={(x, y, agent) => setCtxMenu({ x, y, agent })}
          onOpenUserSettings={() => setUsersOpen(true)}
          onOpenUserSettingsForUser={(userId) => {
            setEditingUserId(userId);
            setUsersOpen(true);
          }}
          onOpenDeviceSettings={() => setEditingDeviceSettings(true)}
          onEditOfficePrompt={() => setEditingOfficePrompt(true)}
          onEditRoomSettings={() => {
            const rid = currentRoomId;
            if (rid) setEditingRoomSettings(rid);
          }}
          onOpenTasks={() => setTasksOpen(true)}
          onOpenCronjobs={() => setCronjobsOpen(true)}
          onOpenUpdate={() => setUpdateOpen(true)}
          onSwipeLeft={swipeRoomNext}
          onSwipeRight={swipeRoomPrev}
          viewportControlsRef={viewportControlsRef}
        />
      )}
      {spawnPickerDesk !== null && currentRoomId && (
        <EngineChooserDialog
          deskIndex={spawnPickerDesk}
          roomId={currentRoomId}
          onCancel={() => setSpawnPickerDesk(null)}
          onPick={(agentType) => {
            const desk = spawnPickerDesk;
            setSpawnPickerDesk(null);
            if (desk !== null) setSpawnReady({ desk, agentType });
          }}
        />
      )}
      {spawnReady !== null && currentRoomId && (
        <EditAgentDialog
          deskIndex={spawnReady.desk}
          defaultCwd="~"
          spawnAgentType={spawnReady.agentType}
          onClose={() => setSpawnReady(null)}
          roomId={currentRoomId}
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
      {editingOfficePrompt && (
        <OfficePromptModal onClose={() => setEditingOfficePrompt(false)} />
      )}
      {editingRoomSettings && (
        <RoomSettingsModal
          roomId={editingRoomSettings}
          onClose={() => setEditingRoomSettings(null)}
        />
      )}
      {updateOpen && <UpdateModal onClose={() => setUpdateOpen(false)} />}
    </>
  );
}
