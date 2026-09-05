// Shared building blocks for the account panes on the Settings page
// (ExternalAccessPane / InvitesPane / SessionsPane for owners, MyDevicesPane
// for members): the invites + sessions tables, the minted-URL box with its
// clipboard fallbacks, list-section rendering, relative-time formatting, and
// the common styles. These came from the former all-in-one AccessPane.
//
// Everything here reads the catalog (internal-docs/i18n-loop.md): the
// components take the translator from the context themselves, and the pure
// helpers - which are called during a render but are not components, so a hook
// inside them would be a rules-of-hooks violation - take it as their first
// argument. Times are formatted by shared/i18n/time.ts; the only word around
// them that is not Intl's comes from the catalog.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, SessionWire } from "../../shared/types.ts";
import type { Translator } from "../../shared/i18n/translate.ts";
import { absoluteTime, timeSince, timeUntil } from "../../shared/i18n/time.ts";
import { useI18n } from "../i18n.tsx";
import { dialogLabel, dialogHint } from "./dialog-styles.ts";

// Lazily seed the invites + active-sessions lists via GET. The
// session_context reducer resets both loaded flags on every WS open
// (including reconnects), so this effect re-runs and keeps the lists fresh
// across socket bounces. Mutations still arrive as recipient-scoped
// invites_list / sessions_active_list broadcasts; these GETs only seed the
// initial (and post-reconnect) snapshot. The server scopes both endpoints to
// the caller (owners: all rows; members: own rows only), so one hook serves
// every pane. Called once from UserSettingsView - the sidebar roster needs
// sessions even when no account pane is open.
export function useAccessListsSeed(): void {
  const { invitesLoaded, activeSessionsLoaded } = useAppState();
  const dispatch = useDispatch();
  useEffect(() => {
    if (!invitesLoaded) {
      apiFetch<{ invites: InviteWire[] }>("GET", "/api/invites")
        .then((r) => dispatch({ type: "invites_list", invites: r.invites }))
        .catch(() => {});
    }
    if (!activeSessionsLoaded) {
      apiFetch<{ sessions: SessionWire[] }>("GET", "/api/sessions")
        .then((r) =>
          dispatch({ type: "sessions_active_list", sessions: r.sessions }),
        )
        .catch(() => {});
    }
  }, [invitesLoaded, activeSessionsLoaded, dispatch]);
}

// Render the cached rows whenever any are present, even while a refresh is
// in flight - avoids a flicker to "Loading…" on every reconnect. Empty+not-
// loaded shows "Loading…" (first load only); empty+loaded shows "None.".
export function renderListSection<T>(
  i18n: Translator,
  rows: T[],
  loaded: boolean,
  renderTable: (rows: T[]) => React.ReactNode,
): React.ReactNode {
  if (rows.length > 0) return renderTable(rows);
  if (!loaded) return <p style={hint}>{i18n.t("common.loading")}</p>;
  return <p style={hint}>{i18n.t("settings.access.none")}</p>;
}

