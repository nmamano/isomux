// Owner-only Access section: list outstanding invites + active sessions,
// issue new invites, revoke either. Mounts inside UserManagementModal when
// the current session's role is "owner".

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import type {
  InviteWire,
  SessionWire,
  UserRecord,
  UserRole,
} from "../../shared/types.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import {
  dialogLabel,
  dialogInput,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";

export function AccessPane() {
  const { invitesList, invitesLoaded, activeSessions, activeSessionsLoaded } =
    useAppState();
  // Holds the most recent server-side lockout-prevention rejection so the
  // banner stays visible until the user dismisses or retries. Cleared on
  // any successful state change (which we proxy via activeSessions length
  // change — a successful revoke shrinks the list).
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const prevSessionsLenRef = useRef<number>(activeSessions.length);

  // Lazily fetch the owner-only lists. The session_context reducer resets
  // both loaded flags on every WS open (including reconnects), so this
  // effect re-runs and keeps the lists fresh across socket bounces.
  useEffect(() => {
    if (!invitesLoaded) send({ type: "list_invites" });
    if (!activeSessionsLoaded) send({ type: "list_active_sessions" });
  }, [invitesLoaded, activeSessionsLoaded]);

  // Listen for the server's lockout-prevention rejections. Component-
  // scoped raw listener so it doesn't leak across pane mounts.
  useEffect(() => {
    const fn = (data: string) => {
      try {
        const m = JSON.parse(data);
        if (m.type === "revoke_blocked" && typeof m.reason === "string") {
          setBlockedNote(m.reason);
        }
      } catch {}
    };
    addRawListener(fn);
    return () => removeRawListener(fn);
  }, []);

  // Auto-clear the banner on any successful active-session change. The
  // user fixed whatever the rejection was about (typically by minting an
  // extra invite then retrying the revoke) — keeping the banner up after
  // the list shrinks is noise.
  useEffect(() => {
    const prev = prevSessionsLenRef.current;
    const curr = activeSessions.length;
    prevSessionsLenRef.current = curr;
    if (curr < prev) setBlockedNote(null);
  }, [activeSessions.length]);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>Access</h4>
      <p style={hint}>
        The first owner is bootstrapped via the URL the server prints on
        startup. After that, you add owners and members here by issuing invite
        URLs and sending them to the recipient.
      </p>

      {blockedNote && (
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
          <span style={{ flex: 1 }}>{blockedNote}</span>
          <button
            onClick={() => setBlockedNote(null)}
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
      )}

      <IssueInviteForm />

      <h5 style={subsectionHeader}>Outstanding invites</h5>
      {renderListSection(invitesList, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}

      <h5 style={subsectionHeader}>Active sessions</h5>
      {renderListSection(activeSessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} />
      ))}
    </div>
  );
}

// Render the cached rows whenever any are present, even while a refresh is
// in flight — avoids a flicker to "Loading…" on every reconnect. Empty+not-
// loaded shows "Loading…" (first load only); empty+loaded shows "None.".
// Exported so MyDevicesPane renders the member-scoped lists identically.
export function renderListSection<T>(
  rows: T[],
  loaded: boolean,
  renderTable: (rows: T[]) => React.ReactNode,
): React.ReactNode {
  if (rows.length > 0) return renderTable(rows);
  if (!loaded) return <p style={hint}>Loading…</p>;
  return <p style={hint}>None.</p>;
}

