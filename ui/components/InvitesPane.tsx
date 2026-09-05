// Owner-only "Invites" section: mint NEW-USER invite URLs and manage the
// outstanding ones. Device links for existing accounts are self-service in
// MyDevicesPane - an existing typed name gets an
// inline hint and a disabled submit (the server also rejects it, 409). The
// Recovery card is the one owner-side exception: a device link FOR an
// existing user who is locked out of every device (invites.mintRecovery). Mounts on the Settings page (UserSettingsView) when the current
// session's role is "owner". The other panes from the old all-in-one
// "Access & invites" section are ExternalAccessPane and SessionsPane.

import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, UserRole } from "../../shared/types.ts";
import { type UserView } from "../user-merge.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import { useI18n } from "../i18n.tsx";
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
  const i18n = useI18n();
  const { t, rich } = i18n;

  return (
    <div style={{ marginTop: 24 }}>
      {/* Invites mint NEW users only. Device links
          for existing accounts are self-service from each user's own
          My devices section - owners deliberately can't mint them for
          others. An existing typed name gets an inline hint (below) instead
          of a mode flip. */}
      <h4 style={sectionHeader}>{t("settings.sidebar.invites")}</h4>
      <p style={hint}>
        {rich("settings.invites.intro", { i: (chunk) => <i>{chunk}</i> })}
      </p>

      <IssueInviteForm />

      {/* Owner recovery: device links are
          self-service, but a user signed out of EVERY device can't mint one - 
          this is the owner's escape hatch. A card here (not its own sidebar
          entry) keeps the account list un-crowded; it lives next to invites
          because both mint sign-in URLs the owner hands out. */}
      <h5 style={subsectionHeader}>{t("settings.invites.recovery")}</h5>
      <RecoveryLinkForm />

      <h5 style={subsectionHeader}>{t("settings.invites.outstanding")}</h5>
      {renderListSection(i18n, invitesList, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}
    </div>
  );
}

function IssueInviteForm() {
  const { users, rooms, allRooms } = useAppState();
  const { t, rich } = useI18n();
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
          err instanceof ApiError
            ? err.message
            : t("settings.invites.mintFailed"),
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <label style={subLabel}>{t("settings.invites.issueFor")}</label>
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder={t("settings.invites.namePlaceholder")}
        maxLength={64}
        style={dialogInput}
      />
      {/* Existing-name hint: no mode flip - invites
          are new-user only (the server rejects existing names too), so point
          at the self-service device-link flow instead. */}
      {existing && (
        <p style={{ ...hint, marginTop: 4, color: "var(--text-primary)" }}>
          {rich("settings.invites.existing", {
            name: existingUser.name,
            b: (chunk) => <b>{chunk}</b>,
            i: (chunk) => <i>{chunk}</i>,
          })}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <label style={{ flex: 1 }}>
          <div style={subLabel}>{t("common.role")}</div>
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
          <div style={subLabel}>{t("common.rooms")}</div>
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
                {t("common.noRooms")}
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
                    aria-label={t("settings.invites.grantRoom", {
                      room: r.name,
                    })}
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
            {t("settings.invites.roomsHint")}
          </p>
        </div>
      )}
      <p style={{ ...hint, marginTop: 6 }}>
        {t("settings.invites.expiryHint")}
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
          {pending
            ? t("settings.invites.minting")
            : t("settings.invites.issue")}
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
  const { t } = useI18n();
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
            : t("settings.invites.recoveryFailed"),
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>
        {t("settings.invites.recoveryHint")}
      </p>
      <label style={subLabel}>{t("common.user")}</label>
      <select
        value={userId}
        onChange={(e) => {
          setUserId(e.target.value);
          setError(null);
        }}
        style={dialogInput}
      >
        <option value="">{t("settings.invites.selectUser")}</option>
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
          {pending
            ? t("settings.invites.minting")
            : t("settings.invites.mintRecovery")}
        </button>
      </div>
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}
