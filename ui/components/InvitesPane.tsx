// Owner sign-in links: an invite signs a device in as an EXISTING member.
// Members are created in the Members list first.

import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire } from "../../shared/types.ts";
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

      <SignInLinkForm />

      <h5 style={subsectionHeader}>{t("settings.invites.outstanding")}</h5>
      {renderListSection(i18n, invitesList, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}
    </div>
  );
}

// Owner-only card: mint a sign-in link FOR an existing member, picked from a
// dropdown (POST /api/invites, target by stable userId; the server derives
// name/role and replaces any prior outstanding link for them). The same link
// signs a new member in for the first time or gets a locked-out member back.
function SignInLinkForm() {
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
    apiFetch<{ url: string; invite: InviteWire }>("POST", "/api/invites", {
      userId,
    })
      .then((r) => {
        setMintedUrl(r.url);
        setUserId("");
      })
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : t("settings.invites.createLinkFailed"),
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>{t("settings.invites.linkHint")}</p>
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
            ? t("settings.invites.creatingLink")
            : t("settings.invites.createLink")}
        </button>
      </div>
      {mintedUrl && <MintedUrlBox url={mintedUrl} />}
    </div>
  );
}
