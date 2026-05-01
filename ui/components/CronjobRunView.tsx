import { useEffect, useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { LogEntryCard } from "../log-view/LogEntryCard.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import { cronjobRunStreamId, type CronjobRun, type LogEntry } from "../../shared/types.ts";

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

// Read-only transcript viewer for a cronjob run. Resume / edit-to-fork into
// runs is a planned follow-up; for now the user can re-trigger the cronjob
// with "Run now" to spawn a fresh run.
export function CronjobRunView({
  jobId,
  runId,
  onClose,
}: {
  jobId: string;
  runId: string;
  onClose: () => void;
}) {
  const { cronjobRunsByJob, isMobile, logs } = useAppState();
  const streamId = cronjobRunStreamId(runId);
  const runs = cronjobRunsByJob.get(jobId) ?? [];
  const run = runs.find((r) => r.id === runId);

  // Always backfill the historical transcript on open. The previous
  // optimization (skip if any live entries are cached) dropped pre-connect
  // entries when the user clicked a run that had started before they opened
  // the app. The reducer dedupes by id, so re-sending overlapping entries is
  // harmless.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    send({ type: "load_cronjob_run", cronjobId: jobId, runId });
    setLoaded(true);
  }, [jobId, runId, loaded]);

  // ESC closes
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  // Sort by server-assigned timestamp on render. Live entries (which arrive
  // first while the user has the page open) may be appended to the store
  // before the historical backfill arrives; without this sort the transcript
  // would render [live..., backfill...] = out of order.
  const entries: LogEntry[] = useMemo(() => {
    const raw = logs.get(streamId) ?? [];
    return [...raw].sort((a, b) => a.timestamp - b.timestamp);
  }, [logs, streamId]);
  // Compute the user_message turn boundaries for LogEntryCard's grouping.
  const turnData = useMemo(() => {
    type T = { isLastInTurn: boolean; turnEntries: LogEntry[] };
    const map = new Map<string, T>();
    let buf: LogEntry[] = [];
    function flush() {
      if (buf.length === 0) return;
      buf.forEach((e, i) => map.set(e.id, { isLastInTurn: i === buf.length - 1, turnEntries: buf }));
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

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
          justifyContent: "space-between",
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          height: 48,
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-strong)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
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
            ←
          </button>
          {run ? (
            <>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {run.cronjobName}
              </span>
              <span style={{ fontSize: 11, color: STATUS_COLOR[run.status], fontFamily: "'JetBrains Mono',monospace", fontWeight: 600 }}>
                {STATUS_LABEL[run.status]}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono',monospace" }}>
                {new Date(run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-ghost)", fontFamily: "'JetBrains Mono',monospace" }}>
                {run.trigger === "manual" ? "manual" : "scheduled"}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Run #{runId}</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "12px" : "16px 24px" }}>
        {run && (
          <div style={{
            padding: "10px 14px",
            marginBottom: 12,
            borderRadius: 8,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            fontSize: 12,
            color: "var(--text-secondary)",
            fontFamily: "'JetBrains Mono',monospace",
          }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>PROMPT</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{run.promptSnapshot}</div>
            <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-ghost)" }}>
              cwd: {run.cwdSnapshot} · model: {run.modelFamilySnapshot} · effort: {run.effortSnapshot} · permission: {run.permissionModeSnapshot}
            </div>
            {run.errorReason && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--red)" }}>
                Error: {run.errorReason}
              </div>
            )}
          </div>
        )}
        {entries.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--text-ghost)", padding: 40 }}>
            {run?.status === "skipped" ? "This run was skipped." : "No log entries."}
          </div>
        ) : (
          entries.map((entry) => {
            const td = turnData.get(entry.id);
            return (
              <LogEntryCard
                key={entry.id}
                entry={entry}
                isLastInTurn={td?.isLastInTurn}
                turnEntries={td?.turnEntries}
                isMobile={isMobile}
                canEdit={false}
                isEditing={false}
                onStartEdit={() => {}}
                onCancelEdit={() => {}}
                onSubmitEdit={() => {}}
              />
            );
          })
        )}
      </div>

      <div style={{
        padding: "10px 16px",
        borderTop: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        fontSize: 11,
        color: "var(--text-muted)",
        textAlign: "center",
      }}>
        Run transcripts are read-only. Use "Run now" on the cron job to start a fresh run.
      </div>
    </div>
  );
}
