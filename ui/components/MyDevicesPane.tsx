// Settings > You > Sign-in links: the caller's own outstanding device links
// and sessions. It mounts for EVERY role, so the lists are filtered to the
// current user CLIENT-side too: the server scopes them for members, but an
// owner's store holds the office-wide rows. List seeding happens in
// UserSettingsView (useAccessListsSeed).
//
// Settings > You > New device (NewDevicePane, below) mints the links. It rides
// POST /api/invites/self: the server fixes the role to the caller's own, TTL
// to 1 hour, target to the caller's own username, and replaces any prior
// outstanding self-invite.

import { useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { useAppState } from "../store.tsx";
import { apiFetch, ApiError } from "../api.ts";
import type { InviteWire } from "../../shared/types.ts";
import { lowercaseKey } from "../../shared/identity.ts";
import { dialogSaveBtn } from "./dialog-styles.ts";
import { QrImage } from "./QrImage.tsx";
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
} from "./access-shared.tsx";

export function MyDevicesPane() {
  const {
    invitesList,
    invitesLoaded,
    activeSessions,
    activeSessionsLoaded,
    sessionContext,
  } = useAppState();
  const i18n = useI18n();
  const { t } = i18n;

  // Self filters. Sessions key on the stable userId; invites are name-bound
  // (userId isn't stored on invites), so match by the same lowercase key the
  // server uses. For members both are no-ops (already server-scoped).
  const myKey = sessionContext ? lowercaseKey(sessionContext.username) : null;
  // An owner's list also holds expired links an owner can extend (task
  // 1492af52): those belong on the Sign-in links pane, not here.
  const myInvites = invitesList.filter(
    (i) =>
      !i.expired &&
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

      <h5 style={subsectionHeader}>{t("settings.devices.outstandingLinks")}</h5>
      {renderListSection(i18n, myInvites, invitesLoaded, (rows) => (
        <InvitesTable invites={rows} />
      ))}

      <h5 style={subsectionHeader}>{t("settings.devices.activeSessions")}</h5>
      {renderListSection(i18n, mySessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} onBlocked={setBlockedNote} />
      ))}
    </div>
  );
}

// Settings > You > New device: the one click that adds a device. Opening the
// pane mints a sign-in link for one more of the caller's own devices and shows
// it as a QR code and a URL. It mints once per mount: the ref holds through
// StrictMode's second effect run, and re-selecting the open row does not
// remount it. Leaving and coming back mints a new link, which replaces the
// previous one on the server.
export function NewDevicePane() {
  const { t } = useI18n();
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const minted = useRef(false);

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

  useEffect(() => {
    if (minted.current) return;
    minted.current = true;
    generate();
    // Mount only: one link per visit to the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.newDevice")}</h4>
      <p style={hint}>{t("settings.devices.newDeviceHint")}</p>
      <p style={hint}>{t("settings.devices.generateWarning")}</p>
      {pending && <p style={hint}>{t("settings.devices.generating")}</p>}
      {mintedUrl && (
        <div style={{ marginTop: 10 }}>
          <QrImage
            svg={renderSVG(mintedUrl)}
            alt={t("settings.devices.qrAlt")}
            data-device-qr=""
          />
          <MintedUrlBox url={mintedUrl} forSelf />
        </div>
      )}
      {error && (
        <>
          <p
            style={{
              fontSize: 11,
              color: "var(--red-text)",
              margin: "6px 0 0",
            }}
          >
            {error}
          </p>
          <button
            onClick={generate}
            style={{ ...dialogSaveBtn, marginTop: 10 }}
          >
            {t("settings.devices.retry")}
          </button>
        </>
      )}
    </div>
  );
}
