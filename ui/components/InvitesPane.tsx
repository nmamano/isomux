// Owner-only "Invites" section: mint invite URLs and manage the outstanding
// ones. Mounts on the User Settings page (UserSettingsView) when the current
// session's role is "owner". One of the three panes the old all-in-one
// "Access & invites" section was split into (task 07514e7f) — see also
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
      <h4 style={sectionHeader}>Invites</h4>
      <p style={hint}>
        Add owners and members by issuing invite URLs and sending them to the
        recipient out-of-band. Signed-in devices are listed in the Sessions
        section.
      </p>

      <IssueInviteForm />

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
        up to 1 year (revocable from the Sessions section any time).
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
