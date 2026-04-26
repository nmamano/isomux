import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import {
  MODEL_FAMILIES,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  modelVersionLabel,
  type Cronjob,
  type CronjobPermissionMode,
  type EffortLevel,
  type ModelFamily,
  type Schedule,
} from "../../shared/types.ts";

const WEEKDAYS: { value: 0 | 1 | 2 | 3 | 4 | 5 | 6; label: string }[] = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

type ScheduleType = "daily" | "weekly" | "interval";

export function CronjobDialog({
  cronjob,
  username,
  onClose,
}: {
  cronjob?: Cronjob;
  username: string;
  onClose: () => void;
}) {
  const isEdit = !!cronjob;
  const { recentCwds, isMobile } = useAppState();

  const [name, setName] = useState(cronjob?.name ?? "");
  const [scheduleType, setScheduleType] = useState<ScheduleType>(cronjob?.schedule.type ?? "daily");
  // Time/interval inputs are kept as strings so the user can type "300" without
  // the onChange clamping mid-keystroke (e.g. "3" → clamped to 5). Final values
  // are parsed and clamped at save time.
  const initialHour = cronjob?.schedule.type === "interval" ? 9 : ((cronjob?.schedule as any)?.hour ?? 9);
  const initialMinute = cronjob?.schedule.type === "interval" ? 0 : ((cronjob?.schedule as any)?.minute ?? 0);
  const initialInterval = cronjob?.schedule.type === "interval" ? cronjob.schedule.minutes : 60;
  const [hourStr, setHourStr] = useState(String(initialHour));
  const [minuteStr, setMinuteStr] = useState(String(initialMinute));
  const [weekday, setWeekday] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(cronjob?.schedule.type === "weekly" ? cronjob.schedule.weekday : 1);
  const [intervalStr, setIntervalStr] = useState(String(initialInterval));

  function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
  }
  function parseIntOr(s: string, fallback: number): number {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  const [prompt, setPrompt] = useState(cronjob?.prompt ?? "");
  const [cwd, setCwd] = useState(cronjob?.cwd ?? "~");
  const [modelFamily, setModelFamily] = useState<ModelFamily>(cronjob?.modelFamily ?? "opus");
  const [effort, setEffort] = useState<EffortLevel>(cronjob?.effort ?? DEFAULT_EFFORT);
  const initialPermission: CronjobPermissionMode =
    cronjob?.permissionMode === "auto" && (cronjob?.modelFamily ?? "opus") !== "opus"
      ? "bypassPermissions"
      : (cronjob?.permissionMode ?? "bypassPermissions");
  const [permissionMode, setPermissionMode] = useState<CronjobPermissionMode>(initialPermission);
  const [enabled, setEnabled] = useState(cronjob?.enabled ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recentCwdsFiltered = recentCwds.filter((c) => c !== cwd);
  const pendingListener = useRef<((data: string) => void) | null>(null);

  useEffect(() => {
    return () => {
      if (pendingListener.current) removeRawListener(pendingListener.current);
    };
  }, []);

  // ESC to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  function buildSchedule(): Schedule {
    const hour = clamp(parseIntOr(hourStr, 0), 0, 23);
    const minute = clamp(parseIntOr(minuteStr, 0), 0, 59);
    const intervalMinutes = Math.max(5, parseIntOr(intervalStr, 5));
    if (scheduleType === "daily") return { type: "daily", hour, minute };
    if (scheduleType === "weekly") return { type: "weekly", weekday, hour, minute };
    return { type: "interval", minutes: intervalMinutes };
  }

  function handleSave() {
    if (!prompt.trim()) {
      setError("Prompt cannot be empty.");
      return;
    }
    const reqId = `cronjob-save-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setError(null);
    setSaving(true);
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "agent_save_response" && msg.requestId === reqId) {
          removeRawListener(listener);
          pendingListener.current = null;
          setSaving(false);
          if (msg.ok) onClose();
          else setError(msg.error || "Save failed");
        }
      } catch {}
    };
    addRawListener(listener);
    pendingListener.current = listener;

    if (isEdit) {
      send({
        type: "update_cronjob",
        requestId: reqId,
        id: cronjob!.id,
        changes: {
          name: name.trim() || cronjob!.name,
          schedule: buildSchedule(),
          prompt,
          cwd,
          modelFamily,
          effort,
          permissionMode,
          enabled,
        },
      });
    } else {
      send({
        type: "add_cronjob",
        requestId: reqId,
        name: name.trim() || "Untitled cronjob",
        schedule: buildSchedule(),
        prompt,
        cwd,
        modelFamily,
        effort,
        permissionMode,
        username,
      });
    }
  }

  function handleDelete() {
    if (!cronjob) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    send({ type: "delete_cronjob", id: cronjob.id });
    onClose();
  }

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: isMobile ? "none" : "1px solid var(--border-light)",
          borderRadius: isMobile ? 0 : 16,
          display: "flex",
          flexDirection: "column",
          width: isMobile ? "100%" : 460,
          height: isMobile ? "100dvh" : undefined,
          maxHeight: isMobile ? "100dvh" : "90vh",
          boxShadow: isMobile ? "none" : "0 20px 60px var(--shadow-heavy)",
          animation: "hudIn 0.2s ease-out",
        }}
      >
        <div style={{ overflowY: "auto", flex: 1, padding: isMobile ? "max(24px, env(safe-area-inset-top)) 20px 0" : "24px 28px 0" }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "var(--text-primary)" }}>
            {isEdit ? "Edit Cronjob" : "New Cronjob"}
          </h3>
          {isEdit && (
            <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "2px 0 18px", fontFamily: "'JetBrains Mono',monospace" }}>
              #{cronjob!.id}
            </p>
          )}

          <label style={labelStyle}>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Daily summary"
            autoFocus={!isEdit}
            style={inputStyle}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Schedule</label>
          <select
            value={scheduleType}
            onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer", marginBottom: 6 }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every N minutes</option>
          </select>
          {scheduleType === "weekly" && (
            <select
              value={weekday}
              onChange={(e) => setWeekday(parseInt(e.target.value, 10) as 0 | 1 | 2 | 3 | 4 | 5 | 6)}
              style={{ ...inputStyle, appearance: "none", cursor: "pointer", marginBottom: 6 }}
            >
              {WEEKDAYS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          )}
          {(scheduleType === "daily" || scheduleType === "weekly") && (
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Hour (0-23)</div>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hourStr}
                  onChange={(e) => setHourStr(e.target.value)}
                  onBlur={() => setHourStr(String(clamp(parseIntOr(hourStr, 0), 0, 23)))}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Minute (0-59)</div>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minuteStr}
                  onChange={(e) => setMinuteStr(e.target.value)}
                  onBlur={() => setMinuteStr(String(clamp(parseIntOr(minuteStr, 0), 0, 59)))}
                  style={inputStyle}
                />
              </div>
            </div>
          )}
          {scheduleType === "interval" && (
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Interval (minutes, min 5)</div>
              <input
                type="number"
                min={5}
                value={intervalStr}
                onChange={(e) => setIntervalStr(e.target.value)}
                onBlur={() => setIntervalStr(String(Math.max(5, parseIntOr(intervalStr, 5))))}
                style={inputStyle}
              />
            </div>
          )}
          <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "6px 0 0" }}>Times are server-local.</p>

          <label style={{ ...labelStyle, marginTop: 14 }}>Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Summarize what every agent accomplished yesterday."'
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>Working Directory</label>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={inputStyle}
          />
          {recentCwdsFiltered.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
              {recentCwdsFiltered.map((c) => (
                <button key={c} onClick={() => setCwd(c)} style={chipStyle}>
                  {c.replace(/^\/home\/[^/]+/, "~")}
                </button>
              ))}
            </div>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>Model</label>
          <select
            value={modelFamily}
            onChange={(e) => {
              const next = e.target.value as ModelFamily;
              setModelFamily(next);
              if (next !== "opus" && permissionMode === "auto") setPermissionMode("bypassPermissions");
              if (next !== "opus" && effort === "max") setEffort("xhigh");
            }}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            {MODEL_FAMILIES.map((m) => (
              <option key={m.family} value={m.family}>{m.label} ({modelVersionLabel(m.family)})</option>
            ))}
          </select>

          <label style={{ ...labelStyle, marginTop: 14 }}>Thinking Effort</label>
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as EffortLevel)}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            {EFFORT_LEVELS.filter((opt) => opt.level !== "max" || modelFamily === "opus").map((opt) => (
              <option key={opt.level} value={opt.level}>{opt.label}</option>
            ))}
          </select>

          <label style={{ ...labelStyle, marginTop: 14 }}>Permission Mode</label>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as CronjobPermissionMode)}
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            {modelFamily === "opus" && <option value="auto">Auto (classifier auto-approves safe actions)</option>}
            <option value="bypassPermissions">Bypass (auto-approve all)</option>
          </select>
          <p style={{ fontSize: 10, color: "var(--text-ghost)", margin: "3px 0 0" }}>
            Cronjobs run unattended — modes that require human approval are not available.
          </p>

          {isEdit && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="cronjob-enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              <label htmlFor="cronjob-enabled" style={{ fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
                Enabled (uncheck to pause without deleting)
              </label>
            </div>
          )}

          {error && (
            <p style={{ fontSize: 11, color: "#ff6b6b", margin: "10px 0 0" }}>{error}</p>
          )}
        </div>

        <div style={{
          display: "flex",
          justifyContent: isEdit ? "space-between" : "flex-end",
          gap: 8,
          padding: isMobile ? "16px 20px max(16px, env(safe-area-inset-bottom))" : "16px 28px",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          {isEdit && (
            <button
              onClick={handleDelete}
              onBlur={() => setConfirmDelete(false)}
              style={{
                padding: "7px 16px",
                borderRadius: 8,
                border: `1px solid ${confirmDelete ? "var(--red)" : "var(--border)"}`,
                background: confirmDelete ? "var(--red)" : "transparent",
                color: confirmDelete ? "var(--bg-base)" : "var(--red)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
              disabled={saving}
            >
              {confirmDelete ? "Confirm?" : "Delete"}
            </button>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>Cancel</button>
            <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>{saving ? "Saving…" : (isEdit ? "Save" : "Create")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  marginBottom: 5,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const chipStyle: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--btn-surface)",
  color: "var(--text-muted)",
  fontSize: 10,
  cursor: "pointer",
  fontFamily: "'JetBrains Mono',monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  fontSize: 12,
  cursor: "pointer",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "var(--bg-base)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
