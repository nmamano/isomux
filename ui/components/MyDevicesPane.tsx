// Self-scoped "My devices" pane: device links + the caller's own outstanding
// invites and sessions, small enough to stay ONE sidebar entry. Since the
// eb3354e6 revision it mounts for EVERY role (device links are self-service;
// owners cannot mint them for others), so the lists are filtered to the
// current user CLIENT-side too: the server scopes them for members, but an
// owner's store holds the office-wide rows. The generate button rides
// POST /api/invites/self (the server fixes the role to the caller's own,
// TTL to 1 hour, target to the caller's own username, and replaces any
// prior outstanding self-invite). List seeding happens in UserSettingsView
// (useAccessListsSeed).

import { useState } from "react";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire } from "../../shared/types.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import { dialogSaveBtn } from "./dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import {
  InvitesTable,
  SessionsTable,
  MintedUrlBox,
  BlockedNoteBanner,
  renderListSection,
  useAutoClearBlockedNote,
  sectionHeader,
  subsectionHeader,
  hint,
  cardStyle,
} from "./access-shared.tsx";

export function MyDevicesPane() {
  const {
    invitesList,
    invitesLoaded,
    activeSessions,
    activeSessionsLoaded,
    sessionContext,
  } = useAppState();
  const { t } = useI18n();

  // Self filters. Sessions key on the stable userId; invites are name-bound
  // (userId isn't stored on invites), so match by the same lowercase key the
  // server uses. For members both are no-ops (already server-scoped).
  const myKey = sessionContext ? lowercaseKey(sessionContext.username) : null;
  const myInvites = invitesList.filter(
    (i) =>
      i.username !== null &&
      myKey !== null &&
      lowercaseKey(i.username) === myKey,
  );
  const mySessions = activeSessions.filter(
    (s) => s.userId === sessionContext?.userId,
  );

  // Server-side lockout-prevention rejections (a 409 from sessions.revoke,
  // surfaced by SessionsTable's onBlocked) are owner-relevant in practice (a
  // member's session can't be the office's last owner session), but the banner
  // is wired in case a future role-change races a revoke.
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  useAutoClearBlockedNote(setBlockedNote);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.devices.title")}</h4>

      {blockedNote && (
        <BlockedNoteBanner
          note={blockedNote}
          onDismiss={() => setBlockedNote(null)}
        />
      )}

      <GenerateDeviceLinkForm />

      <h5 style={subsectionHeader}>{t("settings.devices.outstandingLinks")}</h5>
      {renderListSection(myInvites, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}

      <h5 style={subsectionHeader}>{t("settings.devices.activeSessions")}</h5>
      {renderListSection(mySessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} onBlocked={setBlockedNote} />
      ))}
    </div>
  );
}

function GenerateDeviceLinkForm() {
  const { t } = useI18n();
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
            : t("settings.devices.generateFailed"),
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <div style={cardStyle}>
      <p style={{ ...hint, marginTop: 0 }}>
        {t("settings.devices.generateHint")}
      </p>
      <p style={hint}>{t("settings.devices.generateWarning")}</p>
      <button
        onClick={generate}
        disabled={pending}
        style={{ ...dialogSaveBtn, marginTop: 10, opacity: pending ? 0.5 : 1 }}
      >
        {pending
          ? t("settings.devices.generating")
          : t("settings.devices.generate")}
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
