import { StatusShape } from "./StatusShape.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch } from "../api.ts";
import type { CronUpdateReq } from "../../shared/contract-shapes.ts";
import { CronjobDialog } from "./CronjobDialog.tsx";
import { CronjobsPromptDialog } from "./CronjobsPromptDialog.tsx";
import { CronjobRunView } from "./CronjobRunView.tsx";
import { WebhooksView } from "./WebhooksView.tsx";
import { WebhookDialog } from "./WebhookDialog.tsx";
import {
  type CronjobListWire,
  type CronjobRun,
  type CronjobRunStatus,
  type WebhookWire,
} from "../../shared/types.ts";
import { lastRunAt } from "../webhook-helpers.ts";
import { getRoomFilter, setRoomFilter } from "../device-settings.ts";
import {
  effectiveRoomFilter,
  knownRoomId,
  roomFilterMatches,
  roomFilterOptions,
  ROOM_FILTER_ALL,
  ROOM_FILTER_NONE,
} from "../room-filter.ts";
import { RoomFilterSelect } from "./RoomFilterSelect.tsx";
import { useI18n } from "../i18n.tsx";
import {
  formatDateTime,
  timeSince,
  timeUntilFine,
} from "../../shared/i18n/time.ts";
import { scheduleText } from "../../shared/i18n/schedule.ts";
import type { MessageKey, Translator } from "../../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";

// The two ways to start work, then the history of both (Nil, 2026-10-06).
type Tab = "cronjobs" | "webhooks" | "runs";
const TABS: Tab[] = ["cronjobs", "webhooks", "runs"];
// Keys, not words: a table of finished text would freeze the language it was
// built in (internal-docs/i18n-loop.md, the S5 id-to-key pattern).
const TAB_LABEL: Record<Tab, Extract<MessageKey, `schedules.tab.${string}`>> = {
  cronjobs: "schedules.tab.cronjobs",
  webhooks: "schedules.tab.webhooks",
  runs: "schedules.tab.runs",
};

const STATUS_ICON: Record<CronjobRunStatus, React.ReactNode> = {
  running: <StatusShape kind="dot" />,
  completed: <StatusShape kind="check" />,
  failed: "✗",
  timed_out: "⏱",
  skipped: "⊘",
};

const STATUS_COLOR: Record<CronjobRunStatus, string> = {
  running: "var(--green-text)",
  completed: "var(--text-secondary)",
  failed: "var(--red-text)",
  timed_out: "var(--orange-text)",
  skipped: "var(--text-muted)",
};

// None of the four below is a component, so the language and the translator
// arrive as arguments (ruling 18). The relative readings come from
// shared/i18n/time.ts; only the words for the cases Intl has no reading for
// are chosen here, from the catalog.
function timeAgo(
  language: SupportedLanguageCode,
  t: Translator["t"],
  ts: number | null,
): string {
  if (!ts) return " - ";
  const since = timeSince(language, ts);
  return since.kind === "now" ? t("common.justNow") : since.text;
}

// A duration Intl has no reading for. It is a code fragment, not words, so it
// is passed INTO the catalog sentence rather than written in it: a catalog
// value never carries a stray angle bracket (ruling 19).
const UNDER_A_MINUTE = "<1m";

function timeUntil(
  language: SupportedLanguageCode,
  t: Translator["t"],
  ts: number,
): string {
  const left = timeUntilFine(language, ts);
  if (left.kind === "expired") return t("schedules.anyMoment");
  if (left.kind === "underHour")
    return t("schedules.nextRunIn", { duration: UNDER_A_MINUTE });
  return left.text;
}

