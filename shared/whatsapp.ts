// WhatsApp channel (task d03a61d8): a member links their WhatsApp as a linked
// device, and the server runs one bridge process per linked member
// (server/whatsapp/). These are the wire shapes the Integrations card reads.

// WhatsApp's id among the messaging apps (shared/messaging.ts): the `app` of
// a messaging sender and of a reply draft.
export const WHATSAPP_APP = "whatsapp";

// Why the member's link is not up. A code, never copy: the UI words it.
//   link_expired      - the QR or pairing code was never used
//   install_failed    - the WhatsApp package could not be downloaded
//   unlinked_by_phone - the phone removed the linked device
//   replaced          - another client took over the same session
//   crash_loop        - the bridge kept failing and the server gave up
export type WhatsAppReason =
  | "link_expired"
  | "install_failed"
  | "unlinked_by_phone"
  | "replaced"
  | "crash_loop";

export type WhatsAppStatus =
  | { state: "unlinked"; reason?: WhatsAppReason }
  | {
      state: "linking";
      method: "qr" | "code";
      // The current QR as an SVG document (method qr), or the 8-character
      // code the member types on the phone (method code).
      qrSvg?: string;
      pairingCode?: string;
    }
  | { state: "linked"; phone: string; linkedAt: number; connected: boolean }
  | { state: "dead"; reason: WhatsAppReason; phone?: string };

export type WhatsAppLinkReq =
  | { method: "qr" }
  | { method: "code"; phone: string };

// The phone number a pairing code is requested for: 8 to 15 digits after
// removing spaces, dashes, dots, parentheses and one leading "+". Null when
// the input is not such a number.
export function normaliseWhatsAppPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-.()]/g, "").replace(/^\+/, "");
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
}

// A contact row (task d03a61d8, slice 2): one WhatsApp chat (a contact or a
// group) that reaches one agent the member manages (any agent for an office
// owner, task 0b53ff37). The name is the member's,
// and it is what the agent sees as the sender.
export type WhatsAppRouteTrigger = "mention" | "all";

// Why a row no longer delivers. A code, never copy.
//   agent_gone       - the agent was deleted
//   agent_not_yours  - the agent's manager is not the member, and the member
//                      is not an office owner
//   agent_chat_only  - the agent is at Chat stop, so it cannot reply
export type WhatsAppRouteDead =
  | "agent_gone"
  | "agent_not_yours"
  | "agent_chat_only";

export interface WhatsAppRoute {
  id: string;
  // The chat id: <digits>@s.whatsapp.net, <digits>@lid or <id>@g.us.
  chat: string;
  group: boolean;
  name: string;
  agentId: string;
  // Groups only: which messages reach the agent. Absent for a contact.
  trigger?: WhatsAppRouteTrigger;
  createdAt: number;
  dead?: WhatsAppRouteDead;
  // The agent's replies go out at once, with no Send step (task 70fae82c).
  // Stored only when true; absent means each reply waits for the member.
  sendDirect?: true;
  // Text put before each reply (normaliseWhatsAppPrefix). Absent means no
  // prefix.
  prefix?: string;
  // The member's own messages in the chat reach the agent (task 610f7756).
  // Stored only when true; absent means they go only as context.
  ownMessages?: true;
}

// A chat the linked WhatsApp saw since the link, for the Add picker. Kept in
// memory only.
export interface WhatsAppChatSeen {
  chat: string;
  name: string;
  group: boolean;
}

export type WhatsAppRouteCreateReq =
  | {
      chat: string;
      name: string;
      agentId: string;
      trigger?: WhatsAppRouteTrigger;
      sendDirect?: boolean;
      prefix?: string;
      ownMessages?: boolean;
    }
  // A contact added by number (normaliseWhatsAppPhone).
  | {
      phone: string;
      name: string;
      agentId: string;
      sendDirect?: boolean;
      prefix?: string;
      ownMessages?: boolean;
    };

// sendDirect false, ownMessages false and prefix "" clear the field.
export interface WhatsAppRouteUpdateReq {
  name?: string;
  agentId?: string;
  trigger?: WhatsAppRouteTrigger;
  sendDirect?: boolean;
  prefix?: string;
  ownMessages?: boolean;
}

export const WHATSAPP_ROUTE_NAME_MAX = 60;
export const WHATSAPP_ROUTES_MAX = 50;
export const WHATSAPP_PREFIX_MAX = 40;

// Controls (C0, C1), line and paragraph separators, and bidi overrides.
const UNSAFE_CHARS_RE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

// A row name: 1 to WHATSAPP_ROUTE_NAME_MAX characters after trimming, with no
// control character or line break. The trimmed name, or null.
export function normaliseWhatsAppRouteName(raw: string): string | null {
  // Anywhere: trimming would hide a trailing line break.
  if (UNSAFE_CHARS_RE.test(raw)) return null;
  const name = raw.trim();
  const length = [...name].length;
  if (length === 0 || length > WHATSAPP_ROUTE_NAME_MAX) return null;
  return name;
}

// A row prefix: 0 to WHATSAPP_PREFIX_MAX characters after trimming, with the
// row name's refusals. The trimmed prefix ("" for none), or null.
export function normaliseWhatsAppPrefix(raw: string): string | null {
  if (UNSAFE_CHARS_RE.test(raw)) return null;
  const prefix = raw.trim();
  return [...prefix].length > WHATSAPP_PREFIX_MAX ? null : prefix;
}

// Whether a chat's name holds the name an agent gave in a whatsapp-route
// step (task 0b53ff37): a part of it, in any case, after trimming both.
export function chatNameMatches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length > 0 && name.trim().toLowerCase().includes(q);
}
