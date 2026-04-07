import { useState, useRef, useEffect, useMemo } from "react";
import { useAppState } from "../store.tsx";
import { send } from "../ws.ts";
import type { TaskItem, TaskStatus, TaskPriority } from "../../shared/types.ts";

type SortField = "status" | "priority" | "title" | "assignee" | "createdBy" | "createdAt";
type SortDir = "asc" | "desc";

const STATUS_ORDER: Record<TaskStatus, number> = { in_progress: 0, open: 1, done: 2 };
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const STATUS_COLORS: Record<TaskStatus, string> = {
  open: "var(--blue, #58a6ff)",
  in_progress: "var(--green)",
  done: "var(--text-muted)",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
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

function TaskDetailPanel({ task, onClose, username, mode = "edit", agents = [], closeRef }: { task?: TaskItem; onClose: () => void; username: string; mode?: "edit" | "create"; agents?: { name: string }[]; closeRef?: React.MutableRefObject<(() => void) | null> }) {
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [priority, setPriority] = useState<TaskPriority | "">(task?.priority || "");
  const [status, setStatus] = useState<TaskStatus>(task?.status || "open");
  const [assignee, setAssignee] = useState(task?.assignee || "");

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || "");
      setPriority(task.priority || "");
      setStatus(task.status);
      setAssignee(task.assignee || "");
    } else {
      setTitle("");
      setDescription("");
      setPriority("");
      setStatus("open");
      setAssignee("");
    }
    setConfirmDelete(false);
    setConfirmDiscard(false);
  }, [task]);

  function isDirty(): boolean {
    if (mode === "create") {
      return !!(title.trim() || description.trim() || priority || assignee.trim());
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
    return () => { if (closeRef) closeRef.current = null; };
  });

  function handleSave() {
    if (!title.trim()) return;
    if (mode === "create") {
      send({
        type: "add_task",
        title: title.trim(),
        description: description.trim() || undefined,
        priority: priority || undefined,
        assignee: assignee.trim() || undefined,
        username,
      });
    } else if (task) {
      send({
        type: "update_task",
        id: task.id,
        changes: {
          title: title.trim(),
          description: description.trim() || undefined,
          priority: priority || undefined,
          status,
          assignee: assignee.trim() || undefined,
        },
      });
    }
    onClose();
  }

  function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (task) send({ type: "delete_task", id: task.id });
    onClose();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    marginBottom: 4,
    display: "block",
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.03em",
  };

  return (
    <div
      style={{
        width: 340,
        maxWidth: "100%",
        borderLeft: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        overflowY: "auto",
        animation: "hudIn 0.15s ease-out",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
          {mode === "create" ? "New Task" : `#${task!.id}`}
        </span>
        <button onClick={requestClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", padding: "2px 6px" }}>&times;</button>
      </div>

      <div>
        <label style={labelStyle}>Title</label>
        <input autoFocus={mode === "create"} value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} onKeyDown={(e) => { if (e.key === "Enter") handleSave(); e.stopPropagation(); }} />
      </div>

      <div>
        <label style={labelStyle}>Description</label>
        <textarea
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
          <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority | "")} style={inputStyle}>
            <option value="">None</option>
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
            <option value="P3">P3</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)} style={inputStyle}>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </div>
      </div>

      <div>
        <label style={labelStyle}>Assignee</label>
        <input value={assignee} onChange={(e) => setAssignee(e.target.value)} style={inputStyle} placeholder="Unassigned" onKeyDown={(e) => e.stopPropagation()} />
        {agents.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {agents.map((a) => (
              <button
                key={a.name}
                onClick={() => setAssignee(a.name)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: `1px solid ${assignee === a.name ? "var(--accent)" : "var(--border)"}`,
                  background: assignee === a.name ? "var(--accent-muted, rgba(88,166,255,0.15))" : "var(--btn-surface)",
                  color: assignee === a.name ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 10,
                  cursor: "pointer",
                  fontFamily: "'JetBrains Mono',monospace",
                  whiteSpace: "nowrap",
                }}
              >
                {a.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "edit" && task && (
        <div style={{ fontSize: 11, color: "var(--text-hint)", fontFamily: "'JetBrains Mono',monospace" }}>
          Created by {task.createdBy} &middot; {timeAgo(task.createdAt)}
        </div>
      )}

      {confirmDiscard && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>Discard unsaved changes?</span>
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
            onClick={() => setConfirmDiscard(false)}
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

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
  );
}

export function TaskView({ username, onClose, onFocusAgent }: { username: string; onClose: () => void; onFocusAgent?: (agentId: string) => void }) {
  const { tasks, agents, isMobile } = useAppState();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<TaskStatus | "all" | "active">("active");
  const [creating, setCreating] = useState(false);
  const [filterAssignee, setFilterAssignee] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<(() => void) | null>(null);
  const pendingSelectRef = useRef<string | null>(null);

  const selectedTask = selectedId ? tasks.find((t) => t.id === selectedId) : null;
  const panelOpen = !!(selectedTask || creating);

  function tryClosePanel() {
    if (closeRef.current) {
      closeRef.current();
    }
  }

  // After a panel closes, apply any pending row selection from a click that triggered the close
  useEffect(() => {
    if (!panelOpen && pendingSelectRef.current) {
      const id = pendingSelectRef.current;
      pendingSelectRef.current = null;
      setSelectedId(id);
    }
  }, [panelOpen]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (panelOpen) { tryClosePanel(); } else { onClose(); }
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
    if (filterStatus === "active") {
      list = list.filter((t) => t.status !== "done");
    } else if (filterStatus !== "all") {
      list = list.filter((t) => t.status === filterStatus);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
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
  }, [tasks, filterStatus, search, filterAssignee, sortField, sortDir]);

  function renderName(name: string | undefined) {
    if (!name) return "";
    const agentId = agentsByName.get(name.toLowerCase());
    if (agentId && onFocusAgent) {
      return (
        <span
          onClick={(e) => { e.stopPropagation(); onFocusAgent(agentId); }}
          style={{ cursor: "pointer", color: "var(--accent)", textDecoration: "none" }}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
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
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          height: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Tasks</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono',monospace" }}>
            {filtered.length} shown
          </span>
          <button
            onClick={() => { setCreating(true); setSelectedId(null); }}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "none",
              background: "var(--accent)",
              color: "var(--bg-base)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TaskStatus | "all" | "active")} style={selectStyle}>
            <option value="active">Open + In Progress</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
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
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Table area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Search bar */}
          <div style={{ display: "flex", gap: 8, padding: isMobile ? "10px 12px" : "10px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search tasks..."
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
          </div>

          {/* Table */}
          <div
            onClick={(e) => {
              // Click on empty table area (not on a row) dismisses the panel
              if (panelOpen && e.target === e.currentTarget) tryClosePanel();
            }}
            style={{ flex: 1, overflowY: "auto", overflowX: isMobile ? "hidden" : "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: isMobile ? "fixed" : undefined }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, width: isMobile ? 24 : 36 }} onClick={() => handleSort("status")}>
                    S{sortField === "status" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </th>
                  <th style={{ ...thStyle, width: isMobile ? 24 : 36 }} onClick={() => handleSort("priority")}>
                    P{sortField === "priority" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </th>
                  <th style={thStyle} onClick={() => handleSort("title")}>
                    TITLE{sortField === "title" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </th>
                  <th style={{ ...thStyle, width: isMobile ? 60 : 100 }} onClick={() => handleSort("assignee")}>
                    ASSIGNEE{sortField === "assignee" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </th>
                  {!isMobile && (
                    <th style={{ ...thStyle, width: 90 }} onClick={() => handleSort("createdBy")}>
                      BY{sortField === "createdBy" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                    </th>
                  )}
                  <th style={{ ...thStyle, width: 70 }} onClick={() => handleSort("createdAt")}>
                    AGE{sortField === "createdAt" ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : ""}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isMobile ? 5 : 6} style={{ textAlign: "center", padding: "24px 0", color: "var(--text-muted)", fontSize: 13 }}>
                      No tasks
                    </td>
                  </tr>
                ) : (
                  filtered.map((task) => (
                    <tr
                      key={task.id}
                      onClick={() => {
                        if (task.id === selectedId) { tryClosePanel(); return; }
                        if (panelOpen) { tryClosePanel(); pendingSelectRef.current = task.id; return; }
                        setSelectedId(task.id); setCreating(false);
                      }}
                      style={{
                        cursor: "pointer",
                        background: task.id === selectedId ? "var(--bg-hover)" : "transparent",
                        borderBottom: "1px solid var(--border-subtle)",
                        opacity: task.status === "done" ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (task.id !== selectedId) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (task.id !== selectedId) e.currentTarget.style.background = "transparent";
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
                            boxShadow: task.status !== "done" ? `0 0 6px ${STATUS_COLORS[task.status]}` : "none",
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
                          textDecoration: task.status === "done" ? "line-through" : "none",
                          maxWidth: isMobile ? 0 : 300,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {task.title}
                        {task.description && (
                          <span style={{ color: "var(--text-hint)", fontWeight: 400 }}>
                            {" "}| {task.description}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: cellPad, fontSize: 11, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {renderName(task.assignee)}
                      </td>
                      {!isMobile && (
                        <td style={{ padding: cellPad, fontSize: 11, color: "var(--text-hint)", fontFamily: "'JetBrains Mono',monospace" }}>
                          {renderName(task.createdBy)}
                        </td>
                      )}
                      <td style={{ padding: cellPad, fontSize: 10, color: "var(--text-hint)", fontFamily: "'JetBrains Mono',monospace", whiteSpace: "nowrap" }}>
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
        {!isMobile && (creating ? (
          <TaskDetailPanel
            closeRef={closeRef}
            mode="create"
            onClose={() => setCreating(false)}
            username={username}
            agents={agents}
          />
        ) : selectedTask ? (
          <TaskDetailPanel
            closeRef={closeRef}
            task={selectedTask}
            onClose={() => setSelectedId(null)}
            username={username}
            agents={agents}
          />
        ) : null)}
      </div>

      {/* Mobile detail panel as overlay */}
      {(selectedTask || creating) && isMobile && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) tryClosePanel(); }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 900,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(10px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: "90%", maxWidth: 380, maxHeight: "80vh", overflowY: "auto", margin: "0 auto", borderRadius: 12, overflow: "hidden" }}>
            {creating ? (
              <TaskDetailPanel
                closeRef={closeRef}
                mode="create"
                onClose={() => setCreating(false)}
                username={username}
                agents={agents}
              />
            ) : (
              <TaskDetailPanel
                closeRef={closeRef}
                task={selectedTask!}
                onClose={() => setSelectedId(null)}
                username={username}
                agents={agents}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
