// The Isomux WhatsApp bridge (task d03a61d8): one process per linked member,
// started by server/whatsapp/supervisor.ts as
//   bun bridge.ts <memberDir> <runtimeDir>
// It links the member's WhatsApp as a linked device through Baileys, loaded
// from <runtimeDir> (the package the server downloads on the first link), and
// speaks the stdio protocol of server/whatsapp/protocol.ts: one JSON object
// per line, commands on stdin, events on stdout.
//
// This directory has its own license (LICENSE) and this is the only file that
// loads Baileys. It imports nothing from the rest of Isomux.
//
// What it writes to stdout is all the server sees: no message text and no
// contact number goes into a log line. Of a chat that is not routed, only its
// id, its name and the time of its messages leave this process.

import { randomBytes } from "crypto";
import { createInterface } from "readline";
import { join } from "path";

type Command =
  | { op: "routes"; chats: string[] }
  | { op: "link"; method: "qr" }
  | { op: "link"; method: "code"; phone: string }
  | { op: "logout" }
  | { op: "stop" }
  | { op: "send"; requestId: string; chat: string; text: string };

type Event =
  | { ev: "qr"; code: string }
  | { ev: "pairing-code"; code: string }
  | { ev: "linked"; phone: string }
  | { ev: "open" }
  | { ev: "closed"; statusCode: number | null }
  | { ev: "log"; text: string }
  | { ev: "chat"; chat: string; name: string; group: boolean }
  | { ev: "activity"; chat: string; at: number }
  | { ev: "sent"; requestId: string; id: string }
  | { ev: "send-failed"; requestId: string }
  | {
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
    };

// The parts of Baileys this file uses.
interface Creds {
  me?: { id: string; lid?: string };
  // Set by pair-success only. A pairing code request sets me before the
  // phone has accepted anything.
  account?: unknown;
  advSecretKey: string;
}
interface AuthState {
  creds: Creds;
  keys: unknown;
}
interface Contact {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  // The name the member saved. notify is the contact's own name: never used.
  name?: string;
}
interface MessageKey {
  id?: string | null;
  remoteJid?: string | null;
  remoteJidAlt?: string;
  fromMe?: boolean | null;
  participant?: string | null;
  participantAlt?: string;
}
interface ContextInfo {
  stanzaId?: string | null;
  mentionedJid?: string[] | null;
}
interface MessageContent {
  conversation?: string | null;
  extendedTextMessage?: {
    text?: string | null;
    contextInfo?: ContextInfo | null;
  } | null;
}
interface WAMessage {
  key: MessageKey;
  message?: MessageContent | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}
interface Group {
  id: string;
  subject?: string;
}
interface ConnectionUpdate {
  connection?: "open" | "connecting" | "close";
  qr?: string;
  lastDisconnect?: {
    error?: { message?: string; output?: { statusCode?: number } };
  };
}
interface BinaryNode {
  tag: string;
  attrs: Record<string, string>;
  content?: unknown;
}
type WAVersion = [number, number, number];
interface Socket {
  // The raw stanzas, by "CB:<tag>,<attr>:<value>".
  ws: { on(event: string, fn: (node: BinaryNode) => void): void };
  ev: {
    on(event: "creds.update", fn: () => void): void;
    on(event: "connection.update", fn: (u: ConnectionUpdate) => void): void;
    on(
      event: "contacts.upsert" | "contacts.update",
      fn: (c: Contact[]) => void,
    ): void;
    on(
      event: "groups.upsert" | "groups.update",
      fn: (g: Partial<Group>[]) => void,
    ): void;
    on(
      event: "messages.upsert",
      fn: (u: { messages: WAMessage[] }) => void,
    ): void;
  };
  signalRepository: {
    lidMapping: { getPNForLID(lid: string): Promise<string | null> };
  };
  groupFetchAllParticipating(): Promise<Record<string, Group>>;
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key: MessageKey } | undefined>;
  requestPairingCode(phone: string): Promise<string>;
  logout(): Promise<void>;
  end(error: Error | undefined): void;
}
interface Baileys {
  default: (config: Record<string, unknown>) => Socket;
  useMultiFileAuthState(
    dir: string,
  ): Promise<{ state: AuthState; saveCreds: () => Promise<void> }>;
  Browsers: { ubuntu(name: string): [string, string, string] };
  fetchLatestWaWebVersion(options: {
    signal?: AbortSignal;
  }): Promise<{ version: WAVersion; isLatest: boolean }>;
  normalizeMessageContent(
    m: MessageContent | null | undefined,
  ): MessageContent | undefined;
  jidNormalizedUser(jid: string | undefined): string;
  // A message that counts as chat activity: not a protocol message, a
  // reaction or a poll vote.
  isRealMessage(m: WAMessage): boolean;
  areJidsSameUser(a: string | undefined, b: string | undefined): boolean;
}