function IssueInviteForm() {
  const { users } = useAppState();
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [allowExisting, setAllowExisting] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Track the in-flight raw listener so a navigation away mid-mint doesn't
  // leak the one-shot subscription past the form's lifetime.
  const pendingListenerRef = useRef<((data: string) => void) | null>(null);
  useEffect(() => {
    return () => {
      const fn = pendingListenerRef.current;
      if (fn) removeRawListener(fn);
    };
  }, []);

  // Existing-user detection uses the same lowercase key the server uses
  // (lowercaseKey, not raw toLowerCase) so unicode/whitespace handling
  // stays consistent across the two sides.
  const existingUser: UserRecord | null = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    return users.get(lowercaseKey(trimmed)) ?? null;
  }, [users, name]);
  const existing = existingUser !== null;

  // When the typed name matches an existing user, the role dropdown is
  // hidden and the effective role is forced to the existing user's role.
  // Issuing a mismatched role would be rejected at accept time anyway
  // (server returns role_mismatch); surfacing the restriction up-front
  // avoids the confusion the boss flagged.
  const effectiveRole: UserRole = existingUser ? existingUser.role : role;

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const reqId = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setPending(true);
    setError(null);
    setMintedUrl(null);
    const listener = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "invite_minted" && msg.requestId === reqId) {
          setPending(false);
          removeRawListener(listener);
          pendingListenerRef.current = null;
          if (msg.ok) {
            setMintedUrl(msg.url);
            setName("");
            setAllowExisting(false);
          } else {
            setError(msg.error || "Failed to mint invite");
          }
        }
      } catch {}
    };
    pendingListenerRef.current = listener;
    addRawListener(listener);
    send({
      type: "mint_invite",
      requestId: reqId,
      username: trimmed,
      role: effectiveRole,
      allowExisting: existing ? allowExisting : false,
    });
  }

  return (
    <div style={cardStyle}>
      <label style={subLabel}>Issue invite for…</label>
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder="Username (e.g. Marc)"
        maxLength={64}
        style={dialogInput}
      />
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <label style={{ flex: 1 }}>
          <div style={subLabel}>Role</div>
          {existingUser ? (
            <div
              style={{
                ...dialogInput,
                display: "flex",
                alignItems: "center",
                color: "var(--text-dim)",
                background: "var(--bg-base)",
                fontSize: 12,
              }}
              title={`Role is fixed to match the existing ${existingUser.name} record. Use the change-role flow to promote/demote.`}
            >
              {existingUser.role}
              <span style={{ marginLeft: 6, color: "var(--text-hint)" }}>
                (matches existing user)
              </span>
            </div>
          ) : (
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              style={dialogInput}
            >
              <option value="member">member</option>
              <option value="owner">owner</option>
            </select>
          )}
        </label>
      </div>
      <p style={{ ...hint, marginTop: 6 }}>
        Invite link expires 24h after issuing if unused. Accepted sessions last
        up to 1 year (revocable from the Access pane any time).
      </p>
      {existing && (
        <label style={{ display: "flex", gap: 6, marginTop: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={allowExisting}
            onChange={(e) => setAllowExisting(e.target.checked)}
          />
          <span>
            User <b>{name}</b> already exists. Issue an additional invite for
            this identity (e.g. another device). Won't affect existing sessions
            or role.
          </span>
        </label>
      )}
      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !name.trim() || (existing && !allowExisting)}
          style={{
            ...dialogSaveBtn,
            opacity:
              pending || !name.trim() || (existing && !allowExisting) ? 0.5 : 1,
          }}
        >
          {pending ? "Minting…" : "Issue invite"}
        </button>
      </div>
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}

// Surfaces the freshly-minted invite URL with a working copy button and
// visible feedback. Falls back to a hidden-textarea + execCommand path
// when navigator.clipboard rejects (mobile, focus quirks, permissions);
// final fallback selects the URL so the user can copy manually.
// Exported so the member self-invite path (MyDevicesPane) renders the
// minted link with identical copy behavior.
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
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>For</th>
          <th style={th}>Role</th>
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
            <td style={td}>{formatExpiry(i.expiresAt)}</td>
            <td style={mono}>{i.tokenPrefix}…</td>
            <td style={td}>
              <button
                onClick={() =>
                  send({ type: "revoke_invite", tokenPrefix: i.tokenPrefix })
                }
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

export function SessionsTable({ sessions }: { sessions: SessionWire[] }) {
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
                    title="Use Sign out at the bottom of this dialog to end your current session."
                  >
                    Current session
                  </span>
                ) : (
                  <button
                    onClick={() =>
                      send({
                        type: "revoke_session",
                        sessionPrefix: s.sessionPrefix,
                      })
                    }
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

function formatRelative(ts: number): string {
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

// Styles shared with MyDevicesPane (the member-scoped parallel view).
// Exported so both panes match visually without a separate styles file.
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
const subLabel: React.CSSProperties = { ...dialogLabel, marginTop: 8 };
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
const smallBtn: React.CSSProperties = {
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
