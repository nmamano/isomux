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

// An agent's reply to its route (POST /api/messaging/routes/:routeId/
// messages). channelId and replyTo are Discord's: the channel or thread it
// goes to, and the message it answers.
export interface MessagingReplyReq {
  text: string;
  channelId?: string;
  replyTo?: string;
}

// A draft that waits for the member, or the message sent (messageId on
// Discord).
export type MessagingReplyAccepted =
  | { askId: string; status: "waiting_for_member" }
  | { status: "sent"; messageId?: string };
