// The stdio protocol between the server and a WhatsApp bridge child
// (server/whatsapp/bridge.ts): one JSON object per line, commands on the
// child's stdin, events on its stdout.

export type BridgeCommand =
  // The routed chats. A bridge connects only after the first one (an empty
  // list counts), and passes on messages from these chats only.
  | { op: "routes"; chats: string[] }
  | { op: "link"; method: "qr" }
  | { op: "link"; method: "code"; phone: string }
  | { op: "logout" }
  | { op: "stop" }
  // An approved reply (slice 2b). requestId is the ask id: the bridge keeps
  // the ids it sent for its life, so a retry with the same id answers with
  // the first message id and sends nothing.
  | { op: "send"; requestId: string; chat: string; text: string };

export type BridgeEvent =
  | { ev: "qr"; code: string }
  | { ev: "pairing-code"; code: string }
  // The phone accepted the link and the credentials are saved.
  | { ev: "linked"; phone: string }
  | { ev: "open" }
  // Baileys' disconnect status code (DISCONNECT below), null when it gave none.
  | { ev: "closed"; statusCode: number | null }
  // A redacted status line for the server log.
  | { ev: "log"; text: string }
  // A chat seen since the link, for the Add picker: the member's saved name
  // or the group subject, never the contact's own WhatsApp name. No text.
  | { ev: "chat"; chat: string; name: string; group: boolean }
  // The answer to a send: the WhatsApp message id, or a failure.
  | { ev: "sent"; requestId: string; id: string }
  | { ev: "send-failed"; requestId: string }
  | BridgeMessage;

// A text message in a routed chat. sender is the participant in a group and
// the chat otherwise; senderName is the member's saved name for it, or null.
// senderPhone is its number when WhatsApp gives one (null for a LID-only
// participant). mentionsMe: it mentions the linked account. quotedId: the
// message it replies to.
export interface BridgeMessage {
  ev: "message";
  id: string;
  chat: string;
  group: boolean;
  ts: number;
  fromMe: boolean;
  sender: string;
  senderName: string | null;
  senderPhone: string | null;
  text: string;
  mentionsMe: boolean;
  quotedId: string | null;
}

// The Baileys DisconnectReason codes the supervisor acts on.
export const DISCONNECT = {
  loggedOut: 401,
  timedOut: 408,
  connectionReplaced: 440,
  restartRequired: 515,
} as const;

export function encodeCommand(cmd: BridgeCommand): string {
  return JSON.stringify(cmd) + "\n";
}

// One stdout line to an event; null for a line that is not a valid event.
export function parseBridgeEvent(line: string): BridgeEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  switch (e.ev) {
    case "qr":
    case "pairing-code":
      return typeof e.code === "string" ? { ev: e.ev, code: e.code } : null;
    case "linked":
      return typeof e.phone === "string"
        ? { ev: "linked", phone: e.phone }
        : null;
    case "open":
      return { ev: "open" };
    case "closed":
      return e.statusCode === null || typeof e.statusCode === "number"
        ? { ev: "closed", statusCode: e.statusCode }
        : null;
    case "log":
      return typeof e.text === "string" ? { ev: "log", text: e.text } : null;
    case "chat":
      return typeof e.chat === "string" &&
        typeof e.name === "string" &&
        typeof e.group === "boolean"
        ? { ev: "chat", chat: e.chat, name: e.name, group: e.group }
        : null;
    case "sent":
      return typeof e.requestId === "string" && typeof e.id === "string"
        ? { ev: "sent", requestId: e.requestId, id: e.id }
        : null;
    case "send-failed":
      return typeof e.requestId === "string"
        ? { ev: "send-failed", requestId: e.requestId }
        : null;
    case "message":
      return parseMessage(e);
    default:
      return null;
  }
}

const isStringOrNull = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

// Only the known fields: a contact's own WhatsApp name (pushName) or any
// other field the bridge might add never passes.
function parseMessage(e: Record<string, unknown>): BridgeMessage | null {
  const { id, chat, group, ts, fromMe, sender, senderName, senderPhone } = e;
  const { text, mentionsMe, quotedId } = e;
  if (
    typeof id !== "string" ||
    typeof chat !== "string" ||
    typeof group !== "boolean" ||
    typeof ts !== "number" ||
    typeof fromMe !== "boolean" ||
    typeof sender !== "string" ||
    !isStringOrNull(senderName) ||
    !isStringOrNull(senderPhone) ||
    typeof text !== "string" ||
    typeof mentionsMe !== "boolean" ||
    !isStringOrNull(quotedId)
  )
    return null;
  return {
    ev: "message",
    id,
    chat,
    group,
    ts,
    fromMe,
    sender,
    senderName,
    senderPhone,
    text,
    mentionsMe,
    quotedId,
  };
}
