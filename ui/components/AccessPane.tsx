// Owner-only Access section: list outstanding invites + active sessions,
// issue new invites, revoke either. Mounts inside UserManagementModal when
// the current session's role is "owner".

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, SessionWire, UserRole } from "../../shared/types.ts";
import type { AccessSettings } from "../../shared/contract-shapes.ts";
import { type UserView } from "../user-merge.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import { normalizePublicOrigin } from "../../shared/public-origin.ts";
import {
  dialogLabel,
  dialogInput,
  dialogSaveBtn,
  dialogHint,
} from "./dialog-styles.ts";

export function AccessPane() {
  const { invitesList, invitesLoaded, activeSessions, activeSessionsLoaded } =
    useAppState();
  const dispatch = useDispatch();
  // Holds the most recent server-side lockout-prevention rejection (a 409 from
  // sessions.revoke, surfaced by SessionsTable) so the banner stays visible
  // until the user dismisses or retries. Cleared on any successful state change
  // (proxied via activeSessions length change: a successful revoke shrinks it).
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const prevSessionsLenRef = useRef<number>(activeSessions.length);

  // Lazily seed the owner-only lists via GET. The session_context reducer resets
  // both loaded flags on every WS open (including reconnects), so this effect
  // re-runs and keeps the lists fresh across socket bounces. Mutations still
  // arrive as recipient-scoped invites_list / sessions_active_list broadcasts;
  // these GETs only seed the initial (and post-reconnect) snapshot.
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
        Add owners and members here by issuing invite URLs and sending them to
        the recipient. Toggle external access if you want this office reachable
        from outside the host machine.
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

      <ExternalAccessSection />

      <IssueInviteForm />

      <h5 style={subsectionHeader}>Outstanding invites</h5>
      {renderListSection(invitesList, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}

      <h5 style={subsectionHeader}>Active sessions</h5>
      {renderListSection(activeSessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} onBlocked={setBlockedNote} />
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

// Owner-only "where can people reach this office from?" controls. Pre-claim
// or with external access disabled, isomux binds 127.0.0.1 only and the
// office is reachable only from the host machine (or via an SSH tunnel).
// Flipping the toggle and saving stores the new state plus the public URL,
// mints an owner self-invite bound to the NEW origin (the running process
// still has the old bind in place, so this URL won't resolve until restart),
// and prompts the operator to restart isomux. The restart is intentional:
// changing the bind interface and cookie/origin policy mid-process is
// brittle, and the toggle is rare enough that "save then restart" is the
// right trade.
function ExternalAccessSection() {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [envOriginSet, setEnvOriginSet] = useState(false);
  // The normalized env value, or null when the env var is absent OR set but
  // invalid (in which case envOriginSet is true while envOrigin is null —
  // the UI uses that combination to flag the invalid case).
  const [envOrigin, setEnvOrigin] = useState<string | null>(null);
  const [boundLoopback, setBoundLoopback] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  // Snapshot of the last-saved state. Compared against the form during
  // render to drive the Save-button enabled/disabled state, so kept as
  // state rather than a ref.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    enabled: boolean;
    urlInput: string;
  }>({ enabled: false, urlInput: "" });

  useEffect(() => {
    let cancelled = false;
    apiFetch<AccessSettings>("GET", "/api/office/access")
      .then((s) => {
        if (cancelled) return;
        const nextEnabled = !!s.externalAccess;
        const nextUrl =
          typeof s.publicOrigin === "string" ? s.publicOrigin : "";
        setEnabled(nextEnabled);
        setUrlInput(nextUrl);
        setEnvOriginSet(!!s.envOriginSet);
        setEnvOrigin(typeof s.envOrigin === "string" ? s.envOrigin : null);
        setBoundLoopback(!!s.boundLoopback);
        setSavedSnapshot({ enabled: nextEnabled, urlInput: nextUrl });
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function submit() {
    const nextEnabled = enabled;
    const nextUrl = nextEnabled ? urlInput.trim() : "";
    setPending(true);
    setError(null);
    setSignInUrl(null);
    setRestartRequired(false);
    apiFetch<{ signInUrl: string | null; restartRequired: boolean }>(
      "PUT",
      "/api/office/access",
      { externalAccess: nextEnabled, publicOrigin: nextUrl },
    )
      .then((r) => {
        setEnabled(nextEnabled);
        setUrlInput(nextUrl);
        setSavedSnapshot({ enabled: nextEnabled, urlInput: nextUrl });
        setSignInUrl(typeof r.signInUrl === "string" ? r.signInUrl : null);
        setRestartRequired(!!r.restartRequired);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : "Failed to update settings",
        );
      })
      .finally(() => setPending(false));
  }

  const dirty =
    enabled !== savedSnapshot.enabled ||
    urlInput.trim() !== savedSnapshot.urlInput;

  // Apply the same normalization the server uses, so the env-conflict /
  // env-match notes don't flash a false warning when the operator types
  // an equivalent-but-unnormalized URL (e.g. with a trailing slash).
  // Returns null when the input doesn't parse as a valid public origin,
  // in which case neither the match nor the conflict note renders.
  const normalizedInput = normalizePublicOrigin(urlInput);

  if (!loaded) {
    return (
      <div style={cardStyle}>
        <h5 style={{ ...subsectionHeader, margin: "0 0 6px" }}>
          External access
        </h5>
        <p style={hint}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h5 style={{ ...subsectionHeader, margin: "0 0 6px" }}>
        External access
      </h5>
      <p style={hint}>
        Currently {boundLoopback ? "loopback-only" : "listening externally"}.
        {boundLoopback
          ? " The office is reachable from this machine, or from other machines via an SSH tunnel."
          : " The office is reachable from anywhere the public URL resolves."}
      </p>
      <label style={{ display: "flex", gap: 6, marginTop: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable external access</span>
      </label>
      {enabled && (
        <>
          <div style={subLabel}>Public URL</div>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://auntie.tailnet.ts.net"
            style={dialogInput}
          />
          <p style={hint}>
            Pattern: https://&lt;host&gt; (the address you'll open from your
            laptop / phone). Saving doesn't change the running server's bind on
            its own — restart isomux to apply.
          </p>
        </>
      )}
      {envOriginSet && !envOrigin && (
        <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
          Note: <code>ISOMUX_PUBLIC_ORIGIN</code> is set in the environment but
          not a valid public origin, so the server ignores it. Remove it from
          your env file or set it to <code>https://&lt;host&gt;</code>
          or <code>http://localhost</code>.
        </p>
      )}
      {envOrigin && enabled && normalizedInput === envOrigin && (
        <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
          Note: <code>ISOMUX_PUBLIC_ORIGIN={envOrigin}</code> is set in the
          environment and matches this Public URL. The env var is deprecated —
          remove it from your env file once this office-config value is saved.
        </p>
      )}
      {envOrigin &&
        enabled &&
        normalizedInput &&
        normalizedInput !== envOrigin && (
          <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
            Note: <code>ISOMUX_PUBLIC_ORIGIN={envOrigin}</code> is set in the
            environment. After restart it would override any different value
            saved here, so the save will be refused until you either match this
            URL to the env value or remove the env var from your service
            environment.
          </p>
        )}
      {envOrigin && !enabled && (
        <p style={{ ...hint, marginTop: 6, color: "var(--text-hint)" }}>
          Note: <code>ISOMUX_PUBLIC_ORIGIN={envOrigin}</code> is set in the
          environment but the office is bound loopback-only, so the value is
          ignored at runtime. The env var is deprecated — remove it from your
          env file.
        </p>
      )}
      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !dirty}
          style={{
            ...dialogSaveBtn,
            opacity: pending || !dirty ? 0.5 : 1,
          }}
        >
          {pending ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      {restartRequired && (
        <div style={restartBoxStyle}>
          <p style={{ ...hint, marginTop: 0 }}>
            Saved. Restart isomux so the new bind takes effect:
          </p>
          <code style={codeBlockStyle}>systemctl --user restart isomux</code>
          {signInUrl && (
            <>
              <p style={{ ...hint, marginTop: 10 }}>
                After the restart, open this URL on whichever device you want to
                use from the public address. (It expires 1 hour after minting.)
              </p>
              <MintedUrlBox url={signInUrl} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const restartBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  border: "1px solid var(--accent)",
  borderRadius: 6,
  background: "var(--bg-hover)",
};
const codeBlockStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: "4px 6px",
  borderRadius: 4,
  background: "var(--bg-code)",
  color: "var(--text-primary)",
  margin: "4px 0",
};

function IssueInviteForm() {
  const { users, rooms, allRooms } = useAppState();
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [allowExisting, setAllowExisting] = useState(false);
  // Rooms pre-assigned to the invite: the invitee lands with access to these
  // instead of an empty office. Member invites for NEW users only (mirrors
  // the server-side rule).
  const [grantRooms, setGrantRooms] = useState<string[]>([]);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Same source the user-edit panel uses: the unfiltered global list when
  // available so the owner can grant rooms they've hidden from their own view.
  const editorRooms = allRooms.length > 0 ? allRooms : rooms;

  // Existing-user detection uses the same lowercase key the server uses
  // (lowercaseKey, not raw toLowerCase) so unicode/whitespace handling
  // stays consistent across the two sides.
  const existingUser: UserView | null = useMemo(() => {
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

  // Room grants apply only when the invite will CREATE a member record:
  // owners reach every room by rule, and an existing user's access is
  // managed in their user settings. The picker hides in the other cases and
  // the request omits the field so the server never sees a stale selection.
  const showRoomPicker = !existing && effectiveRole === "member";

  function toggleGrantRoom(roomId: string) {
    setGrantRooms((prev) =>
      prev.includes(roomId)
        ? prev.filter((id) => id !== roomId)
        : [...prev, roomId],
    );
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    setMintedUrl(null);
    apiFetch<{ url: string; invite: InviteWire }>("POST", "/api/invites", {
      username: trimmed,
      role: effectiveRole,
      allowExisting: existing ? allowExisting : false,
      ...(showRoomPicker && grantRooms.length > 0
        ? { allowedRooms: grantRooms }
        : {}),
    })
      .then((r) => {
        setMintedUrl(r.url);
        setName("");
        setAllowExisting(false);
        setGrantRooms([]);
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : "Failed to mint invite",
        );
      })
      .finally(() => setPending(false));
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
      {showRoomPicker && (
        <div style={{ marginTop: 8 }}>
          <div style={subLabel}>Rooms</div>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-base)",
              padding: "4px 0",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {editorRooms.length === 0 ? (
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  color: "var(--text-ghost)",
                }}
              >
                No rooms yet.
              </div>
            ) : (
              editorRooms.map((r) => (
                <label
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={grantRooms.includes(r.id)}
                    onChange={() => toggleGrantRoom(r.id)}
                    aria-label={`Grant access to ${r.name}`}
                    style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.name}
                  </span>
                </label>
              ))
            )}
          </div>
          <p style={{ ...hint, marginTop: 4 }}>
            The invitee lands with access to the checked rooms. Leave all
            unchecked to grant access later from their user settings.
          </p>
        </div>
      )}
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
                    title="Use Sign out at the bottom of this dialog to end your current session."
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