// h, m and s are symbols and stay as they are (ruling 11); only the word for a
// run that has not finished is a word.
function formatDuration(
  t: Translator["t"],
  start: number,
  end: number | null,
): string {
  if (!end) return t("schedules.running");
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// Today's runs show the clock alone; older ones carry the day in front of it.
function formatStartedAt(language: SupportedLanguageCode, ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = formatDateTime(language, ts, "clock");
  if (sameDay) return time;
  return `${formatDateTime(language, ts, "monthDay")} ${time}`;
}

export function CronjobsView({
  onClose,
  onFocusAgent,
}: {
  onClose: () => void;
  onFocusAgent?: (agentId: string) => void;
}) {
  const {
    cronjobs,
    cronjobsLoaded,
    cronjobRunsByJob,
    cronjobRunsLoaded,
    cronjobsStateSeq,
    isMobile,
    rooms,
    allRooms,
    currentRoomId,
    lobbyOpen,
    sessionContext,
    webhooks,
  } = useAppState();
  const { t } = useI18n();
  const dispatch = useDispatch();
  const [tab, setTab] = useState<Tab>("cronjobs");
  // The open hook on the Webhooks tab, and a delivery row to point at when a
  // webhook run's link opened it.
  const [openHook, setOpenHook] = useState<{
    id: string;
    deliveryId: string | null;
    seq: number;
  } | null>(null);
  const focusSeqRef = useRef(0);
  // null: closed; {}: a new hook; {webhook}: an edit.
  const [webhookDialog, setWebhookDialog] = useState<{
    webhook?: WebhookWire;
  } | null>(null);
  // An edit closes when the viewer no longer sees the hook.
  const webhookDialogLive =
    webhookDialog !== null &&
    (webhookDialog.webhook === undefined ||
      webhooks.some((w) => w.id === webhookDialog.webhook!.id));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CronjobListWire | null>(null);
  const roomOptions = roomFilterOptions(rooms, allRooms);
  const [storedRoomFilter, setStoredRoomFilter] = useState(() =>
    getRoomFilter("schedules"),
  );
  const roomFilter = effectiveRoomFilter(storedRoomFilter, roomOptions);
  const changeRoomFilter = (value: string) => {
    setStoredRoomFilter(value);
    setRoomFilter("schedules", value);
  };
  // A job's room, as this viewer can name it: a closed room reads as no room.
  const jobRoomId = (job: CronjobListWire) =>
    knownRoomId(job.roomId, roomOptions);
  const shownCronjobs = cronjobs.filter((job) =>
    roomFilterMatches(roomFilter, jobRoomId(job)),
  );
  // A new schedule is filed where the page is filtered to, else the room the
  // office shows, else no room.
  const createRoomId =
    roomFilter !== ROOM_FILTER_ALL && roomFilter !== ROOM_FILTER_NONE
      ? roomFilter
      : roomFilter === ROOM_FILTER_ALL &&
          !lobbyOpen &&
          currentRoomId &&
          roomOptions.some((room) => room.id === currentRoomId)
        ? currentRoomId
        : "";
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [runFilter, setRunFilter] = useState<{
    jobId: string;
    jobName: string;
  } | null>(null);
  const [openRun, setOpenRun] = useState<{
    jobId: string;
    runId: string;
  } | null>(null);

  // Request runs from every cronjob dir on disk (including deleted ones), so
  // historical runs from deleted cronjobs still appear in the Runs tab.
  // Fires on first mount and whenever the live cronjob list changes (e.g. a
  // new cronjob was just created - its runs.json will appear on disk on first
  // fire and we'd want to pick it up on the next refresh). The fetch SEEDS the
  // store (per-job merge, so a job absent from disk keeps its stale entry, as
  // before); live cronjob_run_updated events keep cronjobRunsByJob fresh after.
  useEffect(() => {
    apiFetch<{ jobs: { cronjobId: string; runs: CronjobRun[] }[] }>(
      "GET",
      "/api/cron-runs",
    )
      .then(({ jobs }) =>
        dispatch({ type: "cronjob_runs_loaded", jobs, seq: cronjobsStateSeq }),
      )
      .catch(() => {
        // Transport error: leave the table as-is (matches the old no-reply
        // behavior - a dropped runs stream never cleared the table).
      });
  }, [cronjobs.length, cronjobsStateSeq, dispatch]);

  // Re-request runs for a specific job when the user pins a filter to it,
  // so the table is current even if a previous update was missed.
  useEffect(() => {
    if (!runFilter) return;
    apiFetch<{ runs: CronjobRun[] }>(
      "GET",
      `/api/cronjobs/${encodeURIComponent(runFilter.jobId)}/runs`,
    )
      .then(({ runs }) =>
        dispatch({
          type: "cronjob_runs",
          cronjobId: runFilter.jobId,
          runs,
          seq: cronjobsStateSeq,
        }),
      )
      .catch(() => {});
    // Depend only on the id; full runFilter object identity churns per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runFilter?.jobId, cronjobsStateSeq]);

  // Who may still read a job's runs, from what the server last sent: anyone
  // it sends the job to; a deleted job's runs are office owners' only. The run
  // view, the edit dialog and the run filter close the moment that ends (room
  // change, deletion), so no local copy of a prompt, cwd or transcript
  // outlives the access.
  const isOfficeOwner = sessionContext?.role === "owner";
  const runsReadable = (jobId: string) =>
    cronjobs.some((c) => c.id === jobId) || isOfficeOwner;
  const editable = (jobId: string) =>
    cronjobs.find((c) => c.id === jobId)?.canManage === true;
  const openRunReadable = openRun !== null && runsReadable(openRun.jobId);
  const editingAllowed = editing !== null && editable(editing.id);
  const runFilterReadable = runFilter !== null && runsReadable(runFilter.jobId);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (openRun && !openRunReadable) setOpenRun(null);
    if (editing && !editingAllowed) setEditing(null);
    if (runFilter && !runFilterReadable) setRunFilter(null);
    if (webhookDialog && !webhookDialogLive) setWebhookDialog(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    webhookDialog,
    webhookDialogLive,
    openRun,
    openRunReadable,
    editing,
    editingAllowed,
    runFilter,
    runFilterReadable,
  ]);

  const allRuns: CronjobRun[] = useMemo(() => {
    const all: CronjobRun[] = [];
    for (const runs of cronjobRunsByJob.values()) all.push(...runs);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }, [cronjobRunsByJob]);

  const filteredRuns = useMemo(() => {
    if (runFilter)
      return allRuns.filter((r) => r.cronjobId === runFilter.jobId);
    if (roomFilter === ROOM_FILTER_ALL) return allRuns;
    // A run of a deleted job has no room.
    const roomByJob = new Map(
      cronjobs.map((job) => [job.id, knownRoomId(job.roomId, roomOptions)]),
    );
    return allRuns.filter((r) =>
      roomFilterMatches(roomFilter, roomByJob.get(r.cronjobId) ?? null),
    );
  }, [allRuns, runFilter, roomFilter, cronjobs, roomOptions]);

  // ESC closes (handled at App level by goHome → popstate; local Escape just dismisses our overlays)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (openRun) {
          e.stopPropagation();
          setOpenRun(null);
          return;
        }
        // The webhook dialog handles its own Escape (with its discard check).
        if (webhookDialog) return;
        if (editing || creating || editingPrompt) {
          e.stopPropagation();
          setEditing(null);
          setCreating(false);
          setEditingPrompt(false);
          return;
        }
        if (tab === "webhooks" && openHook) {
          e.stopPropagation();
          setOpenHook(null);
          return;
        }
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [openRun, editing, creating, editingPrompt, webhookDialog, tab, openHook]);

  return (
    <div
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* Header. Use minHeight (not height) so the safe-area-inset-top
          padding extends the bar below the camera notch instead of being
          squashed into the 44px box (box-sizing: border-box is global). */}
      <div
        data-automations-header=""
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          <div
            style={{
              display: "flex",
              border: "1px solid var(--border)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {TABS.map((name) => (
              <button
                key={name}
                onClick={() => setTab(name)}
                data-schedules-tab={name}
                style={{
                  padding: "5px 12px",
                  border: "none",
                  background:
                    tab === name ? "var(--accent-text)" : "transparent",
                  color: tab === name ? "var(--bg-base)" : "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {t(TAB_LABEL[name])}
              </button>
            ))}
          </div>
          <RoomFilterSelect
            value={roomFilter}
            rooms={roomOptions}
            onChange={changeRoomFilter}
          />
        </div>
      </div>

      {/* The header above is the page's and never changes with the tab; a
          tab's own controls sit here, at the top of its content. */}
      {(tab === "cronjobs" || (tab === "webhooks" && !openHook)) && (
        <div
          data-schedules-toolbar={tab}
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 6,
            padding: isMobile ? "8px 12px" : "8px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            flexShrink: 0,
          }}
        >
          {tab === "cronjobs" && (
            <button
              onClick={() => setEditingPrompt(true)}
              data-schedules-settings=""
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-dim)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {t("common.settings")}
            </button>
          )}
          <button
            onClick={() =>
              tab === "webhooks" ? setWebhookDialog({}) : setCreating(true)
            }
            data-schedules-new=""
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              // As tall as Settings, so the row keeps its height across tabs.
              border: "1px solid transparent",
              background: "var(--accent-text)",
              color: "var(--bg-base)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {tab === "webhooks"
              ? t("webhooks.newButton")
              : t("schedules.newButton")}
          </button>
        </div>
      )}

      {/* Filter chip */}
      {tab === "runs" && runFilter && (
        <div
          style={{
            padding: "8px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("schedules.filterLabel")}
          </span>
          <button
            onClick={() => setRunFilter(null)}
            style={{
              padding: "3px 8px 3px 10px",
              borderRadius: 12,
              border: "1px solid var(--accent)",
              background: "var(--accent-muted, rgba(88,166,255,0.15))",
              color: "var(--accent-text)",
              fontSize: 11,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {runFilter.jobName}
            <span style={{ fontSize: 13, opacity: 0.7 }}>×</span>
          </button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {tab === "webhooks" ? (
          <WebhooksView
            openHookId={openHook?.id ?? null}
            focusDeliveryId={openHook?.deliveryId ?? null}
            focusSeq={openHook?.seq ?? 0}
            onOpenHook={(id) => setOpenHook({ id, deliveryId: null, seq: 0 })}
            onCloseHook={() => setOpenHook(null)}
            onEdit={(webhook) => setWebhookDialog({ webhook })}
            onOpenRun={(jobId, runId) => setOpenRun({ jobId, runId })}
            onFocusAgent={onFocusAgent}
            roomFilter={roomFilter}
            roomOptions={roomOptions}
          />
        ) : tab === "cronjobs" ? (
          <CronjobsTable
            cronjobs={shownCronjobs}
            filtered={shownCronjobs.length < cronjobs.length}
            loaded={cronjobsLoaded}
            runsByJob={cronjobRunsByJob}
            isMobile={isMobile}
            onRowClick={(c) => {
              setRunFilter({ jobId: c.id, jobName: c.name });
              setTab("runs");
            }}
            onEdit={(c) => setEditing(c)}
            onToggleEnabled={(c) => {
              const body: CronUpdateReq = { enabled: !c.enabled };
              apiFetch(
                "PATCH",
                `/api/cronjobs/${encodeURIComponent(c.id)}`,
                body,
              ).catch(() => {});
            }}
            onRunNow={(c) => {
              apiFetch(
                "POST",
                `/api/cronjobs/${encodeURIComponent(c.id)}/runs`,
              ).catch(() => {});
            }}
          />
        ) : (
          <RunsTable
            runs={filteredRuns}
            loaded={cronjobRunsLoaded}
            liveCronjobIds={new Set(cronjobs.map((c) => c.id))}
            isMobile={isMobile}
            onRowClick={(r) => setOpenRun({ jobId: r.cronjobId, runId: r.id })}
          />
        )}
      </div>

      {creating && (
        <CronjobDialog
          defaultRoomId={createRoomId}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && editingAllowed && (
        <CronjobDialog cronjob={editing} onClose={() => setEditing(null)} />
      )}
      {webhookDialog && webhookDialogLive && (
        <WebhookDialog
          webhook={webhookDialog.webhook}
          onClose={() => setWebhookDialog(null)}
          onDeleted={() => setOpenHook(null)}
        />
      )}
      {editingPrompt && (
        <CronjobsPromptDialog onClose={() => setEditingPrompt(false)} />
      )}
      {openRun && openRunReadable && (
        <CronjobRunView
          jobId={openRun.jobId}
          runId={openRun.runId}
          onClose={() => setOpenRun(null)}
          onOpenWebhook={(webhookId, deliveryRowId) => {
            setOpenRun(null);
            setTab("webhooks");
            setOpenHook({
              id: webhookId,
              deliveryId: deliveryRowId,
              seq: ++focusSeqRef.current,
            });
          }}
        />
      )}
    </div>
  );
}

function CronjobsTable({
  cronjobs,
  filtered,
  loaded,
  runsByJob,
  isMobile,
  onRowClick,
  onEdit,
  onToggleEnabled,
  onRunNow,
}: {
  cronjobs: CronjobListWire[];
  filtered: boolean;
  loaded: boolean;
  runsByJob: Map<string, CronjobRun[]>;
  isMobile: boolean;
  onRowClick: (c: CronjobListWire) => void;
  onEdit: (c: CronjobListWire) => void;
  onToggleEnabled: (c: CronjobListWire) => void;
  onRunNow: (c: CronjobListWire) => void;
}) {
  const { t, language } = useI18n();
  // Brief visual ack after clicking Run. Cleared after 1.8s so subsequent
  // clicks always re-flash. The persistent in-flight badge (below) is the
  // longer-lived signal that something is actually executing.
  const [justStarted, setJustStarted] = useState<Set<string>>(new Set());
  function handleRunClick(c: CronjobListWire) {
    onRunNow(c);
    setJustStarted((prev) => new Set(prev).add(c.id));
    setTimeout(() => {
      setJustStarted((prev) => {
        const next = new Set(prev);
        next.delete(c.id);
        return next;
      });
    }, 1800);
  }
  const cellPad = isMobile ? "8px 6px" : "10px 12px";
  const thStyle: React.CSSProperties = {
    padding: cellPad,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-muted)",
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.05em",
    textAlign: "left",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border-subtle)",
  };

  if (cronjobs.length === 0) {
    return (
      <div
        style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}
      >
        {!loaded
          ? t("common.loadingDots")
          : filtered
            ? t("schedules.noMatch")
            : t("schedules.empty")}
      </div>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ ...thStyle, width: 30 }}></th>
          <th style={thStyle}>{t("schedules.col.name")}</th>
          {!isMobile && <th style={thStyle}>{t("schedules.col.schedule")}</th>}
          {!isMobile && <th style={thStyle}>{t("schedules.col.lastRun")}</th>}
          <th style={thStyle}>{t("schedules.col.nextRun")}</th>
          <th style={{ ...thStyle, width: 80 }}>{t("schedules.col.runs")}</th>
          {!isMobile && <th style={thStyle}>{t("schedules.col.by")}</th>}
          <th style={{ ...thStyle, width: 130 }}></th>
        </tr>
      </thead>
      <tbody>
        {cronjobs.map((c) => {
          const runs = runsByJob.get(c.id) ?? [];
          // Run, edit and pause are the maker's and office owners'.
          const managed = c.canManage ? c : null;
          return (
            <tr
              key={c.id}
              data-cronjob-row={c.id}
              onClick={() => onRowClick(c)}
              style={{
                cursor: "pointer",
                borderBottom: "1px solid var(--border-subtle)",
                color: c.enabled ? undefined : "var(--text-hint)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <td
                style={{ padding: cellPad }}
                onClick={
                  managed
                    ? (e) => {
                        e.stopPropagation();
                        onToggleEnabled(managed);
                      }
                    : undefined
                }
              >
                <span
                  title={
                    !managed
                      ? undefined
                      : c.enabled
                        ? t("schedules.enabledToggle")
                        : t("schedules.pausedToggle")
                  }
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: c.enabled
                      ? "var(--green)"
                      : "var(--text-muted)",
                    boxShadow: c.enabled ? "0 0 6px var(--green)" : "none",
                  }}
                />
              </td>
              <td style={{ padding: cellPad, fontSize: 13, fontWeight: 600 }}>
                {c.name}
                {(() => {
                  const inFlight = runs.filter(
                    (r) => r.status === "running",
                  ).length;
                  if (inFlight === 0) return null;
                  return (
                    <span
                      style={{
                        marginLeft: 8,
                        padding: "1px 7px",
                        borderRadius: 10,
                        background: "rgba(80,200,120,0.15)",
                        border: "1px solid var(--green)",
                        color: "var(--green-text)",
                        fontSize: 10,
                        fontWeight: 600,
                        fontFamily: "'JetBrains Mono',monospace",
                        verticalAlign: "middle",
                      }}
                    >
                      <StatusShape kind="dot" /> {t("schedules.inFlight")}
                      {inFlight > 1 ? ` ×${inFlight}` : ""}
                    </span>
                  );
                })()}
              </td>
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  {scheduleText(language, t, c.schedule)}
                </td>
              )}
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                  data-last-run={c.id}
                >
                  {timeAgo(language, t, lastRunAt(c, runs))}
                </td>
              )}
              <td
                style={{
                  padding: cellPad,
                  fontSize: 11,
                  color: c.enabled
                    ? "var(--text-secondary)"
                    : "var(--text-ghost)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {!c.enabled
                  ? t("schedules.paused")
                  : c.nextFireAt === null
                    ? "-"
                    : timeUntil(language, t, c.nextFireAt)}
              </td>
              <td
                style={{
                  padding: cellPad,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono',monospace",
                }}
              >
                {runs.length}
              </td>
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  {c.username && c.username !== c.createdBy
                    ? t("schedules.createdByFor", {
                        creator: c.createdBy,
                        user: c.username,
                      })
                    : c.createdBy}
                </td>
              )}
              <td
                style={{
                  padding: cellPad,
                  whiteSpace: "nowrap",
                  textAlign: "right",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {managed && (
                  <div
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      flexWrap: "nowrap",
                    }}
                  >
                    <button
                      onClick={() => handleRunClick(managed)}
                      title={t("schedules.runNow")}
                      style={{
                        padding: "3px 10px",
                        borderRadius: 4,
                        border: `1px solid ${justStarted.has(c.id) ? "var(--green)" : "var(--border)"}`,
                        background: justStarted.has(c.id)
                          ? "rgba(80,200,120,0.15)"
                          : "transparent",
                        color: justStarted.has(c.id)
                          ? "var(--green-text)"
                          : "var(--text-dim)",
                        fontSize: 11,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        transition:
                          "background 0.2s, color 0.2s, border-color 0.2s",
                      }}
                    >
                      {t("schedules.run")}
                    </button>
                    <button
                      onClick={() => onEdit(managed)}
                      title={t("common.edit")}
                      style={{
                        padding: "3px 10px",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "transparent",
                        color: "var(--text-dim)",
                        fontSize: 11,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("common.edit")}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RunsTable({
  runs,
  loaded,
  liveCronjobIds,
  isMobile,
  onRowClick,
}: {
  runs: CronjobRun[];
  loaded: boolean;
  liveCronjobIds: Set<string>;
  isMobile: boolean;
  onRowClick: (r: CronjobRun) => void;
}) {
  const { t, language } = useI18n();
  const cellPad = isMobile ? "8px 6px" : "10px 12px";
  const thStyle: React.CSSProperties = {
    padding: cellPad,
    fontSize: 10,
    fontWeight: 700,
    color: "var(--text-muted)",
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.05em",
    textAlign: "left",
    whiteSpace: "nowrap",
    borderBottom: "1px solid var(--border-subtle)",
  };
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(0);
  }, [runs.length]);
  const pageStart = page * PAGE_SIZE;
  const pageRuns = runs.slice(pageStart, pageStart + PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));

  if (runs.length === 0) {
    return (
      <div
        style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}
      >
        {loaded ? t("schedules.runsEmpty") : t("common.loadingDots")}
      </div>
    );
  }

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 30 }}>
              {t("schedules.col.status")}
            </th>
            <th style={{ ...thStyle, width: 30 }}>
              {t("schedules.col.trigger")}
            </th>
            <th style={thStyle}>{t("schedules.col.schedule")}</th>
            <th style={thStyle}>{t("schedules.col.started")}</th>
            <th style={thStyle}>{t("schedules.col.preview")}</th>
            {!isMobile && (
              <th style={{ ...thStyle, width: 80 }}>
                {t("schedules.col.duration")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {pageRuns.map((r) => (
            <tr
              key={r.id}
              data-cronjob-run-row={r.id}
              onClick={() => onRowClick(r)}
              style={{
                cursor: "pointer",
                borderBottom: "1px solid var(--border-subtle)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "var(--bg-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              <td
                style={{
                  padding: cellPad,
                  color: STATUS_COLOR[r.status],
                  fontSize: 14,
                  textAlign: "center",
                }}
                title={r.status}
              >
                {STATUS_ICON[r.status]}
              </td>
              <td
                style={{
                  padding: cellPad,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  textAlign: "center",
                }}
                title={
                  r.trigger === "webhook" && r.webhook
                    ? t("schedules.trigger.webhookBy", {
                        name: r.webhook.webhookName,
                      })
                    : r.trigger
                }
                data-run-trigger={r.trigger}
              >
                {r.trigger === "manual" ? (
                  <StatusShape kind="triangle" />
                ) : r.trigger === "webhook" ? (
                  <StatusShape kind="hook" />
                ) : (
                  <StatusShape kind="clock" />
                )}
              </td>
              <td style={{ padding: cellPad, fontSize: 12, fontWeight: 600 }}>
                {r.cronjobName}
                {!liveCronjobIds.has(r.cronjobId) && (
                  <span
                    style={{
                      marginLeft: 6,
                      color: "var(--text-ghost)",
                      fontWeight: 400,
                      fontStyle: "italic",
                      fontSize: 11,
                    }}
                  >
                    {t("schedules.deleted")}
                  </span>
                )}
              </td>
              <td
                style={{
                  padding: cellPad,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "'JetBrains Mono',monospace",
                  whiteSpace: "nowrap",
                }}
              >
                {formatStartedAt(language, r.startedAt)}
              </td>
              <td
                style={{
                  padding: cellPad,
                  fontSize: 11,
                  color: r.errorReason
                    ? "var(--red-text)"
                    : "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 0,
                }}
              >
                {r.errorReason || r.previewText || " - "}
              </td>
              {!isMobile && (
                <td
                  style={{
                    padding: cellPad,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  {formatDuration(t, r.startedAt, r.endedAt)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 12,
            padding: "12px 0",
          }}
        >
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={pagerBtn(page === 0)}
          >
            {t("schedules.prevPage")}
          </button>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={pagerBtn(page >= totalPages - 1)}
          >
            {t("schedules.nextPage")}
          </button>
        </div>
      )}
    </>
  );
}

function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-ghost)" : "var(--text-dim)",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
  };
}