const [memberDir, runtimeDir] = process.argv.slice(2);
if (!memberDir || !runtimeDir) {
  process.stderr.write("usage: bridge.ts <memberDir> <runtimeDir>\n");
  process.exit(2);
}
// Credentials are readable by the office user only.
process.umask(0o077);

function send(event: Event): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function log(text: string): void {
  send({ ev: "log", text });
}

// An error's own text for a log line, without any number long enough to be
// a phone number or a chat id.
function reason(err: unknown): string {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String(err.message)
        : String(err);
  return text.replace(/\d{6,}/g, "#").slice(0, 120);
}

function exit(code: number): void {
  // Let stdout drain before the process ends.
  process.stdout.write("", () => process.exit(code));
}

// Baileys logs through pino; nothing it logs leaves this process.
const silent = {
  level: "silent",
  child() {
    return silent;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

const baileys = (await import(
  Bun.resolveSync("baileys", runtimeDir)
)) as Baileys;
const { state, saveCreds } = await baileys.useMultiFileAuthState(
  join(memberDir, "auth"),
);

// "447700900123:12@s.whatsapp.net" -> "447700900123"
const phoneOf = (jid: string) => jid.split("@")[0].split(":")[0];

// Set in start(); the cast keeps tsc from narrowing it to null below.
let sock = null as Socket | null;
let announced = false;

// The account once pairing succeeded: sent once per process. A pairing code
// request sets creds.me before the phone accepted the code, so only the
// account that pair-success saves counts.
function announceLinked(): void {
  if (announced || !state.creds.me || !state.creds.account) return;
  announced = true;
  send({ ev: "linked", phone: phoneOf(state.creds.me.id) });
}
let link: Extract<Command, { op: "link" }> | null = null;
let ending = false;
let open = false;

// The routed chats, from the server's routes commands. Nothing connects
// before the first one, and only messages from these chats leave this
// process.
let allow: Set<string> | null = null;
let startWanted = false;

// The member's saved names, by chat id (PN and LID forms), and the group
// subjects. The contact's own WhatsApp name (pushName, notify) is never kept.
const names = new Map<string, string>();
const announcedChats = new Map<string, string>();
// The replies sent, by request id (the ask id), for this process's life: a
// retry of a send that went out answers with its message id and sends
// nothing. A restart loses this; the server keeps its own record of the asks
// whose reply went out, so only a send cut by the restart can go twice.
const sends = new Map<string, Promise<string | null>>();

function sendReply(cmd: Extract<Command, { op: "send" }>): void {
  let pending = sends.get(cmd.requestId);
  if (!pending) {
    const s = sock;
    // Only to a routed chat, and only on an open connection.
    if (!s || !open || !allow?.has(cmd.chat)) {
      send({ ev: "send-failed", requestId: cmd.requestId });
      return;
    }
    pending = s
      .sendMessage(cmd.chat, { text: cmd.text })
      .then((m) => m?.key.id ?? null)
      .catch(() => null);
    sends.set(cmd.requestId, pending);
  }
  const requestId = cmd.requestId;
  void pending.then((id) => {
    if (id) send({ ev: "sent", requestId, id });
    else {
      // A failure is not a send: the next try goes out.
      sends.delete(requestId);
      send({ ev: "send-failed", requestId });
    }
  });
}

// The messages in arrival order.
let reading: Promise<void> = Promise.resolve();

function announceChat(chat: string, name: string, group: boolean): void {
  if (announcedChats.get(chat) === name) return;
  announcedChats.set(chat, name);
  send({ ev: "chat", chat, name, group });
}

function onContacts(contacts: Contact[]): void {
  for (const c of contacts) {
    if (!c.name) continue;
    const ids = [c.id, c.lid, c.phoneNumber].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    for (const id of ids) names.set(baileys.jidNormalizedUser(id), c.name);
    const pn = ids.find((id) => id.endsWith("@s.whatsapp.net"));
    const chat = pn ?? ids[0];
    if (chat) announceChat(baileys.jidNormalizedUser(chat), c.name, false);
  }
}

function onGroups(groups: Partial<Group>[]): void {
  for (const g of groups) {
    if (!g.id || !g.subject) continue;
    names.set(g.id, g.subject);
    announceChat(g.id, g.subject, true);
  }
}

// A LID ("<digits>@lid") to its PN form when WhatsApp told us; else null.
async function pnOf(
  jid: string,
  alt: string | undefined,
  s: Socket,
): Promise<string | null> {
  if (jid.endsWith("@s.whatsapp.net")) return jid;
  if (alt?.endsWith("@s.whatsapp.net")) return baileys.jidNormalizedUser(alt);
  if (!jid.endsWith("@lid")) return null;
  try {
    const pn = await s.signalRepository.lidMapping.getPNForLID(jid);
    return pn ? baileys.jidNormalizedUser(pn) : null;
  } catch {
    return null;
  }
}

const timestampMs = (t: WAMessage["messageTimestamp"]): number => {
  if (typeof t === "number") return t * 1000;
  if (t && typeof t.toNumber === "function") return t.toNumber() * 1000;
  return Date.now();
};

async function onMessage(m: WAMessage, s: Socket): Promise<void> {
  const key = m.key;
  const raw = key.remoteJid;
  if (!key.id || !raw || !allow) return;
  const group = raw.endsWith("@g.us");
  let chat = baileys.jidNormalizedUser(raw);
  let pn: string | null = null;
  if (!group) {
    if (!chat.endsWith("@s.whatsapp.net") && !chat.endsWith("@lid")) return;
    pn = await pnOf(chat, key.remoteJidAlt, s);
  }
  // The Add picker's order: the time of each message, routed or not, under
  // each form of the chat's id (the picker lists a contact under either).
  if (baileys.isRealMessage(m)) {
    const at = timestampMs(m.messageTimestamp);
    for (const id of new Set([chat, pn ?? chat]))
      send({ ev: "activity", chat: id, at });
  }
  if (!group) {
    // A row may hold either form of a contact's id; the PN form wins.
    if (pn && !allow.has(chat)) chat = pn;
    // A contact with no saved name shows as its number.
    if (pn && !names.has(pn) && !names.has(chat))
      announceChat(pn, phoneOf(pn), false);
  }
  if (!allow.has(chat)) return;

  const content = baileys.normalizeMessageContent(m.message);
  const text =
    content?.conversation ?? content?.extendedTextMessage?.text ?? null;
  if (typeof text !== "string" || text.length === 0) return;
  const context = content?.extendedTextMessage?.contextInfo ?? null;

  const fromMe = key.fromMe === true;
  const me = state.creds.me;
  // Every id the sender is known by, for the saved-name lookup.
  let ids: string[];
  let senderPhone: string | null;
  if (fromMe && me) {
    ids = [baileys.jidNormalizedUser(me.id)];
    senderPhone = phoneOf(me.id);
  } else {
    const who = group ? key.participant : chat;
    if (!who) return;
    const id = baileys.jidNormalizedUser(who);
    const alt = group ? key.participantAlt : key.remoteJidAlt;
    const pn = await pnOf(id, alt, s);
    ids = group && pn ? [pn, id] : [id, ...(pn ? [pn] : [])];
    senderPhone = pn ? phoneOf(pn) : null;
  }
  const sender = ids[0];
  const senderName =
    ids.map((id) => names.get(id)).find((n) => n !== undefined) ?? null;
  const mentioned = context?.mentionedJid ?? [];
  const mentionsMe =
    !!me &&
    mentioned.some(
      (j) =>
        baileys.areJidsSameUser(j, me.id) ||
        (!!me.lid && baileys.areJidsSameUser(j, me.lid)),
    );
  send({
    ev: "message",
    id: key.id,
    chat,
    group,
    ts: timestampMs(m.messageTimestamp),
    fromMe,
    sender,
    senderName,
    senderPhone,
    text,
    mentionsMe,
    quotedId: context?.stanzaId ?? null,
  });
}

// WhatsApp refuses to link a device that reports an old WA Web version
// (Baileys issue #2679), and the version Baileys bundles goes stale between
// its releases: the current one comes from web.whatsapp.com.
const VERSION_TIMEOUT_MS = 10_000;
async function waVersion(): Promise<WAVersion | undefined> {
  try {
    const got = await baileys.fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    });
    if (got.isLatest) {
      log(`WA Web version ${got.version.join(".")}`);
      return got.version;
    }
  } catch {
    // The bundled version below.
  }
  log("the current WA Web version was not read: Baileys' bundled one is used");
  return undefined;
}

