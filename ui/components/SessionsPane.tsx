// Owner-only "Sessions" section: every signed-in device across the office,
// with revoke controls. Mounts on the Settings page (UserSettingsView)
// when the current session's role is "owner". The other panes from the old
// all-in-one "Access & invites" section are ExternalAccessPane and InvitesPane.

import { useState } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import {
  SessionsTable,
  BlockedNoteBanner,
  renderListSection,
  useAutoClearBlockedNote,
  sectionHeader,
  hint,
} from "./access-shared.tsx";

export function SessionsPane() {
  const { activeSessions, activeSessionsLoaded } = useAppState();
  const i18n = useI18n();
  const { t, rich } = i18n;
  // Holds the most recent server-side lockout-prevention rejection (a 409
  // from sessions.revoke, surfaced by SessionsTable) so the banner stays
  // visible until the user dismisses or retries. Auto-cleared on any
  // successful revoke (the sessions list shrinking).
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  useAutoClearBlockedNote(setBlockedNote);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>{t("settings.sidebar.sessions")}</h4>
      {/* Owners looking to ADD a device tend to land here
          (it's where devices are listed) - point them at the two flows that
          actually mint links. */}
      <p style={hint}>
        {rich("settings.sessions.intro", {
          i: (chunk) => <i>{chunk}</i>,
        })}
      </p>

      {blockedNote && (
        <BlockedNoteBanner
          note={blockedNote}
          onDismiss={() => setBlockedNote(null)}
        />
      )}

      {renderListSection(i18n, activeSessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} onBlocked={setBlockedNote} />
      ))}
    </div>
  );
}
