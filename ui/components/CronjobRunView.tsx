import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { LogEntryCard } from "../log-view/LogEntryCard.tsx";
import { apiFetch } from "../api.ts";
import {
  cronjobRunStreamId,
  type CronjobRun,
  type LogEntry,
} from "../../shared/types.ts";
import { getDevice } from "../device-settings.ts";
import { shortenCwd } from "../cwd-display.ts";

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

// The transcript backfill guard, as a decision so it can be tested without a
// React render harness (the UI has none). Epoch 0 means nothing has hydrated
// yet: the full_state that is about to land would wipe whatever we fetched, so
// wait for it rather than spending a request twice.
export function transcriptFetchAction(
  hydrationEpoch: number,
  fetchedKey: string | null,
  fetchKey: string,
): "fetch" | "skip" {
  if (hydrationEpoch === 0) return "skip";
  return fetchedKey === fetchKey ? "skip" : "fetch";
}

// Cronjob runs are resumable: any boss can send follow-up turns into a past
// run, and edit-to-fork lets them branch from any prior user message. The
// server-side handlers live in cronjob-manager.ts (sendRunMessage,
// editRunMessage), reached via the REST routes cron.runMessage (POST) /
// cron.editRunMessage (PATCH).
export function CronjobRunView({
  jobId,
  runId,
  onClose,
}: {
  jobId: string;
  runId: string;
  onClose: () => void;
}) {
  const { cronjobRunsByJob, isMobile, logs, hydrationEpoch } = useAppState();
  const dispatch = useDispatch();
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
  //
  // The once-only guard is a ref holding the {jobId,runId} it already fetched,
  // not a bare boolean: a boolean would never reset if this view were ever
  // reused for a different run without unmounting. Today it is a per-run
  // overlay that always remounts, so the key comparison is belt-and-braces -
  // but it costs nothing and removes the latent trap.
  //
  // "Once" means once per HYDRATION, not once per mount: a WS reconnect sends
  // full_state, which drops every log stream except the focused agent's, and
  // the server's replay is agent-only - so this run's transcript is gone and
  // nothing brings it back (pinned in store.test.ts). Folding hydrationEpoch
  // into the key is what makes the next hydration refetch it.
  //
  // The epoch rather than `connected`: ws.ts's onVisible() reconnects a frozen
  // mobile socket without ever flipping connected false (dead socket, ping
  // throw, pong timeout), so a false->true edge is not something every
  // reconnect produces. full_state always arrives.
  const runKey = `${jobId}\u0000${runId}`;
  const fetchKey = `${runKey}\u0000${hydrationEpoch}`;
  const fetchedKeyRef = useRef<string | null>(null);
  // The run as the server returned it, kept only as a header fallback for when
  // the store has no copy (see `run` below). Keyed by runKey, NOT fetchKey, so
  // a hydration doesn't blank the header back to "Run #<id>" for the length of
  // the refetch; a stale answer from a previous run still can't be shown.
  const [fetchedRun, setFetchedRun] = useState<{
    key: string;
    run: CronjobRun;
  } | null>(null);
  useEffect(() => {
    const action = transcriptFetchAction(
      hydrationEpoch,
      fetchedKeyRef.current,
      fetchKey,
    );
    if (action === "skip") return;
    fetchedKeyRef.current = fetchKey;
    // Fetch the historical transcript and merge it into the run's log stream
    // (the same stream live `log_entry` events feed during an active run). The
    // batch reducer dedupes by id, so overlapping live entries are neither
    // dropped nor duplicated.
    apiFetch<{ run: CronjobRun; entries: LogEntry[] }>(
      "GET",
      `/api/cronjobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(
        runId,
      )}`,
    )
      .then(({ run, entries }) => {
        dispatch({ type: "log_entries_batch", entries });
        setFetchedRun({ key: runKey, run });
      })
      .catch(() => {
        // 404 (run gone) or transport error: leave the stream as-is. Matches the
        // old load_cronjob_run, which replayed zero entries for a missing run, so
        // the view still shows "No log entries."; any live entries already in the
        // stream are preserved, and the header keeps its "Run #<id>" fallback.
      });
  }, [jobId, runId, runKey, fetchKey, hydrationEpoch, dispatch]);

  // Store first, fetched copy second. The store (cronjobRunsByJob) is the live
  // one: cron list queries seed it and `cronjob_run_updated` events keep it
  // current, and that event UPSERTS, so a status change lands there even for a
  // run the list never loaded - which is why preferring it keeps the header
  // live. The fetched copy only fills the gap where the store has nothing at
  // all: a deep link to a run whose list hasn't loaded, or a run whose cronjob
  // was deleted. Without it the header would read "Run #<id>" with no metadata.
  const run =
    runs.find((r) => r.id === runId) ??
    (fetchedRun?.key === runKey ? fetchedRun.run : undefined);

  // ESC closes the view, unless the user is editing a message - then ESC
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
    // Fire-and-forget: the user_message and the run's reply stream back via live
    // cron_run_log_entry / log_entry events, so the { messageId } ack is ignored.
    // .catch stays silent for parity with the old fire-and-forget WS command (a
    // non-owner / unknown-run was dropped without a user-visible error).
    apiFetch(
      "POST",
      `/api/cronjobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(
        runId,
      )}/messages`,
      { text, device: device || undefined },
    ).catch(() => {});
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setAutoScroll(true);
  }

  function handleSubmitEdit(id: string, newText: string) {
    setEditingLogEntryId(null);
    // Fire-and-forget (see handleSend): the edit re-forks the run server-side and
    // the result streams back as live events; the { messageId } ack is ignored
    // and .catch stays silent for parity with the old WS command.
    apiFetch(
      "PATCH",
      `/api/cronjobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(
        runId,
      )}/messages/${encodeURIComponent(id)}`,
      { newText, device: device || undefined },
    ).catch(() => {});
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
              cwd: {shortenCwd(run.cwdSnapshot)} · model:{" "}
              {run.modelFamilySnapshot} · effort: {run.effortSnapshot} ·
              permission: {run.permissionModeSnapshot}
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

      {/* Input - replaces the old read-only banner. Hidden for unresumable runs. */}
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
            ? "Run in progress - wait for it to finish before sending a follow-up."
            : run?.status === "skipped"
              ? "Skipped runs have no session to resume."
              : "This run can't be resumed (no session was established)."}
        </div>
      )}
    </div>
  );
}