// Surfaces a freshly-minted invite URL with a working copy button and
// visible feedback. Falls back to a hidden-textarea + execCommand path
// when navigator.clipboard rejects (mobile, focus quirks, permissions);
// final fallback selects the URL so the user can copy manually.
export function MintedUrlBox({ url }: { url: string }) {
  const { t } = useI18n();
  const codeRef = useRef<HTMLElement | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyState, setCopyState] = useState<
    "idle" | "ok" | "fallback" | "fail"
  >("idle");

  // Clear any in-flight feedback timer if the component unmounts while a
  // success indicator is still flashing - avoids setState-after-unmount.
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  function flashFeedback(next: "ok" | "fallback") {
    setCopyState(next);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => {
      feedbackTimerRef.current = null;
      setCopyState("idle");
    }, 1500);
  }

  async function handleCopy() {
    // Path 1: modern clipboard API.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        flashFeedback("ok");
        return;
      }
    } catch {
      // fall through to legacy path
    }
    // Path 2: legacy textarea + execCommand (works in older Safari /
    // contexts where the modern API is blocked). The temporary textarea
    // is removed in `finally` so a thrown exception inside `select()` /
    // `execCommand()` can't leak an invisible DOM node into the page.
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    try {
      ta.select();
      const ok = document.execCommand("copy");
      if (ok) {
        flashFeedback("fallback");
        return;
      }
    } catch {
      // fall through to manual-select path
    } finally {
      document.body.removeChild(ta);
    }
    // Path 3: highlight the URL so the user can ctrl-c / long-press / copy.
    const node = codeRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setCopyState("fail");
  }

  return (
    <div style={mintedBox}>
      <div style={{ ...subLabel, marginTop: 0 }}>
        {t("settings.access.inviteUrl")}
      </div>
      <code ref={codeRef} style={codeStyle}>
        {url}
      </code>
      <button
        onClick={() => {
          void handleCopy();
        }}
        style={smallBtn}
        title={t("settings.access.copyUrl")}
      >
        {copyState === "ok" || copyState === "fallback"
          ? t("settings.access.urlCopied")
          : t("common.copy")}
      </button>
      {copyState === "fail" && (
        <p style={{ ...hint, color: "#ff6b6b", marginTop: 4 }}>
          {t("settings.access.clipboardBlocked")}
        </p>
      )}
      <p style={hint}>{t("settings.access.sendUrl")}</p>
    </div>
  );
}