// The QR text is "<link>#<ref>,<noise key>,<identity key>,<adv secret>,
// <platform>". Baileys builds every QR of a flow with the adv secret of the
// flow's start, so each one gets the current secret here.
function withCurrentSecret(qr: string): string {
  const hash = qr.indexOf("#");
  const parts = qr.slice(hash + 1).split(",");
  if (hash < 0 || parts.length < 4) return qr;
  parts[3] = state.creds.advSecretKey;
  return qr.slice(0, hash + 1) + parts.join(",");
}

// The two children WA Web accepts on a companion_reg_refresh notification.
const REFRESH_CHILDREN = ["companion_reg_refresh", "pair-device-rotate-qr"];
const CODE_TIMEOUT_MS = 30_000;

async function start(): Promise<void> {
  const version = await waVersion();
  const socket = baileys.default({
    auth: state,
    logger: silent,
    ...(version ? { version } : {}),
    browser: baileys.Browsers.ubuntu("Isomux"),
    // Online presence would stop the phone's push notifications.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  sock = socket;
  let codeAsked = false;
  // The last QR Baileys made, to send again with a new secret.
  let lastQr: string | null = null;

  // Since 2026-07 WhatsApp retires the adv secret of an unpaired device
  // after the QR scan, with this notification. Baileys 7.0.0-rc14 acks it
  // and keeps the old secret, so the phone refuses the link (Baileys issue
  // #2737). As WA Web does (Baileys PR #2765): a new 32-byte secret, saved,
  // and the QR on screen sent again with it. A device with an account, or a
  // pending pairing code, keeps its secret: its pairing is checked against it.
  socket.ws.on("CB:notification,type:companion_reg_refresh", (node) => {
    try {
      if (state.creds.me) return;
      const children = Array.isArray(node.content)
        ? (node.content as BinaryNode[])
        : [];
      if (!children.some((c) => REFRESH_CHILDREN.includes(c?.tag))) {
        log("a pairing refresh from WhatsApp was not understood");
        return;
      }
      state.creds.advSecretKey = randomBytes(32).toString("base64");
      void saveCreds().catch(() => log("the credentials were not saved"));
      log("WhatsApp renewed the pairing secret");
      if (lastQr && link?.method === "qr")
        send({ ev: "qr", code: withCurrentSecret(lastQr) });
    } catch (err) {
      log(`the pairing refresh failed: ${reason(err)}`);
    }
  });

  socket.ev.on("creds.update", () => {
    // Pairing succeeded once the account is in the saved credentials.
    void saveCreds().then(announceLinked, () =>
      send({ ev: "log", text: "the credentials were not saved" }),
    );
  });

  socket.ev.on("contacts.upsert", onContacts);
  socket.ev.on("contacts.update", (c) => onContacts(c));
  socket.ev.on("groups.upsert", onGroups);
  socket.ev.on("groups.update", onGroups);
  // Live and offline messages; the history sync (messaging-history.set) is
  // not read.
  socket.ev.on("messages.upsert", ({ messages }) => {
    // One at a time: a LID lookup must not let a later message leave first.
    for (const m of messages)
      reading = reading
        .then(() => onMessage(m, socket))
        .catch(() => send({ ev: "log", text: "a message was not read" }));
  });

  socket.ev.on("connection.update", (u) => {
    if (u.qr && link?.op === "link") {
      lastQr = u.qr;
      if (link.method === "qr")
        send({ ev: "qr", code: withCurrentSecret(u.qr) });
      else if (!codeAsked) {
        codeAsked = true;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) log("the pairing code request got no answer");
        }, CODE_TIMEOUT_MS);
        socket
          .requestPairingCode(link.phone)
          .then((code) => {
            send({ ev: "pairing-code", code });
            log("pairing code shown");
          })
          .catch((err) =>
            log(`the pairing code request failed: ${reason(err)}`),
          )
          .finally(() => {
            settled = true;
            clearTimeout(timer);
          });
      }
    }
    if (u.connection === "open") {
      open = true;
      announceLinked();
      send({ ev: "open" });
      send({ ev: "log", text: "connection open" });
      // The group subjects, for the Add picker.
      socket
        .groupFetchAllParticipating()
        .then((groups) => onGroups(Object.values(groups)))
        .catch(() => send({ ev: "log", text: "the groups were not read" }));
    }
    if (u.connection === "close") {
      open = false;
      const statusCode = u.lastDisconnect?.error?.output?.statusCode ?? null;
      const why = u.lastDisconnect?.error;
      log(
        `connection closed (${statusCode ?? "no code"}${why ? `: ${reason(why)}` : ""})`,
      );
      if (!ending) send({ ev: "closed", statusCode });
      exit(0);
    }
  });
}

