// Owner-only "Sessions" section: every signed-in device across the office,
// with revoke controls. Mounts on the User Settings page (UserSettingsView)
// when the current session's role is "owner". One of the three panes the old
// all-in-one "Access & invites" section was split into (task 07514e7f) — see
// also ExternalAccessPane and InvitesPane.

import { useState } from "react";
import { useAppState } from "../store.tsx";
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
  // Holds the most recent server-side lockout-prevention rejection (a 409
  // from sessions.revoke, surfaced by SessionsTable) so the banner stays
  // visible until the user dismisses or retries. Auto-cleared on any
  // successful revoke (the sessions list shrinking).
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  useAutoClearBlockedNote(setBlockedNote);

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={sectionHeader}>Sessions</h4>
      <p style={hint}>
        Devices signed into this office, across all users. Revoking a session
        signs that device out; it can come back only via a fresh invite or
        device link.
      </p>

      {blockedNote && (
        <BlockedNoteBanner
          note={blockedNote}
          onDismiss={() => setBlockedNote(null)}
        />
      )}

      {renderListSection(activeSessions, activeSessionsLoaded, (rows) => (
        <SessionsTable sessions={rows} onBlocked={setBlockedNote} />
      ))}
    </div>
  );
}
