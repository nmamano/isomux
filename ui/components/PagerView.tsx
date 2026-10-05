// The pager view (internal-docs/pager-design.md, "Pager view"): every page the
// member can see, open pages first, with ack and resolve. The list is the
// store's pager slice, which usePagerSync (ui/pager-sync.ts) keeps filled.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
import { apiFetch } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { timeSince } from "../../shared/i18n/time.ts";
import type { Translator } from "../../shared/i18n/translate.ts";
import type { SupportedLanguageCode } from "../../shared/languages.ts";
import {
  ordinaryRooms,
  type AppListWire,
  type PagerEntry,
  type PagerState,
} from "../../shared/types.ts";
import { comparePagerEntries } from "../pager-sync.ts";
import { PAGER_FAILURE_KEYS } from "./PagerSettingsPane.tsx";
import { StatusShape } from "./StatusShape.tsx";
import { appLinkHref } from "./AppsView.tsx";

/** The deep link's page, from `<origin>/?pager=<id>`. */
export interface PagerSelectRequest {
  id: string;
}

type StateFilter = "active" | PagerState | "all";
// "all", "none" (app pages with no room), or a room id.
type RoomFilter = string;

const STATE_COLOR: Record<PagerState, string> = {
  open: "var(--red-text)",
  acked: "var(--orange-text)",
  resolved: "var(--green-text)",
};

const STATE_KEY = {
  open: "pager.state.open",
  acked: "pager.state.acked",
  resolved: "pager.state.resolved",
} as const;

function StateMark({ state }: { state: PagerState }) {
  // SVG or CSS shapes only: iOS draws dingbats as emoji (ui/agent-face.ts).
  return (
    <StatusShape
      kind={state === "open" ? "dot" : state === "acked" ? "triangle" : "check"}
    />
  );
}

function timeAgo(
  language: SupportedLanguageCode,
  t: Translator["t"],
  ts: number,
): string {
  const since = timeSince(language, ts);
  return since.kind === "now" ? t("common.justNow") : since.text;
}

function deliveryText(t: Translator["t"], entry: PagerEntry): string {
  const d = entry.delivery;
  if (d.state === "delivered") return t("pager.delivery.sent");
  if (!d.lastFailure) return t("pager.delivery.pending");
  const reason = t(PAGER_FAILURE_KEYS[d.lastFailure]);
  return d.state === "failed"
    ? t("pager.delivery.failed", { reason })
    : t("pager.delivery.notSent", { reason });
}

function matchesState(filter: StateFilter, state: PagerState): boolean {
  if (filter === "all") return true;
  if (filter === "active") return state !== "resolved";
  return state === filter;
}

/**
 * A best-effort guess at the app that raised a page, for a link. The wire
 * carries no registration generation, so this matches the name and takes only
 * an app created no later than the page: a replacement under the same name is
 * normally registered after the raise. Equal timestamps or a clock correction
 * can defeat that, so it is a convenience link, never an identity check.
 */
export function sourceApp(
  entry: PagerEntry,
  apps: readonly AppListWire[],
): AppListWire | null {
  const source = entry.source;
  if (source.kind !== "app") return null;
  return (
    apps.find(
      // An app with no createdAt compares false and stays text.
      (a) => a.name === source.appName && a.createdAt <= entry.createdAt,
    ) ?? null
  );
}

