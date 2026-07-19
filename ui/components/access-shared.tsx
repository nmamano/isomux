// Shared building blocks for the account panes on the User Settings page
// (ExternalAccessPane / InvitesPane / SessionsPane for owners, MyDevicesPane
// for members): the invites + sessions tables, the minted-URL box with its
// clipboard fallbacks, list-section rendering, relative-time formatting, and
// the common styles. Split out of the former all-in-one AccessPane when the
// "Access & invites" section was broken into separate sidebar entries
// (task 07514e7f).

import { useEffect, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, SessionWire } from "../../shared/types.ts";
import { dialogLabel, dialogHint } from "./dialog-styles.ts";

// Lazily seed the invites + active-sessions lists via GET. The
// session_context reducer resets both loaded flags on every WS open
// (including reconnects), so this effect re-runs and keeps the lists fresh
// across socket bounces. Mutations still arrive as recipient-scoped
// invites_list / sessions_active_list broadcasts; these GETs only seed the
// initial (and post-reconnect) snapshot. The server scopes both endpoints to
// the caller (owners: all rows; members: own rows only), so one hook serves
// every pane. Called once from UserSettingsView — the sidebar roster needs
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
// in flight — avoids a flicker to "Loading…" on every reconnect. Empty+not-
// loaded shows "Loading…" (first load only); empty+loaded shows "None.".
export function renderListSection<T>(
  rows: T[],
  loaded: boolean,
  renderTable: (rows: T[]) => React.ReactNode,
): React.ReactNode {
  if (rows.length > 0) return renderTable(rows);
  if (!loaded) return <p style={hint}>Loading…</p>;
  return <p style={hint}>None.</p>;
}

// Surfaces a freshly-minted invite URL with a working copy button and
// visible feedback. Falls back to a hidden-textarea + execCommand path
// when navigator.clipboard rejects (mobile, focus quirks, permissions);
// final fallback selects the URL so the user can copy manually.
export function MintedUrlBox({ url }: { url: string }) {
  const codeRef = useRef<HTMLElement | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyState, setCopyState] = useState<
    "idle" | "ok" | "fallback" | "fail"
  >("idle");

  // Clear any in-flight feedback timer if the component unmounts while a
  // success indicator is still flashing — avoids setState-after-unmount.
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
      <div style={{ ...subLabel, marginTop: 0 }}>Invite URL</div>
      <code ref={codeRef} style={codeStyle}>
        {url}
      </code>
      <button
        onClick={() => {
          void handleCopy();
        }}
        style={smallBtn}
        title="Copy URL"
      >
        {copyState === "ok" || copyState === "fallback" ? "Copied!" : "Copy"}
      </button>
      {copyState === "fail" && (
        <p style={{ ...hint, color: "#ff6b6b", marginTop: 4 }}>
          Clipboard blocked. The URL above is selected — copy it manually.
        </p>
      )}
      <p style={hint}>
        Send this URL to the invitee. It's one-time: opening it on their device
        signs them in. The URL is shown once — copy it now.
      </p>
    </div>
  );
}

export function InvitesTable({ invites }: { invites: InviteWire[] }) {
  const { rooms, allRooms } = useAppState();
  // Resolve granted room ids to names for display. Owners have allRooms;
  // members (My devices pane) fall back to their projected rooms — their
  // self-invites never carry grants, so the fallback rarely matters. A
  // deleted room's id shows as-is rather than vanishing.
  const roomList = allRooms.length > 0 ? allRooms : rooms;
  const roomName = (id: string) =>
    roomList.find((r) => r.id === id)?.name ?? id;
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>For</th>
          <th style={th}>Role</th>
          <th style={th}>Rooms</th>
          <th style={th}>Expires</th>
          <th style={th}>Prefix</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {invites.map((i) => (
          <tr key={i.tokenPrefix}>
            <td style={td}>
              {i.username ?? <i>{i.bootstrap ? "(bootstrap)" : "—"}</i>}
            </td>
            <td style={td}>{i.role}</td>
            <td style={td}>
              {i.allowedRooms?.length ? (
                i.allowedRooms.map(roomName).join(", ")
              ) : (
                <i>—</i>
              )}
            </td>
            <td style={td}>{formatExpiry(i.expiresAt)}</td>
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
                Revoke
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
  const currentPrefix = sessionContext?.currentSessionPrefix ?? null;
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>User</th>
          <th style={th}>Last seen</th>
          <th style={th}>Created</th>
          <th style={th}>User-Agent</th>
          <th style={th}>Prefix</th>
          <th style={th}></th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => {
          const isCurrent = s.sessionPrefix === currentPrefix;
          return (
            <tr key={s.sessionPrefix}>
              <td style={td}>{s.username}</td>
              <td style={td}>{formatRelative(s.lastSeenAt)}</td>
              <td style={td}>{formatRelative(s.createdAt)}</td>
              <td style={tdEllipsis}>{s.userAgent ?? "—"}</td>
              <td style={mono}>{s.sessionPrefix}…</td>
              <td style={td}>
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
                    title="Use Sign out at the bottom of the sidebar to end your current session."
                  >
                    Current session
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
                    Revoke
                  </button>
                )}
              </td>
            </tr>
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
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

// Auto-clear the blocked banner on any successful active-session change: the
// user fixed whatever the rejection was about (typically by minting an extra
// invite then retrying the revoke) — keeping the banner up after the list
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

// Coarse relative timestamp ("just now", "5m ago", "3h ago", "4d ago").
// Also used by the Users-page sidebar for the per-user last-seen line.
export function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function formatExpiry(ts: number): string {
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return "expired";
  const h = Math.round(diffMs / 3600_000);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
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
