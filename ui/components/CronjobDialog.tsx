import { useEffect, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type {
  CronCreateReq,
  CronUpdateReq,
} from "../../shared/contract-shapes.ts";
import {
  MODEL_FAMILIES,
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  CODEX_MODELS,
  modelVersionLabel,
  claudeFamilySupportsMaxEffort,
  type AgentBackendType,
  type BackendModelWire,
  type CodexSandboxMode,
  type Cronjob,
  type CronjobPermissionMode,
  type EffortLevel,
  type Schedule,
} from "../../shared/types.ts";
import {
  dialogLabel,
  dialogInput,
  dialogCancelBtn,
  dialogSaveBtn,
  dialogChip,
} from "./dialog-styles.ts";

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
  onClose,
}: {
  cronjob?: Cronjob;
  onClose: () => void;
}) {
  const isEdit = !!cronjob;
  const { recentCwds, isMobile } = useAppState();

  const [name, setName] = useState(cronjob?.name ?? "");
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    cronjob?.schedule.type ?? "daily",
  );
  // Time/interval inputs are kept as strings so the user can type "300" without
  // the onChange clamping mid-keystroke (e.g. "3" → clamped to 5). Final values
  // are parsed and clamped at save time.
  const initialHour =
    cronjob?.schedule.type === "daily" || cronjob?.schedule.type === "weekly"
      ? cronjob.schedule.hour
      : 9;
  const initialMinute =
    cronjob?.schedule.type === "daily" || cronjob?.schedule.type === "weekly"
      ? cronjob.schedule.minute
      : 0;
  const initialInterval =
    cronjob?.schedule.type === "interval" ? cronjob.schedule.minutes : 60;
  const [hourStr, setHourStr] = useState(String(initialHour));
  const [minuteStr, setMinuteStr] = useState(String(initialMinute));
  const [weekday, setWeekday] = useState<0 | 1 | 2 | 3 | 4 | 5 | 6>(
    cronjob?.schedule.type === "weekly" ? cronjob.schedule.weekday : 1,
  );
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

  // agentType is fixed at create-time, mirroring agents. The select is
  // disabled on edit; to change engines the user creates a new cronjob.
  const [agentType, setAgentType] = useState<AgentBackendType>(
    cronjob?.agentType ?? "claude",
  );
  const isCodex = agentType === "codex";

  const [modelFamily, setModelFamily] = useState<string>(
    cronjob?.modelFamily ?? "opus",
  );
  const [effort, setEffort] = useState<EffortLevel>(
    cronjob?.effort ?? DEFAULT_EFFORT,
  );
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(
    cronjob?.codexSandbox ?? "workspace-write",
  );
  // Initial permission mode is fixed per engine — the dropdown shows a
  // single option in each case (no human-in-the-loop modes for unattended).
  //   Claude: "bypassPermissions". Legacy "auto" rows have already been
  //           migrated to bypassPermissions at load time.
  //   Codex:  "never".
  const [permissionMode, setPermissionMode] = useState<CronjobPermissionMode>(
    agentType === "codex" ? "never" : "bypassPermissions",
  );
  const [enabled, setEnabled] = useState(cronjob?.enabled ?? true);

  // Codex models are fetched server-side (auth-aware via model/list). null =
  // not yet attempted. On fetch failure we fall back to the hardcoded
  // CODEX_MODELS list. Claude uses the static MODEL_FAMILIES list.
  const [backendModels, setBackendModels] = useState<BackendModelWire[] | null>(
    null,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<{
    message: string;
    authError: boolean;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recentCwdsFiltered = recentCwds.filter((c) => c !== cwd);

  // Engine change resets dependent fields to the new backend's safe defaults
  // so a stale Claude-flavored model/effort/permission doesn't survive a flip
  // to Codex (or vice versa). Locked when editing — see Engine field below.
  function handleEngineChange(next: AgentBackendType) {
    if (next === agentType) return;
    setAgentType(next);
    if (next === "codex") {
      setModelFamily(CODEX_MODELS[0].value);
      setEffort("medium");
      setPermissionMode("never");
    } else {
      setModelFamily("opus");
      setEffort(DEFAULT_EFFORT);
      setPermissionMode("bypassPermissions");
    }
  }

  // Fetch the auth-appropriate Codex model list. Fires when the dialog opens
  // on a Codex cronjob, or when the user flips the Engine select to Codex.
  // GET backends.listModels: a DOMAIN failure (auth/transport in the executor's
  // model probe) comes back as a 200 carrying { models: [], authError, error },
  // NOT a thrown ApiError — so read r.error in .then(); only a real HTTP/network
  // failure reaches .catch().
  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect */
    setModelsLoading(true);
    setModelsError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    apiFetch<{
      models: BackendModelWire[];
      authError?: boolean;
      error?: string;
    }>(
      "GET",
      `/api/backends/${encodeURIComponent(agentType)}/models?cwd=${encodeURIComponent(cwd)}`,
    )
      .then((r) => {
        if (cancelled) return;
        setModelsLoading(false);
        if (r.error) {
          setModelsError({ message: r.error, authError: !!r.authError });
          return;
        }
        setBackendModels(r.models);
        // On create, pick the default. Invariant: prefer Isomux's canonical
        // default (CODEX_MODELS[0], currently gpt-5.6-sol) when this auth tier
        // offers it; otherwise fall back to Codex's per-auth isDefault, then
        // the first listed model. We choose from the visible (non-hidden)
        // models so the value always matches a rendered <option>. The model
        // select is disabled during loading so the user can't have
        // overridden us.
        if (!isEdit) {
          const preferredModelId = CODEX_MODELS[0].value;
          const visibleModels = r.models.filter((m) => !m.hidden);
          const def =
            visibleModels.find((m) => m.id === preferredModelId) ??
            visibleModels.find((m) => m.isDefault) ??
            visibleModels[0];
          if (def) {
            setModelFamily(def.id);
            if (def.defaultEffort) setEffort(def.defaultEffort as EffortLevel);
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setModelsLoading(false);
        setModelsError({
          message: e instanceof ApiError ? e.message : "Failed to load models",
          authError: false,
        });
      });
    return () => {
      cancelled = true;
    };
    // Intentionally not depending on cwd: re-fetching on every keystroke
    // would spawn a codex subprocess per character. Auth is global, so the
    // result is the same regardless of the cwd we hand model/list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCodex, agentType]);

  // ESC to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  function buildSchedule(): Schedule {
    const hour = clamp(parseIntOr(hourStr, 0), 0, 23);
    const minute = clamp(parseIntOr(minuteStr, 0), 0, 59);
    const intervalMinutes = Math.max(5, parseIntOr(intervalStr, 5));
    if (scheduleType === "daily") return { type: "daily", hour, minute };
    if (scheduleType === "weekly")
      return { type: "weekly", weekday, hour, minute };
    return { type: "interval", minutes: intervalMinutes };
  }

  function handleSave() {
    if (!prompt.trim()) {
      setError("Prompt cannot be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    // HTTP correlates the response natively; on success close the dialog, on an
    // ApiError surface the server's validation message (parity with the old
    // agent_save_response.error). Same .then/.catch shape as the model load.
    let req: Promise<unknown>;
    if (isEdit) {
      // agentType is intentionally omitted — immutable on edit. CronUpdateReq is
      // the changes FLAT (not wrapped in { changes } like the old WS command).
      const body: CronUpdateReq = {
        name: name.trim() || cronjob.name,
        schedule: buildSchedule(),
        prompt,
        cwd,
        modelFamily,
        effort,
        permissionMode,
        ...(isCodex ? { codexSandbox } : {}),
        enabled,
      };
      req = apiFetch(
        "PATCH",
        `/api/cronjobs/${encodeURIComponent(cronjob.id)}`,
        body,
      );
    } else {
      // username is omitted — the server derives attribution from identity.
      const body: CronCreateReq = {
        name: name.trim() || "Untitled cron job",
        schedule: buildSchedule(),
        prompt,
        cwd,
        agentType,
        modelFamily,
        effort,
        permissionMode,
        ...(isCodex ? { codexSandbox } : {}),
      };
      req = apiFetch("POST", "/api/cronjobs", body);
    }
    req
      .then(() => onClose())
      .catch((e) => setError(e instanceof ApiError ? e.message : "Save failed"))
      .finally(() => setSaving(false));
  }

  function handleDelete() {
    if (!cronjob) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // Fire-and-forget (parity with the old WS delete); the cronjob_deleted event
    // removes it from the list. Optimistically close.
    apiFetch("DELETE", `/api/cronjobs/${encodeURIComponent(cronjob.id)}`).catch(
      () => {},
    );
    onClose();
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
        <div
          style={{
            overflowY: "auto",
            flex: 1,
            padding: isMobile
              ? "max(24px, env(safe-area-inset-top)) 20px 0"
              : "24px 28px 0",
          }}
        >
          <h3
            style={{
              fontSize: 17,
              fontWeight: 700,
              margin: 0,
              color: "var(--text-primary)",
            }}
          >
            {isEdit ? "Edit Cron Job" : "New Cron Job"}
          </h3>
          {isEdit && (
            <p
              style={{
                fontSize: 11,
                color: "var(--text-faint)",
                margin: "2px 0 18px",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              #{cronjob.id}
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
            style={{
              ...inputStyle,
              appearance: "none",
              cursor: "pointer",
              marginBottom: 6,
            }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every N minutes</option>
          </select>
          {scheduleType === "weekly" && (
            <select
              value={weekday}
              onChange={(e) =>
                setWeekday(
                  parseInt(e.target.value, 10) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
                )
              }
              style={{
                ...inputStyle,
                appearance: "none",
                cursor: "pointer",
                marginBottom: 6,
              }}
            >
              {WEEKDAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          {(scheduleType === "daily" || scheduleType === "weekly") && (
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    marginBottom: 4,
                  }}
                >
                  Hour (0-23)
                </div>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hourStr}
                  onChange={(e) => setHourStr(e.target.value)}
                  onBlur={() =>
                    setHourStr(String(clamp(parseIntOr(hourStr, 0), 0, 23)))
                  }
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    marginBottom: 4,
                  }}
                >
                  Minute (0-59)
                </div>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minuteStr}
                  onChange={(e) => setMinuteStr(e.target.value)}
                  onBlur={() =>
                    setMinuteStr(String(clamp(parseIntOr(minuteStr, 0), 0, 59)))
                  }
                  style={inputStyle}
                />
              </div>
            </div>
          )}
          {scheduleType === "interval" && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginBottom: 4,
                }}
              >
                Interval (minutes, min 5)
              </div>
              <input
                type="number"
                min={5}
                value={intervalStr}
                onChange={(e) => setIntervalStr(e.target.value)}
                onBlur={() =>
                  setIntervalStr(
                    String(Math.max(5, parseIntOr(intervalStr, 5))),
                  )
                }
                style={inputStyle}
              />
            </div>
          )}
          <p
            style={{
              fontSize: 10,
              color: "var(--text-ghost)",
              margin: "6px 0 0",
            }}
          >
            Times are server-local.
          </p>

          <label style={{ ...labelStyle, marginTop: 14 }}>Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Summarize what every agent accomplished yesterday."'
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />

          <label style={{ ...labelStyle, marginTop: 14 }}>
            Working Directory
          </label>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            style={inputStyle}
          />
          {recentCwdsFiltered.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
              }}
            >
              {recentCwdsFiltered.map((c) => (
                <button key={c} onClick={() => setCwd(c)} style={chipStyle}>
                  {c.replace(/^\/home\/[^/]+/, "~")}
                </button>
              ))}
            </div>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>Engine</label>
          {isEdit ? (
            // Locked on edit, mirroring agents. To switch engines the user
            // creates a new cronjob.
            <div
              title="Engine is fixed at create time — to switch engines, create a new cronjob."
              style={{
                ...inputStyle,
                display: "flex",
                alignItems: "center",
                color: "var(--text-muted)",
                fontFamily: "'JetBrains Mono',monospace",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontWeight: 600,
                cursor: "not-allowed",
                background: "var(--bg-elevated)",
              }}
            >
              {agentType}
            </div>
          ) : (
            <select
              value={agentType}
              onChange={(e) =>
                handleEngineChange(e.target.value as AgentBackendType)
              }
              style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>Model</label>
          {(() => {
            // Codex models come from the server (auth-aware via model/list).
            // On fetch failure OR an empty list we fall back to the hardcoded
            // CODEX_MODELS list so the dialog is still usable (an empty fetched
            // list would otherwise render a zero-option select). Claude uses
            // MODEL_FAMILIES.
            const codexFetched =
              isCodex && backendModels && backendModels.length > 0;
            const codexVisible = codexFetched
              ? backendModels.filter((m) => !m.hidden)
              : null;
            // Pin the stored model as an extra option whenever the rendered
            // list (the fetched list OR the CODEX_MODELS fallback) lacks it, so
            // editing never silently drops a value not offered on this login.
            const renderedModelIds = codexVisible
              ? codexVisible.map((m) => m.id)
              : CODEX_MODELS.map((m) => m.value);
            const storedNotInList =
              isEdit && isCodex && !renderedModelIds.includes(modelFamily);
            return (
              <select
                value={modelFamily}
                onChange={(e) => {
                  const next = e.target.value;
                  setModelFamily(next);
                  // Claude family-level interlock: "max" effort is top-tier
                  // only. (The "auto" permission mode interlock is gone now
                  // that cron's only Claude permission option is
                  // bypassPermissions.)
                  if (
                    !isCodex &&
                    !claudeFamilySupportsMaxEffort(next) &&
                    effort === "max"
                  )
                    setEffort("xhigh");
                  // Codex: snap effort to the new model's default if the
                  // current effort isn't in its supportedEfforts list.
                  if (isCodex && codexVisible) {
                    const picked = codexVisible.find((m) => m.id === next);
                    if (picked) {
                      const supported = new Set(
                        picked.supportedEfforts.map((o) => o.level),
                      );
                      if (!supported.has(effort) && picked.defaultEffort) {
                        setEffort(picked.defaultEffort as EffortLevel);
                      }
                    }
                  }
                }}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
                disabled={isCodex && modelsLoading}
              >
                {isCodex ? (
                  <>
                    {codexVisible
                      ? codexVisible.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))
                      : CODEX_MODELS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                    {storedNotInList && (
                      <option key={modelFamily} value={modelFamily}>
                        {modelFamily} (unavailable on current login)
                      </option>
                    )}
                  </>
                ) : (
                  MODEL_FAMILIES.map((m) => (
                    <option key={m.family} value={m.family}>
                      {m.label} ({modelVersionLabel(m.family)})
                    </option>
                  ))
                )}
              </select>
            );
          })()}
          {isCodex && modelsLoading && (
            <p
              style={{
                fontSize: 10,
                color: "var(--text-ghost)",
                margin: "3px 0 0",
              }}
            >
              Loading available models…
            </p>
          )}
          {isCodex && modelsError && !modelsLoading && (
            <p
              style={{
                fontSize: 10,
                color: "#ff6b6b",
                margin: "3px 0 0",
              }}
            >
              {modelsError.message}
              {modelsError.authError
                ? " — sign in via the card a Codex agent emits."
                : ""}
            </p>
          )}

          <label style={{ ...labelStyle, marginTop: 14 }}>
            Thinking Effort
          </label>
          {(() => {
            // Codex: per-model supportedEfforts from model/list when available.
            // Claude: family-level rules (max only for opus).
            let effortOptions: { level: string; label: string }[];
            if (isCodex) {
              const picked = backendModels?.find((m) => m.id === modelFamily);
              if (picked && picked.supportedEfforts.length > 0) {
                effortOptions = picked.supportedEfforts.map((o) => {
                  const match = EFFORT_LEVELS.find((e) => e.level === o.level);
                  return {
                    level: o.level,
                    label: match
                      ? match.label
                      : o.level.charAt(0).toUpperCase() + o.level.slice(1),
                  };
                });
              } else {
                // No supportedEfforts reported (or list not yet loaded): fall
                // back to the static list minus "max"/"ultra" (not universal
                // across Codex models — e.g. luna lacks ultra; the dynamic
                // per-model list is the real source when available).
                effortOptions = EFFORT_LEVELS.filter(
                  (opt) => opt.level !== "max" && opt.level !== "ultra",
                ).map((o) => ({ level: o.level, label: o.label }));
              }
            } else {
              effortOptions = EFFORT_LEVELS.filter((opt) => {
                if (opt.level === "max")
                  return claudeFamilySupportsMaxEffort(modelFamily);
                if (opt.level === "minimal") return false; // Codex-only
                if (opt.level === "ultra") return false; // Codex-only
                return true;
              }).map((o) => ({ level: o.level, label: o.label }));
            }
            return (
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as EffortLevel)}
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
              >
                {effortOptions.map((opt) => (
                  <option key={opt.level} value={opt.level}>
                    {opt.label}
                  </option>
                ))}
              </select>
            );
          })()}

          <label style={{ ...labelStyle, marginTop: 14 }}>
            {isCodex ? "Approval Policy" : "Permission Mode"}
          </label>
          <select
            value={permissionMode}
            onChange={(e) =>
              setPermissionMode(e.target.value as CronjobPermissionMode)
            }
            style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
          >
            {isCodex ? (
              <option value="never">Never ask (use sandbox-only)</option>
            ) : (
              <option value="bypassPermissions">
                Bypass (auto-approve all)
              </option>
            )}
          </select>
          <p
            style={{
              fontSize: 10,
              color: "var(--text-ghost)",
              margin: "3px 0 0",
            }}
          >
            Cron jobs run unattended — modes that require human approval are not
            available.
          </p>

          {isCodex && (
            <>
              <label style={{ ...labelStyle, marginTop: 14 }}>Sandbox</label>
              <select
                value={codexSandbox}
                onChange={(e) =>
                  setCodexSandbox(e.target.value as CodexSandboxMode)
                }
                style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}
              >
                <option value="read-only">
                  Read-only (model can read, never write)
                </option>
                <option value="workspace-write">
                  Workspace write (write inside cwd only)
                </option>
                <option value="danger-full-access">
                  Danger: full access (no sandbox)
                </option>
              </select>
            </>
          )}

          {isEdit && (
            <div
              style={{
                marginTop: 14,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <input
                type="checkbox"
                id="cronjob-enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              <label
                htmlFor="cronjob-enabled"
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                Enabled (uncheck to pause without deleting)
              </label>
            </div>
          )}

          {error && (
            <p style={{ fontSize: 11, color: "#ff6b6b", margin: "10px 0 0" }}>
              {error}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: isEdit ? "space-between" : "flex-end",
            gap: 8,
            padding: isMobile
              ? "16px 20px max(16px, env(safe-area-inset-bottom))"
              : "16px 28px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
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
            <button onClick={onClose} style={cancelBtnStyle} disabled={saving}>
              Cancel
            </button>
            <button onClick={handleSave} style={saveBtnStyle} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = dialogLabel;
const inputStyle: React.CSSProperties = dialogInput;
const chipStyle: React.CSSProperties = dialogChip;
const cancelBtnStyle: React.CSSProperties = dialogCancelBtn;
const saveBtnStyle: React.CSSProperties = dialogSaveBtn;