export function InvitesTable({ invites }: { invites: InviteWire[] }) {
  const { rooms, allRooms } = useAppState();
  const i18n = useI18n();
  const { t } = i18n;
  // Resolve granted room ids to names for display. Owners have allRooms;
  // members (My devices pane) fall back to their projected rooms - their
  // self-invites never carry grants, so the fallback rarely matters. A
  // deleted room's id shows as-is rather than vanishing.
  const roomList = allRooms.length > 0 ? allRooms : rooms;
  const roomName = (id: string) =>
    roomList.find((r) => r.id === id)?.name ?? id;
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>{t("settings.invites.columnFor")}</th>
          <th style={th}>{t("common.role")}</th>
          <th style={th}>{t("common.rooms")}</th>
          <th style={th}>{t("settings.invites.columnExpires")}</th>
          <th style={th}>{t("common.prefix")}</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {invites.map((i) => (
          <tr key={i.tokenPrefix}>
            <td style={td}>
              {i.username ?? (
                <i>{i.bootstrap ? t("settings.invites.bootstrap") : " - "}</i>
              )}
            </td>
            <td style={td}>{i.role}</td>
            <td style={td}>
              {i.allowedRooms?.length ? (
                i.allowedRooms.map(roomName).join(", ")
              ) : (
                <i> - </i>
              )}
            </td>
            <td style={td}>{formatExpiry(i18n, i.expiresAt)}</td>
            <td style={mono}>{i.tokenPrefix}…</td>
            <td style={td}>
              <button
                onClick={() => {
                  apiFetch(
                    "DELETE",
                    `/api/invites/${encodeURIComponent(i.tokenPrefix)}`,
                  ).catch(() => {});
                }}
                style={smallBtn}
              >
                {t("common.revoke")}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SessionsTable({
  sessions,
  onBlocked,
}: {
  sessions: SessionWire[];
  onBlocked?: (reason: string) => void;
}) {
  const { sessionContext } = useAppState();
  const i18n = useI18n();
  const { t } = i18n;
  const currentPrefix = sessionContext?.currentSessionPrefix ?? null;
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>{t("common.user")}</th>
          <th style={th}>{t("common.device")}</th>
          <th style={th}>{t("settings.sessions.columnLastSeen")}</th>
          <th style={th}>{t("settings.sessions.columnCreated")}</th>
          {/* The HTTP header's own name, not prose (ruling 11). */}
          <th style={th}>User-Agent</th>
          <th style={th}>{t("common.prefix")}</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => {
          const isCurrent = s.sessionPrefix === currentPrefix;
          return (
            <Fragment key={s.sessionPrefix}>
              <tr>
                <td style={sessionPrimaryCell}>{s.username}</td>
                {/* Last-known device label, stamped server-side from the
                    session's presence stream. " - " until the
                    device names itself in Device Settings. */}
                <td style={sessionPrimaryCell}>{s.device ?? " - "}</td>
                <td style={sessionPrimaryCell}>
                  {formatSince(i18n, s.lastSeenAt)}
                </td>
                <td style={sessionPrimaryCell}>
                  {formatSince(i18n, s.createdAt)}
                </td>
                <td style={sessionPrimaryEllipsis}>{s.userAgent ?? " - "}</td>
                <td style={sessionPrimaryMono}>{s.sessionPrefix}…</td>
                <td style={sessionPrimaryCell}>
                  {isCurrent ? (
                    // Self-revoke can lock the office out if you're the last
                    // owner; the server enforces that, but we also hide the
                    // button on your own row so the choice never appears in
                    // the obvious place. Sign out (with its own lockout
                    // check) is the right exit for the current device.
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--text-ghost)",
                        fontStyle: "italic",
                      }}
                      title={t("settings.sessions.currentSessionHint")}
                    >
                      {t("settings.sessions.currentSession")}
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        apiFetch(
                          "DELETE",
                          `/api/sessions/${encodeURIComponent(s.sessionPrefix)}`,
                        ).catch((err) => {
                          if (err instanceof ApiError && err.status === 409) {
                            onBlocked?.(err.message);
                          }
                        });
                      }}
                      style={smallBtn}
                    >
                      {t("common.revoke")}
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <td colSpan={7} style={sessionExpiryCell}>
                  <div style={sessionExpiryStyle}>
                    {sessionExpiryLines(i18n, s).map((line) => (
                      <span key={line.label}>
                        {line.label}: {line.value}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// Dismissible red banner for server-side lockout-prevention rejections (a 409
// from sessions.revoke, surfaced by SessionsTable's onBlocked). Shared by the
// owner Sessions pane and the member My-devices pane.
export function BlockedNoteBanner({
  note,
  onDismiss,
}: {
  note: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        margin: "8px 0",
        padding: "8px 12px",
        border: "1px solid #ff6b6b",
        borderRadius: 6,
        background: "rgba(255,107,107,0.08)",
        fontSize: 12,
        color: "#ff6b6b",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <span style={{ flex: 1 }}>{note}</span>
      <button
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: "none",
          color: "#ff6b6b",
          cursor: "pointer",
          fontSize: 14,
          padding: 0,
        }}
        title={t("common.dismiss")}
      >
        ×
      </button>
    </div>
  );
}

// Auto-clear the blocked banner on any successful active-session change: the
// user fixed whatever the rejection was about (typically by minting an extra
// invite then retrying the revoke) - keeping the banner up after the list
// shrinks is noise.
export function useAutoClearBlockedNote(
  setBlockedNote: (v: string | null) => void,
): void {
  const { activeSessions } = useAppState();
  const prevSessionsLenRef = useRef<number>(activeSessions.length);
  useEffect(() => {
    const prev = prevSessionsLenRef.current;
    const curr = activeSessions.length;
    prevSessionsLenRef.current = curr;
    if (curr < prev) setBlockedNote(null);
  }, [activeSessions.length, setBlockedNote]);
}

// An age as the tables show it. Under a minute there is no number worth
// printing, so timeSince reports that case and the word comes from the catalog
// like every other word (ruling 17).
export function formatSince(i18n: Translator, ts: number): string {
  const since = timeSince(i18n.language, ts);
  return since.kind === "now" ? i18n.t("common.justNow") : since.text;
}

// A deadline as the Expires column shows it. Neither a deadline already past
// nor one under an hour off has a form worth taking from Intl, so timeUntil
// reports both cases and the words come from the catalog.
function formatExpiry(i18n: Translator, ts: number): string {
  const left = timeUntil(i18n.language, ts);
  if (left.kind === "expired") return i18n.t("settings.access.expired");
  if (left.kind === "underHour")
    return i18n.t("settings.access.expiresUnderHour");
  return left.text;
}

// The machine's own zone is the one thing Intl cannot say for us, so the
// catalog sentence carries that word around the formatted stamp.
function formatAbsoluteLocal(i18n: Translator, ts: number): string {
  return i18n.t("settings.access.localTime", {
    time: absoluteTime(i18n.language, ts),
  });
}

export function sessionExpiryLines(
  i18n: Translator,
  session: Pick<SessionWire, "expiresAt" | "absoluteExpiresAt">,
): { label: string; value: string }[] {
  return [
    {
      label: i18n.t("settings.sessions.expiryInactivity"),
      value: formatAbsoluteLocal(i18n, session.expiresAt),
    },
    {
      label: i18n.t("settings.sessions.expiryLatest"),
      value: formatAbsoluteLocal(i18n, session.absoluteExpiresAt),
    },
  ];
}

// Styles shared across the account panes.
export const sectionHeader: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  margin: "0 0 4px",
  color: "var(--text-primary)",
};
export const subsectionHeader: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  margin: "16px 0 6px",
  color: "var(--text-primary)",
};
export const subLabel: React.CSSProperties = { ...dialogLabel, marginTop: 8 };
export const hint: React.CSSProperties = dialogHint;

// A pointer from one settings section to another, inline in a sentence. It is
// a button (the page moves the detail pane itself, it is not a route), and
// plain bold text when the caller has no handler to give - so the sentence
// still reads wherever the pane is mounted without one.
export function SettingsLink({
  label,
  onGo,
}: {
  // A node, not a string: rich() hands this the chunk between a <link> pair,
  // so the whole sentence stays one catalog entry (ruling 16).
  label: ReactNode;
  onGo?: () => void;
}) {
  if (!onGo) return <strong>{label}</strong>;
  return (
    <button
      onClick={onGo}
      style={{
        font: "inherit",
        background: "none",
        border: "none",
        padding: 0,
        color: "var(--accent)",
        cursor: "pointer",
        textDecoration: "underline",
      }}
    >
      {label}
    </button>
  );
}
export const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 12,
  background: "var(--bg-input)",
  marginTop: 8,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 11,
  borderCollapse: "collapse",
};
const th: React.CSSProperties = {
  textAlign: "left",
  fontWeight: 600,
  color: "var(--text-ghost)",
  padding: "4px 6px",
  borderBottom: "1px solid var(--border-subtle)",
};
const td: React.CSSProperties = {
  padding: "4px 6px",
  borderBottom: "1px solid var(--border-subtle)",
  color: "var(--text-primary)",
};
const tdEllipsis: React.CSSProperties = {
  ...td,
  maxWidth: 200,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const mono: React.CSSProperties = {
  ...td,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  color: "var(--text-hint)",
};
const sessionPrimaryCell: React.CSSProperties = {
  ...td,
  borderBottom: "none",
};
const sessionPrimaryEllipsis: React.CSSProperties = {
  ...tdEllipsis,
  borderBottom: "none",
};
const sessionPrimaryMono: React.CSSProperties = {
  ...mono,
  borderBottom: "none",
};
const sessionExpiryStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "3px 16px",
  color: "var(--text-hint)",
  lineHeight: 1.3,
};
const sessionExpiryCell: React.CSSProperties = {
  ...td,
  paddingTop: 1,
};
export const smallBtn: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: 11,
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
};
const mintedBox: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  border: "1px solid var(--accent)",
  borderRadius: 6,
  background: "var(--bg-hover)",
};
const codeStyle: React.CSSProperties = {
  display: "block",
  wordBreak: "break-all",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  margin: "4px 0",
  color: "var(--text-primary)",
};
