// Owner sign-in links: an invite signs a device in as an EXISTING member.
// Members are created in the Members list first.

import { useMemo, useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire, UserRecord } from "../../shared/types.ts";
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

// Mints a member's sign-in link (POST /api/invites, target by stable userId;
// the server derives name/role and replaces any prior outstanding link for
// them). Shared by the Invites card and the button on a pending member's page.
export function useMintSignInLink() {
  const { t } = useI18n();
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function mint(userId: string, onMinted?: () => void) {
    if (pending) return;
    setPending(true);
    setError(null);
    setMintedUrl(null);
    apiFetch<{ url: string; invite: InviteWire }>("POST", "/api/invites", {
      userId,
    })
      .then((r) => {
        setMintedUrl(r.url);
        onMinted?.();
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

  return { mint, mintedUrl, error, setError, pending };
}

// Owner-only card: mint a sign-in link FOR an existing member, picked from a
// dropdown. The same link signs a new member in for the first time or gets a
// locked-out member back.
function SignInLinkForm() {
  const { users } = useAppState();
  const { t } = useI18n();
  const [userId, setUserId] = useState("");
  const { mint, mintedUrl, error, setError, pending } = useMintSignInLink();
  const userList = useMemo(
    () => [...users.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );

  function submit() {
    if (!userId) return;
    mint(userId, () => setUserId(""));
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
        <p
          style={{ fontSize: 11, color: "var(--red-text)", margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          onClick={submit}
          disabled={pending || !userId}
          style={{
            ...dialogSaveBtn,
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

// On an owner's view of a member who has not signed in yet (right after the
// create, too): the next step, their sign-in link, minted in place. Hidden
// while an unused link for them is out, since a new one would replace the link
// the owner already sent. Once minted, the URL stays until the page closes,
// though the invites_list broadcast now lists that link.
export function PendingMemberSignInLink({ user }: { user: UserRecord }) {
  const { invitesList, invitesLoaded } = useAppState();
  const { t } = useI18n();
  const { mint, mintedUrl, error, pending } = useMintSignInLink();
  // The time the page opened: a link that expires while it stays open
  // shows the button on the next visit.
  const [now] = useState(() => Date.now());
  const linkOut = invitesList.some(
    (i) => i.username === user.name && i.expiresAt > now,
  );
  if (!mintedUrl && (!user.pendingSignIn || linkOut)) return null;
  // Until the invites list loads, the button holds its place, disabled.
  const disabled = pending || !invitesLoaded;

  return (
    <div data-member-sign-in-link="" style={{ marginTop: 14 }}>
      {mintedUrl ? (
        <MintedUrlBox url={mintedUrl} sendTo={user.name} />
      ) : (
        <button
          data-member-sign-in-link-create=""
          onClick={() => mint(user.id)}
          disabled={disabled}
          style={dialogSaveBtn}
        >
          {pending
            ? t("settings.invites.creatingLink")
            : t("settings.members.signInLink.create", { name: user.name })}
        </button>
      )}
      {error && (
        <p
          style={{ fontSize: 11, color: "var(--red-text)", margin: "6px 0 0" }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
