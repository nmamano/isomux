// The bridge process against a fake Baileys package: the link steps that
// broke against WhatsApp in 2026-11 (Baileys issues #2679 and #2737, and the
// pairing code that announced a link before the phone accepted it).

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const BRIDGE = join(import.meta.dir, "bridge", "bridge.ts");
const root = mkdtempSync(join(tmpdir(), "wa-bridge-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The scenario comes from the member dir's scenario.json; what the fake sees
// goes to seen.json there.
const FAKE = `
import { EventEmitter } from "events";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
let dir;
const seen = { saved: [], version: "none", done: false };
const note = () => writeFileSync(join(dir, "seen.json"), JSON.stringify(seen));
const sc = () => JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const creds = { advSecretKey: "OLD" };
export async function useMultiFileAuthState(d) {
  dir = d.replace(/\\/auth$/, "");
  return { state: { creds, keys: {} }, saveCreds: async () => { seen.saved.push(creds.advSecretKey); note(); } };
}
export async function fetchLatestWaWebVersion() {
  const s = sc();
  if (s.versionThrows) throw new Error("offline");
  return { version: [2, 3000, 999], isLatest: s.versionLatest };
}
export const Browsers = { ubuntu: (n) => ["Ubuntu", n, "1"] };
export const jidNormalizedUser = (j) => j;
// As Baileys: the user part only, without the device or the server.
const userOf = (j) => (typeof j === "string" ? j.split("@")[0].split(":")[0].split("_")[0] : undefined);
export const areJidsSameUser = (a, b) => userOf(a) === userOf(b);
export const normalizeMessageContent = (m) => m;
// As Baileys: content, and not a protocol message, a reaction or a poll vote.
export const isRealMessage = (m) => !!m.message && !m.message.protocolMessage && !m.message.reactionMessage && !m.message.pollUpdateMessage;
const qr = (ref) => "https://wa.me/settings/linked_devices#" + ref + ",NOISE,IDENT,OLD,1";
export default function makeSocket(config) {
  seen.version = config.version ?? "none";
  note();
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  const s = sc();
  const steps = {
    qr1: () => ev.emit("connection.update", { qr: qr("REF1") }),
    qr2: () => ev.emit("connection.update", { qr: qr("REF2") }),
    refresh: () => ws.emit("CB:notification,type:companion_reg_refresh", { tag: "notification", attrs: {}, content: [{ tag: "companion_reg_refresh", attrs: {} }] }),
    oddRefresh: () => ws.emit("CB:notification,type:companion_reg_refresh", { tag: "notification", attrs: {}, content: [{ tag: "other", attrs: {} }] }),
    paired: () => { creds.me = { id: "447700900123:4@s.whatsapp.net" }; creds.account = {}; ev.emit("creds.update", creds); },
    messages: () => ev.emit("messages.upsert", { messages: s.messages, type: "notify" }),
    // The linked account, as a linked device sees itself: a device suffix on
    // both forms of its id.
    me: () => { creds.me = { id: "447700900123:4@s.whatsapp.net", lid: "999:4@lid" }; },
    contacts: () => ev.emit("contacts.upsert", s.contacts),
    close: () => ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { message: "QR refs attempts ended", output: { statusCode: 408 } } } }),
  };
  let i = 0;
  // done once the last step's work had a moment to settle.
  const next = () => {
    if (i < s.steps.length) { steps[s.steps[i++]](); setTimeout(next, 20); }
    else setTimeout(() => { seen.done = true; note(); }, 50);
  };
  setTimeout(next, 20);
  return {
    ws, ev,
    signalRepository: { lidMapping: { getPNForLID: async (lid) => (s.lids ?? {})[lid] ?? null } },
    groupFetchAllParticipating: async () => ({}),
    sendMessage: async () => undefined,
    async requestPairingCode(phone) {
      creds.me = { id: phone + "@s.whatsapp.net", name: "~" };
      ev.emit("creds.update", creds);
      if (s.codeFails) throw new Error("bad request 4000000000000");
      return "ABCD1234";
    },
    logout: async () => {},
    end: () => {},
  };
}
`;

type Scenario = {
  steps: string[];
  versionLatest?: boolean;
  versionThrows?: boolean;
  codeFails?: boolean;
  // For the messages step: the batch, the LID -> PN lookup, the routed chats.
  messages?: unknown[];
  contacts?: unknown[];
  lids?: Record<string, string>;
  routes?: string[];
};
type Ev = { ev: string; [k: string]: unknown };

let n = 0;
async function run(
  scenario: Scenario,
  link: Record<string, unknown>,
): Promise<{ events: Ev[]; seen: { saved: string[]; version: unknown } }> {
  const base = join(root, String(++n));
  const runtime = join(base, "runtime");
  const member = join(base, "member");
  mkdirSync(join(runtime, "node_modules", "baileys"), { recursive: true });
  mkdirSync(join(member, "auth"), { recursive: true });
  writeFileSync(
    join(runtime, "node_modules", "baileys", "package.json"),
    JSON.stringify({ name: "baileys", type: "module", main: "index.js" }),
  );
  writeFileSync(join(runtime, "node_modules", "baileys", "index.js"), FAKE);
  writeFileSync(join(member, "scenario.json"), JSON.stringify(scenario));
  const proc = Bun.spawn({
    cmd: [process.execPath, BRIDGE, member, runtime],
    // As the supervisor runs it: outside the repo and its bunfig.toml.
    cwd: member,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(
    JSON.stringify({ op: "routes", chats: scenario.routes ?? [] }) + "\n",
  );
  proc.stdin.write(JSON.stringify({ op: "link", ...link }) + "\n");
  proc.stdin.flush();
  const seenFile = join(member, "seen.json");
  const done = () => {
    try {
      return JSON.parse(readFileSync(seenFile, "utf8")).done === true;
    } catch {
      return false;
    }
  };
  // A close ends the bridge before the fake marks the steps done.
  let exited = false;
  void proc.exited.then(() => (exited = true));
  for (let t = 0; t < 200 && !done() && !exited; t++) await Bun.sleep(25);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const events = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
  return {
    events,
    seen: JSON.parse(readFileSync(seenFile, "utf8")),
  };
}

const secretOf = (e: Ev) => String(e.code).split("#")[1].split(",")[3];
const refOf = (e: Ev) => String(e.code).split("#")[1].split(",")[0];

describe("whatsapp bridge", () => {
  test("a pairing refresh gets a new saved secret, and every QR from then on carries it", async () => {
    const { events, seen } = await run(
      { steps: ["qr1", "refresh", "qr2"], versionLatest: true },
      { method: "qr" },
    );
    const qrs = events.filter((e) => e.ev === "qr");
    expect(qrs.map(refOf)).toEqual(["REF1", "REF1", "REF2"]);
    const fresh = secretOf(qrs[1]);
    expect(secretOf(qrs[0])).toBe("OLD");
    expect(fresh).not.toBe("OLD");
    expect(Buffer.from(fresh, "base64").length).toBe(32);
    expect(secretOf(qrs[2])).toBe(fresh);
    expect(seen.saved).toContain(fresh);
  });

  test("a refresh without a known child changes nothing", async () => {
    const { events, seen } = await run(
      { steps: ["qr1", "oddRefresh", "qr2"], versionLatest: true },
      { method: "qr" },
    );
    expect(events.filter((e) => e.ev === "qr").map(secretOf)).toEqual([
      "OLD",
      "OLD",
    ]);
    expect(seen.saved).toEqual([]);
  });

  test("the current WA Web version goes to the socket; a stale or failed read leaves Baileys' own", async () => {
    // In parallel: each run is a bridge process.
    const [cur, stale, failed] = await Promise.all([
      run({ steps: [], versionLatest: true }, { method: "qr" }),
      run({ steps: [], versionLatest: false }, { method: "qr" }),
      run({ steps: [], versionThrows: true }, { method: "qr" }),
    ]);
    expect(cur.seen.version).toEqual([2, 3000, 999]);
    expect(stale.seen.version).toBe("none");
    expect(failed.seen.version).toBe("none");
  });

  test("a pairing code is shown and the link waits for pair-success; a pending code keeps its secret", async () => {
    const { events, seen } = await run(
      { steps: ["qr1", "refresh", "paired"], versionLatest: true },
      { method: "code", phone: "447700900123" },
    );
    const kinds = events.map((e) => e.ev).filter((k) => k !== "log");
    expect(kinds).toEqual(["pairing-code", "linked"]);
    expect(events.find((e) => e.ev === "pairing-code")?.code).toBe("ABCD1234");
    expect(seen.saved.every((s) => s === "OLD")).toBe(true);
  });

  test("a failed code request and a close each leave a log line with the reason, and no number", async () => {
    const [code, closed] = await Promise.all([
      run(
        { steps: ["qr1"], versionLatest: true, codeFails: true },
        { method: "code", phone: "447700900123" },
      ),
      run({ steps: ["close"], versionLatest: true }, { method: "qr" }),
    ]);
    expect(code.events.some((e) => e.ev === "pairing-code")).toBe(false);
    const failLine = code.events
      .filter((e) => e.ev === "log")
      .map((e) => String(e.text))
      .find((t) => t.includes("bad request"));
    expect(failLine).toBeDefined();
    expect(failLine).not.toMatch(/\d{6,}/);
    const closeLine = closed.events
      .filter((e) => e.ev === "log")
      .map((e) => String(e.text))
      .find((t) => t.includes("408"));
    expect(closeLine).toContain("QR refs attempts ended");
    expect(
      closed.events.some((e) => e.ev === "closed" && e.statusCode === 408),
    ).toBe(true);
  });

  test("a real message in any chat, routed or not, gives its chat's time under each id the chat is known by, and nothing else", async () => {
    const T = 1_700_000_000;
    const msg = (
      n: number,
      key: Record<string, unknown>,
      message: Record<string, unknown> | null = { conversation: "secret text" },
    ) => ({
      key: { id: `M${n}`, ...key },
      messageTimestamp: T + n,
      message,
    });
    const PN = "447700900123@s.whatsapp.net";
    const { events } = await run(
      {
        steps: ["messages"],
        versionLatest: true,
        routes: ["routed@g.us"],
        lids: { "222@lid": "447700900222@s.whatsapp.net" },
        messages: [
          // A LID chat whose PN comes with the message.
          msg(1, { remoteJid: "111@lid", remoteJidAlt: PN }),
          // A LID chat whose PN comes from the LID lookup.
          msg(2, { remoteJid: "222@lid" }),
          // A LID chat with no known PN.
          msg(3, { remoteJid: "333@lid" }),
          // A PN chat: one id only.
          msg(4, { remoteJid: "447700900444@s.whatsapp.net" }),
          // A group, a message without text, and one the member sent.
          msg(
            5,
            { remoteJid: "g1@g.us", participant: PN },
            {
              imageMessage: {},
            },
          ),
          msg(6, { remoteJid: "g2@g.us", fromMe: true }),
          // Not a chat the picker lists.
          msg(7, { remoteJid: "status@broadcast", participant: PN }),
          // Not activity: a reaction, a protocol message (an edit, a
          // delete) and a message with no content.
          msg(
            8,
            { remoteJid: "react@g.us", participant: PN },
            {
              reactionMessage: { text: "x" },
            },
          ),
          msg(
            9,
            { remoteJid: "proto@g.us", participant: PN },
            {
              protocolMessage: { type: 14 },
            },
          ),
          msg(10, { remoteJid: "empty@g.us", participant: PN }, null),
          // A routed chat: its time and its message both go.
          msg(11, { remoteJid: "routed@g.us", participant: PN }),
        ],
      },
      { method: "qr" },
    );
    // Only the routed chat's message leaves with its text.
    expect(events.filter((e) => e.ev === "message").map((e) => e.chat)).toEqual(
      ["routed@g.us"],
    );
    const activity = events.filter((e) => e.ev === "activity");
    for (const e of activity)
      expect(Object.keys(e).sort()).toEqual(["at", "chat", "ev"]);
    const byChat = activity
      .map((e) => [e.chat, e.at] as const)
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    const ms = (n: number) => (T + n) * 1000;
    expect(byChat).toEqual(
      (
        [
          ["111@lid", ms(1)],
          [PN, ms(1)],
          ["222@lid", ms(2)],
          ["447700900222@s.whatsapp.net", ms(2)],
          ["333@lid", ms(3)],
          ["447700900444@s.whatsapp.net", ms(4)],
          ["g1@g.us", ms(5)],
          ["g2@g.us", ms(6)],
          ["routed@g.us", ms(11)],
        ] as const
      )
        .slice()
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const text = events
      .filter((e) => e.ev !== "message")
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(text).not.toContain("secret text");
  });

  // The picker leaves out the member's own chat: inbound drops every message
  // the member sent, so a row for it would never reach the agent.
  test("the linked account's own chat is never announced, under its number or its LID; other chats are", async () => {
    const SELF_PN = "447700900123@s.whatsapp.net";
    const msg = (n: number, key: Record<string, unknown>) => ({
      key: { id: `M${n}`, ...key },
      messageTimestamp: 1_700_000_000 + n,
      message: { conversation: "hi" },
    });
    const chatsOf = (events: Ev[]) =>
      events
        .filter((e) => e.ev === "chat")
        .map((e) => String(e.chat))
        .sort();
    const [contacts, messages] = await Promise.all([
      run(
        {
          steps: ["me", "contacts"],
          versionLatest: true,
          contacts: [
            { id: SELF_PN, name: "Me" },
            { id: "999@lid", name: "Me too" },
            { id: "447700900555@s.whatsapp.net", name: "Ana" },
            { id: "888@lid", name: "Bo" },
          ],
        },
        { method: "qr" },
      ),
      // No saved names: each chat with a message shows as its number.
      run(
        {
          steps: ["me", "messages"],
          versionLatest: true,
          lids: {
            "999@lid": SELF_PN,
            "777@lid": "447700900777@s.whatsapp.net",
          },
          messages: [
            msg(1, { remoteJid: SELF_PN, fromMe: true }),
            msg(2, { remoteJid: "999@lid", fromMe: true }),
            msg(3, { remoteJid: "447700900666@s.whatsapp.net" }),
            msg(4, { remoteJid: "777@lid" }),
          ],
        },
        { method: "qr" },
      ),
    ]);
    expect({
      contacts: chatsOf(contacts.events),
      messages: chatsOf(messages.events),
    }).toEqual({
      contacts: ["447700900555@s.whatsapp.net", "888@lid"],
      messages: ["447700900666@s.whatsapp.net", "447700900777@s.whatsapp.net"],
    });
  });
});
