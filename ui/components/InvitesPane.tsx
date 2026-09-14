// Owner invites create new accounts. Recovery links target existing accounts.

import { OfficeOwnerCheckbox } from "./OfficeOwnerCheckbox.tsx";
import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, UserRole } from "../../shared/types.ts";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "../../shared/languages.ts";
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
import { noTranslate } from "../no-translate.ts";

export function InvitesPane() {
  const { invitesList, invitesLoaded } = useAppState();
  const i18n = useI18n();
  const { t, rich } = i18n;

  return (
    <div style={{ marginTop: 24 }}>
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
  const { rooms, allRooms } = useAppState();
  const { t } = useI18n();
  const [language, setLanguage] = useState<SupportedLanguageCode | "">("");
  const [memberPrompt, setMemberPrompt] = useState("");
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

  const showRoomPicker = role === "member";

  function toggleGrantRoom(roomId: string) {
    setGrantRooms((prev) =>
      prev.includes(roomId)
        ? prev.filter((id) => id !== roomId)
        : [...prev, roomId],
    );
  }

  function submit() {
    const trimmed = name.trim();
    setPending(true);
    setError(null);
    setMintedUrl(null);
    apiFetch<{ url: string; invite: InviteWire }>("POST", "/api/invites", {
      label: trimmed,
      language: language || null,
      memberPrompt: memberPrompt.trim() || null,
      role,
      ...(showRoomPicker && grantRooms.length > 0
        ? { allowedRooms: grantRooms }
        : {}),
    })
      .then((r) => {
        setMintedUrl(r.url);
        setName("");
        setLanguage("");
        setMemberPrompt("");
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
      <p style={{ ...hint, marginBottom: 12 }}>
        {t("settings.invites.changeLater")}
      </p>
      <label htmlFor="invite-member-name" style={subLabel}>
        {t("settings.invites.memberName")}
      </label>
      <input
        id="invite-member-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder={t("settings.invites.memberNamePlaceholder")}
        maxLength={64}
        style={dialogInput}
      />
      <OfficeOwnerCheckbox
        checked={role === "owner"}
        onChange={(checked) => setRole(checked ? "owner" : "member")}
      />
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
                    {...noTranslate()}
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
      <label style={subLabel} htmlFor="invite-language">
        {t("preferences.language")}
      </label>
      <select
        id="invite-language"
        value={language}
        onChange={(e) =>
          setLanguage(e.target.value as SupportedLanguageCode | "")
        }
        style={dialogInput}
      >
        <option value="">{t("settings.invites.browserLanguage")}</option>
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <label style={subLabel} htmlFor="invite-prompt">
        {t("settings.profile.profilePrompt")}
      </label>
      <p style={{ ...hint, marginBottom: 6 }} id="invite-prompt-hint">
        {t("settings.profile.profilePromptExpandedHint")}
      </p>
      <textarea
        aria-describedby="invite-prompt-hint"
        id="invite-prompt"
        value={memberPrompt}
        onChange={(e) => setMemberPrompt(e.target.value)}
        rows={4}
        style={{ ...dialogInput, resize: "vertical" }}
      />
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
          disabled={pending}
          style={{
            ...dialogSaveBtn,
            opacity: pending ? 0.5 : 1,
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
        {...noTranslate()}
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
