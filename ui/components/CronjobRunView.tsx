import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { LogEntryCard } from "../log-view/LogEntryCard.tsx";
import { send } from "../ws.ts";
import {
  cronjobRunStreamId,
  type CronjobRun,
  type LogEntry,
} from "../../shared/types.ts";
import { getDevice } from "../device-settings.ts";

const STATUS_LABEL: Record<CronjobRun["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  skipped: "Skipped",
};

const STATUS_COLOR: Record<CronjobRun["status"], string> = {
  running: "var(--green)",
  completed: "var(--text-secondary)",
  failed: "var(--red)",
  timed_out: "var(--orange, #d29922)",
  skipped: "var(--text-muted)",
};

// Cronjob runs are resumable: any boss can send follow-up turns into a past
// run, and edit-to-fork lets them branch from any prior user message. The
// server-side handlers live in cronjob-manager.ts (sendRunMessage,
// editRunMessage); see send_cronjob_run_message / edit_cronjob_run_message.
export function CronjobRunView({
  jobId,
  runId,
  username,
  onClose,
}: {
  jobId: string;
  runId: string;
  username: string;
  onClose: () => void;
}) {
  const { cronjobRunsByJob, isMobile, logs } = useAppState();
  // Use `pointer: coarse` instead of viewport `isMobile` so narrow desktop
  // windows (split-screen) with a hardware keyboard still send on Enter.
  const isTouchPrimary = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );
  const streamId = cronjobRunStreamId(runId);
  const runs = cronjobRunsByJob.get(jobId) ?? [];
  const run = runs.find((r) => r.id === runId);
  const device = getDevice();

  const [input, setInput] = useState("");
  const [editingLogEntryId, setEditingLogEntryId] = useState<string | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Always backfill the historical transcript on open. The previous
  // optimization (skip if any live entries are cached) dropped pre-connect
  // entries when the user clicked a run that had started before they opened
  // the app. The reducer dedupes by id, so re-sending overlapping entries is
  // harmless.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    send({ type: "load_cronjob_run", cronjobId: jobId, runId });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(true);
  }, [jobId, runId, loaded]);

  // ESC closes the view, unless the user is editing a message — then ESC
  // cancels the edit (handled inside EditableUserMessage).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !editingLogEntryId) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, editingLogEntryId]);

  // Sort by server-assigned timestamp on render. Live entries (which arrive
  // first while the user has the page open) may be appended to the store
  // before the historical backfill arrives; without this sort the transcript
  // would render [live..., backfill...] = out of order.
  const entries: LogEntry[] = useMemo(() => {
    const raw = logs.get(streamId) ?? [];
    return [...raw].sort((a, b) => a.timestamp - b.timestamp);
  }, [logs, streamId]);

  const turnData = useMemo(() => {
    type T = { isLastInTurn: boolean; turnEntries: LogEntry[] };
    const map = new Map<string, T>();
    let buf: LogEntry[] = [];
    function flush() {
      if (buf.length === 0) return;
      buf.forEach((e, i) =>
        map.set(e.id, { isLastInTurn: i === buf.length - 1, turnEntries: buf }),
      );
      buf = [];
    }
    for (const e of entries) {
      if (e.kind === "user_message") {
        flush();
        map.set(e.id, { isLastInTurn: false, turnEntries: [] });
      } else {
        buf.push(e);
      }
    }
    flush();
    return map;
  }, [entries]);

  const isRunning = run?.status === "running";
  // Skipped runs never opened a session and runs whose original session never
  // initialized (the placeholder pending-/skipped- ids) can't be resumed.
  const leafSessionId = run?.currentSessionId ?? run?.rootSessionId ?? "";
  const hasResumableSession =
    !leafSessionId.startsWith("pending-") &&
    !leafSessionId.startsWith("skipped-");
  const canResume =
    !!run && !isRunning && run.status !== "skipped" && hasResumableSession;

  // Auto-scroll to bottom on new entries when the user hasn't scrolled up.
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    const el = scrollRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }, [entries.length, autoScroll]);

  // Cancel any in-progress edit when a run kicks off, so the input box (which
  // is hidden during run) doesn't leave the inline editor stranded.
  useEffect(() => {
    if (isRunning && editingLogEntryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditingLogEntryId(null);
    }
  }, [isRunning, editingLogEntryId]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  function handleSend() {
    const text = input.trim();
    if (!text || !canResume) return;
    send({
      type: "send_cronjob_run_message",
      cronjobId: jobId,
      runId,
      text,
      username,
      device: device || undefined,
    });
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setAutoScroll(true);
  }

  function handleSubmitEdit(id: string, newText: string) {
    setEditingLogEntryId(null);
    send({
      type: "edit_cronjob_run_message",
      cronjobId: jobId,
      runId,
      logEntryId: id,
      newText,
      username,
      device: device || undefined,
    });
    setAutoScroll(true);
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 950,
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: isMobile ? "0 8px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 48,
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-strong)",
          flexShrink: 0,
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
            flexShrink: 0,
          }}
        >
          ←
        </button>
        {run ? (
          isMobile ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minWidth: 0,
                padding: "6px 0",
                gap: 2,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {run.cronjobName}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: STATUS_COLOR[run.status],
                    fontFamily: "'JetBrains Mono',monospace",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {STATUS_LABEL[run.status]}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                <span>
                  {new Date(run.startedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span style={{ color: "var(--text-ghost)" }}>
                  {run.trigger === "manual" ? "manual" : "scheduled"}
                </span>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {run.cronjobName}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: STATUS_COLOR[run.status],
                  fontFamily: "'JetBrains Mono',monospace",
                  fontWeight: 600,
                }}
              >
                {STATUS_LABEL[run.status]}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {new Date(run.startedAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-ghost)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {run.trigger === "manual"
                  ? `manual${run.triggeredBy ? ` · ${run.triggeredBy}` : ""}`
                  : "scheduled"}
              </span>
            </div>
          )
        ) : (
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            Run #{runId}
          </span>
        )}
      </div>

      {/* Body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? "12px" : "16px 24px",
        }}
      >
        {run && (
          <div
            style={{
              padding: "10px 14px",
              marginBottom: 12,
              borderRadius: 8,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              fontSize: 12,
              color: "var(--text-secondary)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                marginBottom: 4,
              }}
            >
              PROMPT
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{run.promptSnapshot}</div>
            <div
              style={{ marginTop: 8, fontSize: 10, color: "var(--text-ghost)" }}
            >
              cwd: {run.cwdSnapshot} · model: {run.modelFamilySnapshot} ·
              effort: {run.effortSnapshot} · permission:{" "}
              {run.permissionModeSnapshot}
            </div>
            {run.errorReason && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--red)" }}>
                Error: {run.errorReason}
              </div>
            )}
          </div>
        )}
        {entries.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: "var(--text-ghost)",
              padding: 40,
            }}
          >
            {run?.status === "skipped"
              ? "This run was skipped."
              : "No log entries."}
          </div>
        ) : (
          entries.map((entry) => {
            const td = turnData.get(entry.id);
            const canEditMsg =
              canResume && entry.kind === "user_message" && !editingLogEntryId;
            return (
              <LogEntryCard
                key={entry.id}
                entry={entry}
                isLastInTurn={td?.isLastInTurn}
                turnEntries={td?.turnEntries}
                isMobile={isMobile}
                canEdit={canEditMsg}
                isEditing={editingLogEntryId === entry.id}
                onStartEdit={setEditingLogEntryId}
                onCancelEdit={() => setEditingLogEntryId(null)}
                onSubmitEdit={handleSubmitEdit}
              />
            );
          })
        )}
        {isRunning && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 14px",
              margin: "8px 0",
              color: "var(--green)",
              fontSize: 12,
            }}
          >
            <span style={{ display: "inline-flex", gap: 3 }}>
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--green)",
                  animation: "dotBounce 1.4s ease-in-out infinite",
                  animationDelay: "0s",
                }}
              />
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--green)",
                  animation: "dotBounce 1.4s ease-in-out infinite",
                  animationDelay: "0.2s",
                }}
              />
              <span
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--green)",
                  animation: "dotBounce 1.4s ease-in-out infinite",
                  animationDelay: "0.4s",
                }}
              />
            </span>
            <span>Running...</span>
          </div>
        )}
      </div>

      {/* Input — replaces the old read-only banner. Hidden for unresumable runs. */}
      {canResume ? (
        <div
          style={{
            flexShrink: 0,
            padding: isMobile ? "10px 12px 10px 11px" : "10px 24px 10px 11px",
            paddingBottom: isMobile
              ? "calc(10px + env(safe-area-inset-bottom, 0px))"
              : undefined,
            borderTop: "2px solid var(--border-strong)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span
              style={{
                color: "var(--green)",
                fontWeight: 600,
                lineHeight: "20px",
                position: "relative",
                top: -2,
              }}
            >
              &#10095;
            </span>
            <div style={{ flex: 1, position: "relative", top: -2 }}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoResize(e.target);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !isTouchPrimary &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  editingLogEntryId
                    ? "Editing message above..."
                    : "Send a follow-up"
                }
                autoFocus={!isMobile}
                rows={1}
                disabled={!!editingLogEntryId}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: editingLogEntryId
                    ? "var(--text-muted)"
                    : "var(--text-secondary)",
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: isMobile ? 16 : 13,
                  caretColor: "var(--green)",
                  resize: "none",
                  padding: "0 0 4px",
                  lineHeight: "20px",
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              />
            </div>
            {isMobile && (
              <button
                onClick={handleSend}
                disabled={!input.trim() || !!editingLogEntryId}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  border: "none",
                  background:
                    input.trim() && !editingLogEntryId
                      ? "var(--green)"
                      : "var(--bg-hover)",
                  color:
                    input.trim() && !editingLogEntryId
                      ? "var(--bg-base)"
                      : "var(--text-ghost)",
                  fontSize: 16,
                  cursor:
                    input.trim() && !editingLogEntryId ? "pointer" : "default",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
                title="Send"
              >
                ▲
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
            fontSize: 11,
            color: "var(--text-muted)",
            textAlign: "center",
          }}
        >
          {isRunning
            ? "Run in progress — wait for it to finish before sending a follow-up."
            : run?.status === "skipped"
              ? "Skipped runs have no session to resume."
              : "This run can't be resumed (no session was established)."}
        </div>
      )}
    </div>
  );
}
