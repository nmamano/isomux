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
import { UserManagementModal } from "./components/UserManagementModal.tsx";
import { TaskView } from "./components/TaskView.tsx";
import { CronjobsView } from "./components/CronjobsView.tsx";
import { UpdateModal } from "./components/UpdateModal.tsx";
import { ConnectionBanner } from "./components/ConnectionBanner.tsx";
import { CSS } from "./styles.ts";
import { getUsername, getDevice } from "./device-settings.ts";
import type { AgentBackendType, AgentInfo } from "../shared/types.ts";
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
  // Keep the tab title in sync with the office name. Server renders the
  // correct title into index.html for cold loads; this effect only takes over
  // once full_state has landed (connected=true) so we don't briefly overwrite
  // the server-rendered title with "Isomux" while office.name is still null
  // from the initial empty store.
  useEffect(() => {
    if (!connected) return;
    document.title = office.name ? `${office.name} | Isomux` : "Isomux";
  }, [office.name, connected]);
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
  const [editingUserSettings, setEditingUserSettings] = useState(false);
  // Live-avatars: when a ghost is clicked, the user-settings modal opens
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
  // validated against what actually still exists — a killed agent, a closed
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
    // One-shot hydration from an external system (localStorage) — the flag
    // flip must be state (see above) and can only happen here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRestored(true);
    // Drafts: only re-dispatch for agents that still exist, and prune this
    // user's saved keys for agents that don't (killed, or no longer
    // visible). Only our own namespace is pruned — another user's agents
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
      panel: tasksOpen ? "tasks" : cronjobsOpen ? "cronjobs" : null,
    });
  }, [
    persistEnabled,
    restored,
    persistUser,
    currentRoomId,
    focusedAgentId,
    tasksOpen,
    cronjobsOpen,
  ]);

  // Write drafts through to their per-composer keys (post-restore only) by
  // diffing against the previous Map: only the changed composer's key is
  // written, and a cleared/sent draft (entry deleted by set_draft "") removes
  // its key. Per-composer keys — not a whole-map mirror — is what keeps
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

  const viewportControlsRef = useRef<ViewportControls | null>(null);
  const focusedAgent = focusedAgentId
    ? agents.find((a) => a.id === focusedAgentId)
    : null;

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
    editingUserSettings ||
    editingDeviceSettings ||
    editingOfficePrompt ||
    editingRoomSettings !== null ||
    updateOpen;
  const viewMode: "office" | "log" | "away" =
    tasksOpen || cronjobsOpen || anyModalOpen
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

  // Browser back button: navigate to office view instead of leaving the page.
  // Model: office = home, any other view = one level deep. Only one history
  // entry is ever pushed. All "return to office" paths go through goHome(),
  // which calls history.back() so the popstate handler does the actual cleanup.
  const deepRef = useRef(false);

  const goHome = useCallback(() => {
    if (deepRef.current) {
      window.history.back(); // popstate handler will reset state
    } else {
      // Safety fallback — shouldn't happen, but don't break if it does
      setTasksOpen(false);
      setCronjobsOpen(false);
      dispatch({ type: "focus", agentId: null });
    }
  }, [dispatch]);

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
      // agent), as long as you're not typing into a field.
      if (!isInput && e.key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setTasksOpen((v) => !v);
      }
      // Viewport zoom/pan shortcuts (only from office view): 0 → reset, +/= → zoom in, - → zoom out.
      // "=" accepted as an alias for "+" so users don't need Shift on US layouts.
      // Ref is null when OfficeView isn't mounted (mobile list, log view, etc.) — don't swallow the key in those cases.
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
      // Number keys 1-8: focus agent at that desk in current room (only from office view)
      if (
        !isInput &&
        !focusedAgentId &&
        e.key >= "1" &&
        e.key <= "8" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const deskIndex = parseInt(e.key) - 1;
        const agent = agents.find(
          (a) => a.desk === deskIndex && a.roomId === currentRoomId,
        );
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
  ]);

  // Sync history stack with view state
  const isDeep = tasksOpen || cronjobsOpen || focusedAgentId !== null;
  useEffect(() => {
    if (isDeep && !deepRef.current) {
      window.history.pushState({ isomux: true }, "");
      deepRef.current = true;
    } else if (isDeep && deepRef.current) {
      // Deep → deep transition (e.g. tasks→log, agent cycling): keep one entry
      window.history.replaceState({ isomux: true }, "");
    } else if (!isDeep && deepRef.current) {
      // Returned to office — entry was consumed by history.back()
      deepRef.current = false;
    }
  }, [isDeep, focusedAgentId, tasksOpen, cronjobsOpen]);

  useEffect(() => {
    function handlePopState() {
      deepRef.current = false;
      setTasksOpen(false);
      setCronjobsOpen(false);
      dispatch({ type: "focus", agentId: null });
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [dispatch]);

  return (
    <>
      <style>{CSS}</style>
      <ConnectionBanner />
      {editingUserSettings && (
        <UserManagementModal
          initialUserId={editingUserId}
          onSwitchUser={(name) => setUsername(name)}
          onClose={() => {
            setEditingUserSettings(false);
            setEditingUserId(null);
          }}
        />
      )}
      {editingDeviceSettings && (
        <DeviceSettingsModal onClose={() => setEditingDeviceSettings(false)} />
      )}
      {tasksOpen ? (
        <TaskView
          onClose={goHome}
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
          onOpenUserSettings={() => setEditingUserSettings(true)}
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
          onOpenUserSettings={() => setEditingUserSettings(true)}
          onOpenUserSettingsForUser={(userId) => {
            setEditingUserId(userId);
            setEditingUserSettings(true);
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
