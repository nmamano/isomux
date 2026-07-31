// Owner-only "Invites" section: mint NEW-USER invite URLs and manage the
// outstanding ones. Device links for existing accounts are self-service in
// MyDevicesPane (task eb3354e6 revision) - an existing typed name gets an
// inline hint and a disabled submit (the server also rejects it, 409). The
// Recovery card is the one owner-side exception: a device link FOR an
// existing user who is locked out of every device (invites.mintRecovery). Mounts on the User Settings page (UserSettingsView) when the current
// session's role is "owner". One of the three panes the old all-in-one
// "Access & invites" section was split into (task 07514e7f) - see also
// ExternalAccessPane and SessionsPane.

import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, UserRole } from "../../shared/types.ts";
import { type UserView } from "../user-merge.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import { dialogInput, dialogSaveBtn } from "./dialog-styles.ts";
import {
  InvitesTable,
  MintedUrlBox,
  renderListSection,
  sectionHeader,
  subsectionHeader,
  subLabel,
  hint,
  cardStyle,
} from "./access-shared.tsx";

export function InvitesPane() {
  const { invitesList, invitesLoaded } = useAppState();

  return (
    <div style={{ marginTop: 24 }}>
      {/* Task eb3354e6 (revised): invites mint NEW users only. Device links
          for existing accounts are self-service from each user's own
          My devices section - owners deliberately can't mint them for
          others. An existing typed name gets an inline hint (below) instead
          of a mode flip. */}
      <h4 style={sectionHeader}>Invites</h4>
      <p style={hint}>
        Add a new member or owner: issue an invite URL and send it to them
        out-of-band. Opening it creates their account and signs that device in.
        For extra devices on an existing account, each user generates their own
        device link from <i>My devices</i>.
      </p>

      <IssueInviteForm />

      {/* Owner recovery (task eb3354e6 final revision): device links are
          self-service, but a user signed out of EVERY device can't mint one - 
          this is the owner's escape hatch. A card here (not its own sidebar
          entry) keeps the account list un-crowded; it lives next to invites
          because both mint sign-in URLs the owner hands out. */}
      <h5 style={subsectionHeader}>Recovery</h5>
      <RecoveryLinkForm />

      <h5 style={subsectionHeader}>Outstanding invites</h5>
      {renderListSection(invitesList, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}
    </div>
  );
}

function IssueInviteForm() {
  const { users, rooms, allRooms } = useAppState();
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("member");
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

  // Room grants apply only when the invite will CREATE a member record:
  // owners reach every room by rule. The picker also hides while the typed
  // name matches an existing user (the submit is disabled then anyway).
  const showRoomPicker = !existing && role === "member";

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
      role,
      ...(showRoomPicker && grantRooms.length > 0
        ? { allowedRooms: grantRooms }
        : {}),
    })
      .then((r) => {
        setMintedUrl(r.url);
        setName("");
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
        placeholder="New username (e.g. Marc)"
        maxLength={64}
        style={dialogInput}
      />
      {/* Existing-name hint (task eb3354e6 revised): no mode flip - invites
          are new-user only (the server rejects existing names too), so point
          at the self-service device-link flow instead. */}
      {existing && (
        <p style={{ ...hint, marginTop: 4, color: "var(--text-primary)" }}>
          <b>{existingUser.name}</b> already exists, so no invite is needed: to
          sign in another device, {existingUser.name} can generate a device link
          from <i>My devices</i> in their own settings - or you can mint them a
          recovery link below.
        </p>
      )}
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
        up to 1 year (revocable from the Sessions section any time).
      </p>

      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !name.trim() || existing}
          style={{
            ...dialogSaveBtn,
            opacity: pending || !name.trim() || existing ? 0.5 : 1,
          }}
        >
          {pending ? "Minting…" : "Issue invite"}
        </button>
      </div>
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}

// Owner-only recovery card: mint a device link FOR an existing user, picked
// from a dropdown (POST /api/invites/recovery, target by stable userId; the
// server derives name/role and replaces any prior outstanding link for them).
// Deliberately ungated on whether the user currently has sessions - an owner
// may pre-empt a lockout.
function RecoveryLinkForm() {
  const { users } = useAppState();
  const [userId, setUserId] = useState("");
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  function submit() {
    if (!userId) return;
    setPending(true);
    setError(null);
    setMintedUrl(null);
    apiFetch<{ url: string; invite: InviteWire }>(
      "POST",
      "/api/invites/recovery",
      { userId },
    )
      .then((r) => {
        setMintedUrl(r.url);
        setUserId("");
      })
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : "Failed to mint recovery link",
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>
        Help an existing user get back in. Device links are self-service, but
        someone signed out of every device can&apos;t mint their own - pick them
        here and send the link out-of-band. It expires in 24h; minting a new one
        replaces their previous link.
      </p>
      <label style={subLabel}>User</label>
      <select
        value={userId}
        onChange={(e) => {
          setUserId(e.target.value);
          setError(null);
        }}
        style={dialogInput}
      >
        <option value="">Select a user…</option>
        {userList.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {error && (
        <p style={{ fontSize: 11, color: "#ff6b6b", margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !userId}
          style={{
            ...dialogSaveBtn,
            opacity: pending || !userId ? 0.5 : 1,
          }}
        >
          {pending ? "Minting…" : "Mint recovery link"}
        </button>
      </div>
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}