// A linked member connects once the first routes command arrived; a new
// link waits for its method too.
let starting = false;
function maybeStart(): void {
  if (starting || !allow || !startWanted) return;
  starting = true;
  start().catch((err) => {
    log(`the connection did not start: ${reason(err)}`);
    exit(1);
  });
}
if (state.creds.me) startWanted = true;

for await (const line of createInterface({ input: process.stdin })) {
  let cmd: Command;
  try {
    cmd = JSON.parse(line) as Command;
  } catch {
    continue;
  }
  if (cmd.op === "routes") {
    if (!Array.isArray(cmd.chats)) continue;
    allow = new Set(cmd.chats.filter((c) => typeof c === "string"));
    maybeStart();
  } else if (cmd.op === "link") {
    if (starting) continue;
    link = cmd;
    startWanted = true;
    maybeStart();
  } else if (cmd.op === "send") {
    if (
      typeof cmd.requestId === "string" &&
      typeof cmd.chat === "string" &&
      typeof cmd.text === "string"
    )
      sendReply(cmd);
  } else if (cmd.op === "logout") {
    if (!sock) exit(0);
    else {
      // The close that follows reports loggedOut and ends the process.
      sock.logout().catch(() => exit(0));
      setTimeout(() => exit(0), 3_000);
    }
  } else if (cmd.op === "stop") {
    ending = true;
    sock?.end(undefined);
    exit(0);
  }
}
// The server closed stdin: it is gone.
ending = true;
sock?.end(undefined);
exit(0);
