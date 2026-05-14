// Owner-only Access section: list outstanding invites + active sessions,
// issue new invites, revoke either. Mounts inside UserManagementModal when
// the current session's role is "owner".

import { useEffect, useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { send, addRawListener, removeRawListener } from "../ws.ts";
import type { InviteWire, SessionWire, UserRole } from "../../shared/types.ts";
import {
  dialogLabel,
  dialogInput,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";

export function AccessPane() {
  const { invitesList, invitesLoaded, activeSessions, activeSessionsLoaded } =
    useAppState();

  // Owners can come from any client; lazily fetch the tables when the pane
  // mounts so we don't ship lists to non-owners pre-emptively.
  useEffect(() => {
    if (!invitesLoaded) send({ type: "list_invites" });
    if (!activeSessionsLoaded) send({ type: "list_active_sessions" });
  }, [invitesLoaded, activeSessionsLoaded]);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>Access</h4>
      <p style={hint}>
        Issue invite URLs and manage who's signed in. Anyone with a valid invite
        URL can claim a session as the username it's tagged for.
      </p>

      <IssueInviteForm />

      <h5 style={subsectionHeader}>Outstanding invites</h5>
      {!invitesLoaded ? (
        <p style={hint}>Loading…</p>
      ) : invitesList.length === 0 ? (
        <p style={hint}>None.</p>
      ) : (
        <InvitesTable invites={invitesList} />
      )}

      <h5 style={subsectionHeader}>Active sessions</h5>
      {!activeSessionsLoaded ? (
        <p style={hint}>Loading…</p>
      ) : activeSessions.length === 0 ? (
        <p style={hint}>None.</p>
      ) : (
        <SessionsTable sessions={activeSessions} />
      )}
    </div>
  );
}

function IssueInviteForm() {
  const { users } = useAppState();
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [ttlDays, setTtlDays] = useState(7);
  const [allowExisting, setAllowExisting] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const existing = useMemo(
    () => users.has(name.trim().toLowerCase()),
    [users, name],
  );

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
    addRawListener(listener);
    send({
      type: "mint_invite",
      requestId: reqId,
      username: trimmed,
      role,
      ttlSeconds: ttlDays * 24 * 60 * 60,
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
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            style={dialogInput}
          >
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <div style={subLabel}>Expires in</div>
          <select
            value={ttlDays}
            onChange={(e) => setTtlDays(Number(e.target.value))}
            style={dialogInput}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
      </div>
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
      {mintedUrl && (
        <div style={mintedBox}>
          <div style={{ ...subLabel, marginTop: 0 }}>Invite URL</div>
          <code style={codeStyle}>{mintedUrl}</code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(mintedUrl);
            }}
            style={smallBtn}
            title="Copy URL"
          >
            Copy
          </button>
          <p style={hint}>
            Send this URL to the invitee. It's one-time: opening it on their
            device signs them in. The URL is shown once — copy it now.
          </p>
        </div>
      )}
    </div>
  );
}

function InvitesTable({ invites }: { invites: InviteWire[] }) {
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

function SessionsTable({ sessions }: { sessions: SessionWire[] }) {
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
        {sessions.map((s) => (
          <tr key={s.sessionPrefix}>
            <td style={td}>{s.username}</td>
            <td style={td}>{formatRelative(s.lastSeenAt)}</td>
            <td style={td}>{formatRelative(s.createdAt)}</td>
            <td style={tdEllipsis}>{s.userAgent ?? "—"}</td>
            <td style={mono}>{s.sessionPrefix}…</td>
            <td style={td}>
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
            </td>
          </tr>
        ))}
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

const sectionHeader: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  margin: "0 0 4px",
  color: "var(--text-primary)",
};
const subsectionHeader: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  margin: "16px 0 6px",
  color: "var(--text-primary)",
};
const subLabel: React.CSSProperties = { ...dialogLabel, marginTop: 8 };
const hint: React.CSSProperties = dialogHint;
const cardStyle: React.CSSProperties = {
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
