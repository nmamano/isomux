import { useState, useRef, useEffect, useMemo } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch } from "../api.ts";
import type {
  TaskItem,
  TaskStatus,
  TaskPriority,
  RoomWire,
} from "../../shared/types.ts";
import type {
  TaskCreateReq,
  TaskUpdateReq,
} from "../../shared/contract-shapes.ts";
import { dialogLabel, dialogInput } from "./dialog-styles.ts";

type SortField =
  | "status"
  | "priority"
  | "title"
  | "assignee"
  | "createdBy"
  | "createdAt";
type SortDir = "asc" | "desc";

// A deferred action to run once the currently-open panel finishes closing
// through its dirty/discard flow: select a row, or open the create panel with a
// seeded title. Exactly one is ever pending (see pendingNavRef).
type PendingNav =
  | { kind: "select"; id: string }
  | { kind: "create"; title: string };

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  open: 1,
  backlog: 2,
  done: 3,
};
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

// Cap the assignee suggestion chips. The office can hold many agents, and the
// `agents` array arrives in Map insertion order (oldest-first, and unreliable
// across server restarts), so we sort by spawn time before trimming.
const MAX_ASSIGNEE_SUGGESTIONS = 10;

// Spawn time, parsed from the agent id (`agent-<ms>-<rand>`, minted in
// office-state.ts). Used only to rank assignee chips by recency; falls back to 0
// (sorts last) if the id ever stops carrying a millisecond segment.
function agentSpawnMs(id: string): number {
  const ms = Number(id.split("-")[1]);
  return Number.isFinite(ms) ? ms : 0;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  open: "var(--blue, #58a6ff)",
  in_progress: "var(--green)",
  backlog: "var(--purple)",
  done: "var(--text-muted)",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  backlog: "Backlog",
  done: "Done",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  P0: "var(--red)",
  P1: "var(--orange, #d29922)",
  P2: "var(--blue, #58a6ff)",
  P3: "var(--text-muted)",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function TaskDetailPanel({
  task,
  onClose,
  mode = "edit",
  agents = [],
  closeRef,
  fullScreen = false,
  rooms = [],
  createRoomId = "",
  onCreateRoomChange,
  initialTitle = "",
  onCancelClose,
}: {
  task?: TaskItem;
  onClose: () => void;
  mode?: "edit" | "create";
  agents?: { name: string; id: string }[];
  closeRef?: React.MutableRefObject<(() => void) | null>;
  fullScreen?: boolean;
  // Called when the user cancels the discard prompt, i.e. abandons a close that
  // some parent action requested. Lets the parent drop any queued
  // navigation/create intent so a later close doesn't act on it stale.
  onCancelClose?: () => void;
  // Create-mode title seeded from the quick-add input, so pressing Enter there
  // opens this panel with the typed title already filled in. Ignored in edit
  // mode (the title comes from the task).
  initialTitle?: string;
  // Rooms the caller can see, for the create-mode "Create in" selector and for
  // labelling an existing task's room. Empty when no rooms are visible.
  rooms?: RoomWire[];
  // Create-mode target room ("" === office-global), lifted to TaskView so the
  // quick-add row and this panel share ONE create target. Ignored in edit mode
  // (moving a task between rooms is out of scope).
  createRoomId?: string;
  onCreateRoomChange?: (roomId: string) => void;
}) {
  const roomLabel = (roomId: string | undefined) =>
    roomId ? (rooms.find((r) => r.id === roomId)?.name ?? "Unknown room") : "";
  // Most-recent agents first — the raw list is oldest-first and can be long.
  // Capped to MAX_ASSIGNEE_SUGGESTIONS by default; a "+N more" chip expands to
  // the full list (same recency order, so the visible chips don't reshuffle).
  // Memoized so the chips don't re-sort on every keystroke in the form.
  const [showAllAgents, setShowAllAgents] = useState(false);
  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => agentSpawnMs(b.id) - agentSpawnMs(a.id)),
    [agents],
  );
  const hiddenAgentCount = Math.max(
    0,
    sortedAgents.length - MAX_ASSIGNEE_SUGGESTIONS,
  );
  const visibleAgents = showAllAgents
    ? sortedAgents
    : sortedAgents.slice(0, MAX_ASSIGNEE_SUGGESTIONS);
  const [title, setTitle] = useState(task?.title || initialTitle || "");
  const [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState<TaskPriority | "">(
    task?.priority || "",
  );
  const [status, setStatus] = useState<TaskStatus>(task?.status || "open");
  const [assignee, setAssignee] = useState(task?.assignee || "");

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Sync form fields from the selected task prop. setState-in-effect is the
  // canonical pattern for prop→state sync.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || "");
      setPriority(task.priority || "");
      setStatus(task.status);
      setAssignee(task.assignee || "");
    } else {
      setTitle(initialTitle || "");
      setDescription("");
      setPriority("");
      setStatus("open");
      setAssignee("");
    }
    setConfirmDelete(false);
    setConfirmDiscard(false);
    setShowAllAgents(false);
  }, [task, initialTitle]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function isDirty(): boolean {
    if (mode === "create") {
      return !!(
        title.trim() ||
        description.trim() ||
        priority ||
        assignee.trim()
      );
    }
    if (!task) return false;
    return (
      title !== task.title ||
      description !== (task.description || "") ||
      priority !== (task.priority || "") ||
      status !== task.status ||
      assignee !== (task.assignee || "")
    );
  }

  function requestClose() {
    if (isDirty()) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  // No deps — must run every render so the ref always has a fresh closure
  // that captures the current form state for the dirty check.
  useEffect(() => {
    if (closeRef) closeRef.current = requestClose;
    return () => {
      if (closeRef) closeRef.current = null;
    };
  });

  function handleSave() {
    if (!title.trim()) return;
    if (mode === "create") {
      // Fire-and-forget (parity with the old WS arm): the `tasks` broadcast
      // applies the change echo-first, so the optimistic onClose() below stays.
      // `username` is dropped — the server derives createdBy + username from the
      // caller's token identity (attributionFor), never the request body.
      const body: TaskCreateReq = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority || undefined,
        assignee: assignee.trim() || undefined,
        // "" is an EXPLICIT office-global create (distinct from omitting the
        // field, which a user caller also treats as global — same result here).
        roomId: createRoomId,
      };
      apiFetch<TaskItem>("POST", "/api/tasks", body).catch(() => {});
    } else if (task) {
      // FLAT body (TaskUpdateReq), NOT { changes }. Blank fields are sent as
      // explicit `undefined` properties exactly as the WS arm did; JSON.stringify
      // drops them, so the server leaves those fields untouched (unchanged
      // semantics — a blank does not clear an existing value).
      const body: TaskUpdateReq = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority || undefined,
        status,
        assignee: assignee.trim() || undefined,
      };
      apiFetch<TaskItem>("PATCH", `/api/tasks/${task.id}`, body).catch(
        () => {},
      );
    }
    onClose();
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // Fire-and-forget: the `tasks` broadcast removes the row; optimistic close.
    if (task) apiFetch<void>("DELETE", `/api/tasks/${task.id}`).catch(() => {});
    onClose();
  }

  const inputStyle: React.CSSProperties = {
    ...dialogInput,
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 13,
  };

  const labelStyle: React.CSSProperties = dialogLabel;

  const outerStyle: React.CSSProperties = fullScreen
    ? {
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
        animation: "hudIn 0.15s ease-out",
      }
    : {
        width: 340,
        maxWidth: "100%",
        borderLeft: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        animation: "hudIn 0.15s ease-out",
        flexShrink: 0,
      };

  return (
    <div
      style={outerStyle}
      onKeyDownCapture={(e) => {
        // Ctrl/Cmd+Enter submits from any field in the panel (the description
        // is focused on open, where plain Enter must stay a newline). Capture
        // phase so it fires before the field's own key handler.
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.repeat) {
          e.preventDefault();
          handleSave();
        }
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: fullScreen
            ? "max(14px, env(safe-area-inset-top, 0px)) 20px 12px"
            : "20px 24px 12px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {mode === "create" ? "New Task" : `#${task!.id}`}
        </span>
        <button
          onClick={requestClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 22,
            lineHeight: 1,
            cursor: "pointer",
            padding: "4px 10px",
          }}
        >
          &times;
        </button>
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          padding: fullScreen ? "14px 20px" : "14px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <label style={labelStyle}>Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={inputStyle}
            onKeyDown={(e) => {
              // Plain Enter saves; Ctrl/Cmd+Enter is handled by the panel's
              // capture handler (avoid double-submitting here).
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) handleSave();
              e.stopPropagation();
            }}
          />
        </div>

        {mode === "create" ? (
          <div>
            <label style={labelStyle}>Create in</label>
            <select
              value={createRoomId}
              onChange={(e) => onCreateRoomChange?.(e.target.value)}
              style={inputStyle}
            >
              <option value="">Global (office-wide)</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          task && (
            <div>
              <label style={labelStyle}>Room</label>
              <div
                style={{
                  ...inputStyle,
                  color: "var(--text-dim)",
                  cursor: "default",
                }}
              >
                {task.roomId ? roomLabel(task.roomId) : "Global (office-wide)"}
              </div>
            </div>
          )
        )}

        <div>
          <label style={labelStyle}>Description</label>
          <textarea
            autoFocus={mode === "create"}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority | "")}
              style={inputStyle}
            >
              <option value="">None</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              style={inputStyle}
            >
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="backlog">Backlog</option>
              <option value="done">Done</option>
            </select>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Assignee</label>
          <input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            style={inputStyle}
            placeholder="Unassigned"
            onKeyDown={(e) => e.stopPropagation()}
          />
          {visibleAgents.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {visibleAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setAssignee(a.name)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 6,
                    border: `1px solid ${assignee === a.name ? "var(--accent)" : "var(--border)"}`,
                    background:
                      assignee === a.name
                        ? "var(--accent-muted, rgba(88,166,255,0.15))"
                        : "var(--btn-surface)",
                    color:
                      assignee === a.name
                        ? "var(--accent)"
                        : "var(--text-muted)",
                    fontSize: 10,
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono',monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  {a.name}
                </button>
              ))}
              {hiddenAgentCount > 0 && (
                <button
                  onClick={() => setShowAllAgents(!showAllAgents)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 6,
                    border: "1px dashed var(--border)",
                    background: "transparent",
                    color: "var(--text-hint)",
                    fontSize: 10,
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono',monospace",
                    whiteSpace: "nowrap",
                  }}
                  title={
                    showAllAgents
                      ? "Show only recent agents"
                      : "Show all agents"
                  }
                >
                  {showAllAgents ? "show less" : `+${hiddenAgentCount} more`}
                </button>
              )}
            </div>
          )}
        </div>

        {mode === "edit" && task && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-hint)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {task.username && task.username !== task.createdBy
              ? `${task.createdBy} · for ${task.username}`
              : task.createdBy}
            {" · "}
            {timeAgo(task.createdAt)}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: fullScreen
            ? "12px 20px max(12px, env(safe-area-inset-bottom, 0px))"
            : "12px 24px 20px",
          borderTop: "1px solid var(--border-subtle)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {confirmDiscard && (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
              Discard unsaved changes?
            </span>
            <button
              onClick={onClose}
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
              onClick={() => {
                setConfirmDiscard(false);
                onCancelClose?.();
              }}
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

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={!title.trim()}
            style={{
              flex: 1,
              padding: "9px 0",
              borderRadius: 8,
              border: "none",
              background: title.trim() ? "var(--accent)" : "var(--bg-subtle)",
              color: title.trim() ? "var(--bg-base)" : "var(--text-muted)",
              fontSize: 12,
              fontWeight: 600,
              cursor: title.trim() ? "pointer" : "default",
            }}
          >
            {mode === "create" ? "Create" : "Save"}
            <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 400 }}>
              {(navigator.platform || "").includes("Mac")
                ? "⌘+Enter"
                : "Ctrl+Enter"}
            </span>
          </button>
          {mode === "edit" && (
            <button
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              style={{
                padding: "9px 14px",
                borderRadius: 8,
                border: `1px solid ${confirmDelete ? "var(--red)" : "var(--border)"}`,
                background: confirmDelete ? "var(--red)" : "transparent",
                color: confirmDelete ? "var(--bg-base)" : "var(--red)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {confirmDelete ? "Confirm?" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskView({
  onClose,
  onFocusAgent,
}: {
  onClose: () => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const { tasks, tasksLoaded, agents, isMobile, rooms, currentRoomId } =
    useAppState();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<
    TaskStatus | "all" | "active"
  >("active");
  // Room controls captured ONCE from the office's current room and held stable
  // while the Tasks view is open — they do NOT silently follow the office room
  // tab. viewRoom filters the (already server-scoped) list; createRoomId is the
  // shared create target for the quick-add row and the create panel.
  //   viewRoom:     "all" | "global" | <roomId>
  //   createRoomId: "" (office-global) | <roomId>
  const [viewRoom, setViewRoom] = useState<string>(() =>
    currentRoomId && rooms.some((r) => r.id === currentRoomId)
      ? currentRoomId
      : "all",
  );
  const [createRoomId, setCreateRoomId] = useState<string>(() =>
    currentRoomId && rooms.some((r) => r.id === currentRoomId)
      ? currentRoomId
      : "",
  );
  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) m.set(r.id, r.name);
    return m;
  }, [rooms]);
  const roomLabel = (roomId: string | undefined) =>
    roomId ? (roomNameById.get(roomId) ?? "Unknown room") : "Global";
  const [creating, setCreating] = useState(false);
  const [filterAssignee, setFilterAssignee] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickTitle, setQuickTitle] = useState("");
  // Title seeded into the create panel when the quick-add row opens it (Enter).
  const [createInitialTitle, setCreateInitialTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // ONE pending post-close intent, not two: the discard prompt is inline (not
  // modal), so a row click and a quick-add Enter could otherwise both queue and
  // one would leak. Setting either overwrites the other, so the latest
  // requested transition wins and exactly one ever drains.
  const pendingNavRef = useRef<PendingNav | null>(null);

  const selectedTask = selectedId
    ? tasks.find((t) => t.id === selectedId)
    : null;
  const panelOpen = !!(selectedTask || creating);

  function tryClosePanel() {
    if (closeRef.current) {
      closeRef.current();
    }
  }

  // The user backed out of a discard prompt, so the close that some action
  // (row click / quick-add Enter) requested is no longer happening. Drop the
  // queued intents so a later, unrelated close doesn't act on them.
  function cancelPendingNav() {
    pendingNavRef.current = null;
  }

  // After a panel closes, apply any pending intent from the action that
  // triggered the close: a row click selects that task; a quick-add Enter opens
  // the create panel. Deferring lets the close run through the panel's
  // dirty/discard flow first, instead of silently dropping unsaved edits.
  useEffect(() => {
    if (panelOpen) return;
    const pending = pendingNavRef.current;
    if (!pending) return;
    pendingNavRef.current = null;
    if (pending.kind === "select") {
      setSelectedId(pending.id);
    } else {
      setCreateInitialTitle(pending.title);
      setCreating(true);
    }
  }, [panelOpen]);

  // Focus the quick-add input on open so a title can be typed immediately —
  // creating a task is the most common reason to open the board.
  useEffect(() => {
    quickAddRef.current?.focus();
  }, []);

  // Enter in the quick-add row does NOT create the task; it opens the full
  // create panel seeded with the typed title and focused on the description,
  // where Ctrl/Cmd+Enter actually creates. This keeps a title-only mistake from
  // committing a bare task and nudges toward adding detail.
  function openCreatePanel() {
    // Create panel already open — don't reseed the title and clobber edits.
    if (creating) return;
    const title = quickTitle.trim();
    setQuickTitle("");
    if (panelOpen) {
      // An edit panel is open (dirty edits possible). Route the switch through
      // its close/dirty flow — which may prompt to discard — and defer opening
      // create until it has actually closed, mirroring the row-click path.
      pendingNavRef.current = { kind: "create", title };
      tryClosePanel();
      return;
    }
    setCreateInitialTitle(title);
    setSelectedId(null);
    setCreating(true);
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (panelOpen) {
          tryClosePanel();
        } else {
          onClose();
        }
        return;
      }
      // "n" jumps focus to the quick-add input — but only when the user isn't
      // already typing in a field and no detail panel is open (the panel has its
      // own inputs). Capture phase, so it fires before the focused element.
      if (
        (e.key === "n" || e.key === "N") &&
        !panelOpen &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const t = e.target as HTMLElement | null;
        const typing =
          t?.tagName === "INPUT" ||
          t?.tagName === "TEXTAREA" ||
          t?.tagName === "SELECT" ||
          !!t?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          e.stopPropagation();
          quickAddRef.current?.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, panelOpen]);

  const agentsByName = useMemo(() => {
    const map = new Map<string, string>(); // lowercase name → agentId
    for (const a of agents) map.set(a.name.toLowerCase(), a.id);
    return map;
  }, [agents]);

  const filtered = useMemo(() => {
    let list = tasks;
    // Room view filter (client-side, on top of the server's access scoping):
    // "all" shows everything visible, "global" only office-global tasks, a room
    // id only that room's tasks.
    if (viewRoom === "global") {
      list = list.filter((t) => !t.roomId);
    } else if (viewRoom !== "all") {
      list = list.filter((t) => t.roomId === viewRoom);
    }
    if (filterStatus === "active") {
      list = list.filter((t) => t.status !== "done" && t.status !== "backlog");
    } else if (filterStatus !== "all") {
      list = list.filter((t) => t.status === filterStatus);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          (t.description && t.description.toLowerCase().includes(q)),
      );
    }
    if (filterAssignee) {
      const q = filterAssignee.toLowerCase();
      list = list.filter((t) => t.assignee?.toLowerCase().includes(q));
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "status":
          cmp = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
          break;
        case "priority": {
          const pa = a.priority ? PRIORITY_ORDER[a.priority] : 99;
          const pb = b.priority ? PRIORITY_ORDER[b.priority] : 99;
          cmp = pa - pb;
          break;
        }
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "assignee":
          cmp = (a.assignee || "").localeCompare(b.assignee || "");
          break;
        case "createdBy":
          cmp = a.createdBy.localeCompare(b.createdBy);
          break;
        case "createdAt":
          cmp = a.createdAt - b.createdAt;
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [
    tasks,
    viewRoom,
    filterStatus,
    search,
    filterAssignee,
    sortField,
    sortDir,
  ]);

  function renderName(name: string | undefined) {
    if (!name) return "";
    const agentId = agentsByName.get(name.toLowerCase());
    if (agentId && onFocusAgent) {
      return (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onFocusAgent(agentId);
          }}
          style={{
            cursor: "pointer",
            color: "var(--accent)",
            textDecoration: "none",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.textDecoration = "underline")
          }
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
        >
          {name}
        </span>
      );
    }
    return name;
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const cellPad = isMobile ? "6px 4px" : "8px 10px";

  const thStyle: React.CSSProperties = {
    padding: cellPad,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-muted)",
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.05em",
    textAlign: "left",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border-subtle)",
  };

  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 12,
    outline: "none",
  };

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
      {/* Header */}
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          justifyContent: "space-between",
          padding: isMobile ? "4px 12px 6px" : "0 20px",
          paddingTop: isMobile
            ? "max(4px, env(safe-area-inset-top, 0px))"
            : undefined,
          gap: isMobile ? 6 : 0,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            justifyContent: isMobile ? "space-between" : undefined,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            <button
              onClick={onClose}
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
              style={{
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              Tasks
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              {filtered.length} shown
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Table area */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Quick add — type a title, press Enter (or "n" to focus). Enter
              opens the detail panel; it does not create immediately. Sits ABOVE
              the filter row: it is a create affordance, not a view control. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: isMobile ? "10px 12px 0" : "10px 20px 0",
            }}
          >
            <input
              ref={quickAddRef}
              type="text"
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Ignore auto-repeat (held Enter would re-open the panel) and
                // IME composition (Enter there confirms composed text, e.g.
                // CJK, not a submit).
                if (
                  e.key === "Enter" &&
                  !e.repeat &&
                  !e.nativeEvent.isComposing
                ) {
                  // Prevent the keystroke's default so it can't land as a
                  // newline in the description field we focus on open.
                  e.preventDefault();
                  openCreatePanel();
                }
              }}
              placeholder="Quick add a task…"
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <span
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                flexShrink: 0,
              }}
            >
              for
            </span>
            <select
              value={createRoomId}
              onChange={(e) => setCreateRoomId(e.target.value)}
              title="New tasks are filed in this room"
              style={{
                ...selectStyle,
                flexShrink: 0,
                maxWidth: isMobile ? 120 : 160,
              }}
            >
              <option value="">Global</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {/* Hint — Enter opens the detail panel (not an immediate create). */}
          <div
            style={{
              padding: isMobile ? "4px 12px 0" : "4px 20px 0",
              fontSize: 11,
              color: "var(--text-hint)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {isMobile
              ? "Enter to add details"
              : "Enter to add details · n to focus"}
          </div>

          {/* Filter row — view/status/assignee + search. These narrow the table
              below, so they sit UNDER the quick-add create affordance. */}
          <div
            style={{
              display: "flex",
              flexDirection: isMobile ? "column" : "row",
              gap: 8,
              padding: isMobile ? "8px 12px 10px" : "10px 20px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              <select
                value={viewRoom}
                onChange={(e) => setViewRoom(e.target.value)}
                title="Filter tasks by room"
                style={isMobile ? { ...selectStyle, flex: 1 } : selectStyle}
              >
                <option value="all">All rooms</option>
                <option value="global">Global</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <select
                value={filterStatus}
                onChange={(e) =>
                  setFilterStatus(
                    e.target.value as TaskStatus | "all" | "active",
                  )
                }
                style={isMobile ? { ...selectStyle, flex: 1 } : selectStyle}
              >
                <option value="active">Open + In Progress</option>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="backlog">Backlog</option>
                <option value="done">Done</option>
                <option value="all">All</option>
              </select>
              {!isMobile && (
                <input
                  value={filterAssignee}
                  onChange={(e) => setFilterAssignee(e.target.value)}
                  placeholder="Filter assignee..."
                  style={{ ...selectStyle, width: 130 }}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              )}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search tasks..."
              style={{
                flex: isMobile ? undefined : 1,
                padding: "9px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg-input)",
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
              }}
            />
          </div>

          {/* Table */}
          <div
            onClick={(e) => {
              // Click on empty table area (not on a row) dismisses the panel
              if (panelOpen && e.target === e.currentTarget) tryClosePanel();
            }}
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: isMobile ? "hidden" : "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                tableLayout: isMobile ? "fixed" : undefined,
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{ ...thStyle, width: isMobile ? 24 : 36 }}
                    onClick={() => handleSort("status")}
                  >
                    S
                    {sortField === "status"
                      ? sortDir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                  <th
                    style={{ ...thStyle, width: isMobile ? 24 : 36 }}
                    onClick={() => handleSort("priority")}
                  >
                    P
                    {sortField === "priority"
                      ? sortDir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                  <th style={thStyle} onClick={() => handleSort("title")}>
                    TITLE
                    {sortField === "title"
                      ? sortDir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                  <th
                    style={{ ...thStyle, width: isMobile ? 60 : 100 }}
                    onClick={() => handleSort("assignee")}
                  >
                    ASSIGNEE
                    {sortField === "assignee"
                      ? sortDir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                  {!isMobile && (
                    <th
                      style={{ ...thStyle, width: 140 }}
                      onClick={() => handleSort("createdBy")}
                    >
                      BY
                      {sortField === "createdBy"
                        ? sortDir === "asc"
                          ? " \u25B2"
                          : " \u25BC"
                        : ""}
                    </th>
                  )}
                  <th
                    style={{ ...thStyle, width: 70 }}
                    onClick={() => handleSort("createdAt")}
                  >
                    AGE
                    {sortField === "createdAt"
                      ? sortDir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={isMobile ? 5 : 6}
                      style={{
                        textAlign: "center",
                        padding: "24px 0",
                        color: "var(--text-muted)",
                        fontSize: 13,
                      }}
                    >
                      {tasksLoaded ? "No tasks" : "Loading..."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((task) => (
                    <tr
                      key={task.id}
                      onClick={() => {
                        if (task.id === selectedId) {
                          tryClosePanel();
                          return;
                        }
                        if (panelOpen) {
                          pendingNavRef.current = {
                            kind: "select",
                            id: task.id,
                          };
                          tryClosePanel();
                          return;
                        }
                        setSelectedId(task.id);
                        setCreating(false);
                      }}
                      style={{
                        cursor: "pointer",
                        background:
                          task.id === selectedId
                            ? "var(--bg-hover)"
                            : "transparent",
                        borderBottom: "1px solid var(--border-subtle)",
                        opacity: task.status === "done" ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (task.id !== selectedId)
                          e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (task.id !== selectedId)
                          e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <td style={{ padding: cellPad }}>
                        <span
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: STATUS_COLORS[task.status],
                            boxShadow:
                              task.status === "open" ||
                              task.status === "in_progress"
                                ? `0 0 6px ${STATUS_COLORS[task.status]}`
                                : "none",
                          }}
                          title={STATUS_LABELS[task.status]}
                        />
                      </td>
                      <td style={{ padding: cellPad }}>
                        {task.priority && (
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              fontFamily: "'JetBrains Mono',monospace",
                              color: PRIORITY_COLORS[task.priority],
                            }}
                          >
                            {task.priority}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: cellPad,
                          fontSize: 13,
                          textDecoration:
                            task.status === "done" ? "line-through" : "none",
                          maxWidth: isMobile ? 0 : 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {viewRoom === "all" && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              fontFamily: "'JetBrains Mono',monospace",
                              color: task.roomId
                                ? "var(--text-dim)"
                                : "var(--text-hint)",
                              border: "1px solid var(--border-subtle)",
                              borderRadius: 4,
                              padding: "1px 5px",
                              marginRight: 6,
                              whiteSpace: "nowrap",
                            }}
                            title={
                              task.roomId
                                ? `Room: ${roomLabel(task.roomId)}`
                                : "Office-global task"
                            }
                          >
                            {roomLabel(task.roomId)}
                          </span>
                        )}
                        {task.title}
                        {task.description && (
                          <span
                            style={{
                              color: "var(--text-hint)",
                              fontWeight: 400,
                            }}
                          >
                            {" "}
                            | {task.description}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: cellPad,
                          fontSize: 11,
                          color: "var(--text-dim)",
                          fontFamily: "'JetBrains Mono',monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {renderName(task.assignee)}
                      </td>
                      {!isMobile && (
                        <td
                          style={{
                            padding: cellPad,
                            fontSize: 11,
                            color: "var(--text-hint)",
                            fontFamily: "'JetBrains Mono',monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {task.username && task.username !== task.createdBy ? (
                            <>
                              {renderName(task.createdBy)} · for{" "}
                              {renderName(task.username)}
                            </>
                          ) : (
                            renderName(task.createdBy)
                          )}
                        </td>
                      )}
                      <td
                        style={{
                          padding: cellPad,
                          fontSize: 10,
                          color: "var(--text-hint)",
                          fontFamily: "'JetBrains Mono',monospace",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {timeAgo(task.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail panel */}
        {!isMobile &&
          (creating ? (
            <TaskDetailPanel
              key="create"
              closeRef={closeRef}
              mode="create"
              onClose={() => setCreating(false)}
              agents={agents}
              rooms={rooms}
              createRoomId={createRoomId}
              onCreateRoomChange={setCreateRoomId}
              initialTitle={createInitialTitle}
              onCancelClose={cancelPendingNav}
            />
          ) : selectedTask ? (
            <TaskDetailPanel
              closeRef={closeRef}
              task={selectedTask}
              onClose={() => setSelectedId(null)}
              agents={agents}
              rooms={rooms}
              onCancelClose={cancelPendingNav}
            />
          ) : null)}
      </div>

      {/* Mobile detail panel as full-page */}
      {isMobile &&
        (creating ? (
          <TaskDetailPanel
            key="create"
            closeRef={closeRef}
            mode="create"
            onClose={() => setCreating(false)}
            agents={agents}
            rooms={rooms}
            createRoomId={createRoomId}
            onCreateRoomChange={setCreateRoomId}
            initialTitle={createInitialTitle}
            onCancelClose={cancelPendingNav}
            fullScreen
          />
        ) : selectedTask ? (
          <TaskDetailPanel
            closeRef={closeRef}
            task={selectedTask}
            onClose={() => setSelectedId(null)}
            agents={agents}
            rooms={rooms}
            onCancelClose={cancelPendingNav}
            fullScreen
          />
        ) : null)}
    </div>
  );
}