export function PagerView({
  onClose,
  onFocusAgent,
  selectRequest,
  onSelectRequestHandled,
}: {
  onClose: () => void;
  onFocusAgent?: (agentId: string) => void;
  selectRequest?: PagerSelectRequest | null;
  onSelectRequestHandled?: () => void;
}) {
  const {
    pager,
    pagerLoaded,
    pagerLoadFailed,
    agents,
    apps,
    appsRevision,
    hydrationEpoch,
    rooms: allRooms,
    isMobile,
  } = useAppState();
  const features = useFeatures();
  const dispatch = useDispatch();
  const { t, tn, language } = useI18n();
  const rooms = useMemo(() => ordinaryRooms(allRooms), [allRooms]);
  const [stateFilter, setStateFilter] = useState<StateFilter>("active");
  const [roomFilter, setRoomFilter] = useState<RoomFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The deep link named a page this member cannot see, or one that is gone.
  const [unavailable, setUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const scrollToRef = useRef<string | null>(null);

  // The store holds apps only after the Apps view has fetched them. This view
  // reads them on mount and on every hydration (a reconnect may have missed an
  // app's replacement), so an app page links to its app. A response from an
  // earlier run is dropped; a snapshot a delta overtook is refused by the
  // reducer and read again, since nothing here polls.
  const appsRevisionRef = useRef(appsRevision);
  useEffect(() => {
    appsRevisionRef.current = appsRevision;
  }, [appsRevision]);
  const [appsReadSeq, setAppsReadSeq] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const revision = appsRevisionRef.current;
    apiFetch<AppListWire[]>("GET", "/api/apps").then(
      (list) => {
        if (cancelled) return;
        dispatch({ type: "apps_loaded", apps: list, revision });
        if (revision !== appsRevisionRef.current) setAppsReadSeq((n) => n + 1);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch, hydrationEpoch, appsReadSeq]);

  // The deep link: wait for the first snapshot, then show the page whatever
  // its state, or say it is not available. A failed load keeps the request
  // until Retry lands a snapshot.
  useEffect(() => {
    if (!selectRequest || !pagerLoaded) return;
    onSelectRequestHandled?.();
    const entry = pager.find((e) => e.id === selectRequest.id);
    // An external navigation request reconfigures this view.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!entry) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    setStateFilter("all");
    setRoomFilter("all");
    setExpandedId(entry.id);
    /* eslint-enable react-hooks/set-state-in-effect */
    scrollToRef.current = entry.id;
  }, [selectRequest, pagerLoaded, pager, onSelectRequestHandled]);

  useEffect(() => {
    const id = scrollToRef.current;
    if (!id || expandedId !== id) return;
    scrollToRef.current = null;
    const row = [
      ...document.querySelectorAll<HTMLElement>("[data-pager-id]"),
    ].find((el) => el.dataset.pagerId === id);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [expandedId]);

  const roomNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rooms) m.set(r.id, r.name);
    return m;
  }, [rooms]);

  const shown = useMemo(
    () =>
      pager
        .filter(
          (e) =>
            matchesState(stateFilter, e.state) &&
            (roomFilter === "all" ||
              (roomFilter === "none"
                ? e.source.roomId === null
                : e.source.roomId === roomFilter)),
        )
        .sort(comparePagerEntries),
    [pager, stateFilter, roomFilter],
  );

  async function act(entry: PagerEntry, verb: "ack" | "resolve") {
    setBusyId(entry.id);
    setFailedId(null);
    try {
      const updated = await apiFetch<PagerEntry>(
        "POST",
        `/api/pager/${encodeURIComponent(entry.id)}/${verb}`,
      );
      // The same record also arrives as pager_upserted; applying it here
      // keeps this tab current if that event is late.
      dispatch({ type: "pager_upserted", entry: updated });
    } catch {
      setFailedId(entry.id);
    } finally {
      setBusyId(null);
    }
  }

  function renderSource(entry: PagerEntry) {
    const linkStyle: React.CSSProperties = {
      background: "none",
      border: "none",
      padding: 0,
      font: "inherit",
      color: "var(--accent-text)",
      cursor: "pointer",
      textDecoration: "none",
    };
    if (entry.source.kind === "agent") {
      const agentId = entry.source.agentId;
      const name = entry.source.name;
      if (onFocusAgent && agents.some((a) => a.id === agentId)) {
        return (
          <button
            type="button"
            {...noTranslate()}
            className="pager-source-link"
            title={t("pager.view.openChat", { name })}
            onClick={() => onFocusAgent(agentId)}
            style={linkStyle}
          >
            {name}
          </button>
        );
      }
      return <span {...noTranslate()}>{name}</span>;
    }
    const label = t("pager.view.appSource", { name: entry.source.name });
    const app = sourceApp(entry, apps);
    if (!app) return <span {...noTranslate()}>{label}</span>;
    return (
      <a
        {...noTranslate()}
        className="pager-source-link"
        href={appLinkHref(
          app,
          window.location.hostname,
          features.liveAppPreviews,
        )}
        target="_blank"
        rel="noreferrer"
        title={t("pager.view.openApp", { name: app.name })}
        style={linkStyle}
      >
        {label}
      </a>
    );
  }

  function roomText(entry: PagerEntry): string {
    const roomId = entry.source.roomId;
    if (roomId === null) return t("pager.view.noRoom");
    return roomNameById.get(roomId) ?? t("tasks.unknownRoom");
  }

  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text-primary)",
    fontSize: 12,
    outline: "none",
    flex: isMobile ? 1 : undefined,
    minWidth: 0,
  };

  const actionBtn = (primary: boolean): React.CSSProperties => ({
    padding: "6px 12px",
    borderRadius: 6,
    border: `1px solid ${primary ? "var(--accent)" : "var(--border-medium)"}`,
    background: primary ? "var(--accent)" : "var(--btn-surface)",
    color: primary ? "#fff" : "var(--text-primary)",
    fontSize: 12,
    cursor: "pointer",
  });

  const hasNoRoomPage = pager.some((e) => e.source.roomId === null);

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
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "4px 12px" : "0 20px",
          paddingTop: isMobile
            ? "max(4px, env(safe-area-inset-top, 0px))"
            : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
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
          style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}
        >
          {t("common.pager")}
        </span>
        {pagerLoaded && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {t("pager.view.shown", { count: shown.length })}
          </span>
        )}
      </div>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: isMobile ? "10px 12px" : "10px 20px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <select
          aria-label={t("pager.view.stateFilter")}
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          style={selectStyle}
        >
          <option value="active">{t("pager.view.filterActive")}</option>
          <option value="open">{t("pager.state.open")}</option>
          <option value="acked">{t("pager.state.acked")}</option>
          <option value="resolved">{t("pager.state.resolved")}</option>
          <option value="all">{t("pager.view.filterAll")}</option>
        </select>
        <select
          aria-label={t("pager.view.roomFilter")}
          value={roomFilter}
          onChange={(e) => setRoomFilter(e.target.value)}
          style={selectStyle}
        >
          <option value="all">{t("pager.view.allRooms")}</option>
          {rooms.map((r) => (
            <option key={r.id} {...noTranslate()} value={r.id}>
              {r.name}
            </option>
          ))}
          {hasNoRoomPage && (
            <option value="none">{t("pager.view.noRoom")}</option>
          )}
        </select>
      </div>

      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: isMobile ? "10px 12px" : "12px 20px",
        }}
      >
        {pagerLoadFailed && (
          <div
            role="alert"
            className="pager-load-failed"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              marginBottom: 10,
              borderRadius: 8,
              background: "var(--red-bg)",
              color: "var(--red-text)",
              fontSize: 13,
            }}
          >
            <span style={{ flex: 1 }}>{t("pager.view.loadFailed")}</span>
            <button
              type="button"
              onClick={() => dispatch({ type: "pager_refetch" })}
              style={actionBtn(false)}
            >
              {t("pager.view.retry")}
            </button>
          </div>
        )}
        {unavailable && (
          <div
            role="status"
            className="pager-unavailable"
            style={{
              padding: "10px 12px",
              marginBottom: 10,
              borderRadius: 8,
              background: "var(--orange-bg)",
              color: "var(--orange-text)",
              fontSize: 13,
            }}
          >
            {t("pager.view.unavailable")}
          </div>
        )}
        {!pagerLoaded ? (
          pagerLoadFailed ? null : (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {t("common.loadingDots")}
            </div>
          )
        ) : shown.length === 0 ? (
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: 13,
              textAlign: "center",
              padding: "24px 0",
            }}
          >
            {t("pager.view.empty")}
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {shown.map((entry) => {
              const expanded = expandedId === entry.id;
              const busy = busyId === entry.id;
              const detailsId = `pager-details-${entry.id}`;
              return (
                <li
                  key={entry.id}
                  data-pager-id={entry.id}
                  style={{
                    border: `1px solid ${expanded ? "var(--border-medium)" : "var(--border-subtle)"}`,
                    borderRadius: 8,
                    background: "var(--bg-surface)",
                    padding: "10px 12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                    }}
                  >
                    <button
                      type="button"
                      className="pager-row-toggle"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "baseline",
                        gap: 8,
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        color: "var(--text-primary)",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        className="pager-state"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          flexShrink: 0,
                          fontSize: 11,
                          fontWeight: 600,
                          color: STATE_COLOR[entry.state],
                        }}
                      >
                        <StateMark state={entry.state} />
                        {t(STATE_KEY[entry.state])}
                      </span>
                      <span
                        {...noTranslate()}
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {entry.title}
                      </span>
                    </button>
                    <span
                      title={new Date(entry.lastRaisedAt).toLocaleString(
                        language,
                      )}
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {timeAgo(language, t, entry.lastRaisedAt)}
                    </span>
                  </div>
                  <div
                    className="pager-meta"
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2px 12px",
                      marginTop: 6,
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    {renderSource(entry)}
                    <span {...noTranslate()}>{roomText(entry)}</span>
                    <span className="pager-raised">
                      {tn("pager.view.raised", entry.raiseCount)}
                    </span>
                    <span
                      className="pager-delivery"
                      style={{
                        color:
                          entry.delivery.state === "delivered"
                            ? undefined
                            : "var(--orange-text)",
                      }}
                    >
                      {deliveryText(t, entry)}
                    </span>
                  </div>
                  {expanded && (
                    <div id={detailsId} style={{ marginTop: 10 }}>
                      {entry.body && (
                        <div
                          {...noTranslate()}
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            fontSize: 13,
                            marginBottom: 8,
                          }}
                        >
                          {entry.body}
                        </div>
                      )}
                      {entry.acked && (
                        <div
                          style={{ fontSize: 12, color: "var(--text-muted)" }}
                        >
                          {t("pager.view.ackedBy", {
                            name: entry.acked.by,
                            age: timeAgo(language, t, entry.acked.at),
                          })}
                        </div>
                      )}
                      {entry.resolved && (
                        <div
                          style={{ fontSize: 12, color: "var(--text-muted)" }}
                        >
                          {t("pager.view.resolvedBy", {
                            name: entry.resolved.by,
                            age: timeAgo(language, t, entry.resolved.at),
                          })}
                        </div>
                      )}
                      {entry.state !== "resolved" && (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginTop: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          {entry.state === "open" && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void act(entry, "ack")}
                              style={actionBtn(true)}
                            >
                              {t("pager.action.ack")}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void act(entry, "resolve")}
                            style={actionBtn(entry.state !== "open")}
                          >
                            {t("pager.action.resolve")}
                          </button>
                        </div>
                      )}
                      {failedId === entry.id && (
                        <div
                          role="alert"
                          style={{
                            marginTop: 8,
                            fontSize: 12,
                            color: "var(--red-text)",
                          }}
                        >
                          {t("pager.action.failed")}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
