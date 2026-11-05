// Messaging apps (task d03a61d8): the apps through which a member's contacts
// write to an agent. Agent-facing names are generic (messaging_reply, page
// `messaging-apps`); the app travels as data, by its id.

// The display name of each app id this release knows. A later release may
// write an id this one does not know (a downgrade): it has no name here.
export const MESSAGING_APP_NAMES: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  discord: "Discord",
};

export function messagingAppName(app: string): string | undefined {
  return Object.hasOwn(MESSAGING_APP_NAMES, app)
    ? MESSAGING_APP_NAMES[app]
    : undefined;
}
