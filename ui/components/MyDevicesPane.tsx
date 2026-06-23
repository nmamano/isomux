// Member-scoped "My devices" pane: parallel to AccessPane but every
// list is filtered to the current user. The mint-invite form collapses
// to a single "Generate device link" button (the server fixes role to
// member, TTL to 1 hour, target to the caller's own username, and
// replaces any prior outstanding self-invite). Mounts in
// UserManagementModal when the session role is not "owner".

import { useEffect, useRef, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, SessionWire } from "../../shared/types.ts";
import { dialogSaveBtn } from "./dialog-styles.ts";
import {
  InvitesTable,
  SessionsTable,
  MintedUrlBox,
  renderListSection,
  sectionHeader,
  subsectionHeader,
  hint,
  cardStyle,
} from "./AccessPane.tsx";

export function MyDevicesPane() {
  const { invitesList, invitesLoaded, activeSessions, activeSessionsLoaded } =
    useAppState();
  const dispatch = useDispatch();

  // Server-side lockout-prevention rejections (a 409 from sessions.revoke,
  // surfaced by SessionsTable's onBlocked) are owner-relevant in practice (a
  // member's session can't be the office's last owner session), but the banner
  // is wired in case a future role-change races a revoke.
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const prevSessionsLenRef = useRef<number>(activeSessions.length);

  // Same lazy-seed pattern as AccessPane. The server returns the member-scoped
  // subset for non-owner callers; the same store slice backs both views, so a
  // member never sees foreign rows. Mutations still arrive as scoped broadcasts.
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

  useEffect(() => {
    const prev = prevSessionsLenRef.current;
    const curr = activeSessions.length;
    prevSessionsLenRef.current = curr;
    if (curr < prev) setBlockedNote(null);
  }, [activeSessions.length]);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>My devices</h4>
      <p style={hint}>
        Generate a single-use link to sign another of your devices into your
        account. The link expires in 1 hour; generating a new one replaces the
        previous.
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

      <GenerateDeviceLinkForm />

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

function GenerateDeviceLinkForm() {
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function generate() {
    setPending(true);
    setError(null);
    setMintedUrl(null);
    // mint_self_invite carries no client-supplied knobs: the server derives
    // target/role/TTL from the caller's session and the self-invite cap, so a
    // tampered client cannot extend the window or impersonate another user.
    apiFetch<{ url: string; invite: InviteWire }>("POST", "/api/invites/self")
      .then((r) => setMintedUrl(r.url))
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : "Failed to generate device link",
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>
        Anyone with the link can sign in as you until it expires or is used —
        treat it like a one-time password and only open it on your own device.
      </p>
      <button
        onClick={generate}
        disabled={pending}
        style={{ ...dialogSaveBtn, opacity: pending ? 0.5 : 1 }}
      >
        {pending ? "Generating…" : "Generate device link"}
      </button>
      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}
