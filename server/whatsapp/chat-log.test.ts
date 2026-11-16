// The chat log of a routed WhatsApp chat (task 682fd65a): what it keeps, that
// it survives a reopen (a restart), its cap, its file rules, and that it never
// writes for a member whose WhatsApp directory is gone. A real temp
// STATE_ROOT; the inbound and read paths over it are in inbound.test.ts and
// replies.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { APP_MESSAGE_MAX_CHARS } from "../app-message-limits.ts";
import {
  WHATSAPP_CHAT_LOG_MAX,
  openChatLog,
  removeChatLog,
  type ChatLogLine,
} from "./chat-log.ts";
import {
  ensureMemberDir,
  memberDir,
  removeMemberDir,
  removeSession,
} from "./store.ts";

const U = "u-alice";
const MOM = "447700900123@s.whatsapp.net";
const FAMILY = "120363000000000001@g.us";
const T0 = 1_800_000_000_000;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "t-682fd65a-chatlog-"));
  roots.push(r);
  return r;
}

// A linked member: their directory exists.
function linkedRoot(): string {
  const r = root();
  ensureMemberDir(r, U);
  return r;
}

const line = (i: number, over: Partial<ChatLogLine> = {}): ChatLogLine => ({
  id: `m${i}`,
  ts: T0 + i,
  from: "Mom",
  fromMe: false,
  text: `text ${i}`,
  ...over,
});

// Every file under dir, with its path.
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

// The files of the member that hold a logged text.
const filesWith = (r: string, text: string) =>
  walk(memberDir(r, U)).filter((f) => readFileSync(f, "utf8").includes(text));

describe("whatsapp chat log", () => {
  it("keeps lines in order with their flags, and a reopen (a restart) reads them back", () => {
    const r = linkedRoot();
    const log = openChatLog(r, U, MOM);
    expect(log.lines()).toEqual([]);
    expect(log.append(line(1))).toBe(true);
    expect(log.append(line(2, { from: "Morgan", fromMe: true }))).toBe(true);
    expect(log.append(line(3))).toBe(true);
    log.mark(["m1", "m3"], "delivered");
    log.mark(["m2"], "agent");
    const want: ChatLogLine[] = [
      { ...line(1), delivered: true },
      { ...line(2, { from: "Morgan", fromMe: true }), agent: true },
      { ...line(3), delivered: true },
    ];
    expect(log.lines()).toEqual(want);
    expect(openChatLog(r, U, MOM).lines()).toEqual(want);
    // A mark of an id that is not logged changes nothing.
    log.mark(["m-none"], "delivered");
    expect(openChatLog(r, U, MOM).lines()).toEqual(want);
  });

  it("an id already logged is not added again and changes nothing", () => {
    const r = linkedRoot();
    const log = openChatLog(r, U, MOM);
    log.append(line(1));
    log.mark(["m1"], "delivered");
    expect(log.append(line(1, { text: "a redelivery", from: "Other" }))).toBe(
      false,
    );
    expect(openChatLog(r, U, MOM).lines()).toEqual([
      { ...line(1), delivered: true },
    ]);
  });

  it("keeps the newest lines up to the cap", () => {
    const r = linkedRoot();
    const log = openChatLog(r, U, MOM);
    for (let i = 0; i < WHATSAPP_CHAT_LOG_MAX + 5; i++) log.append(line(i));
    const ids = openChatLog(r, U, MOM)
      .lines()
      .map((l) => l.id);
    expect(ids).toHaveLength(WHATSAPP_CHAT_LOG_MAX);
    expect(ids[0]).toBe("m5");
    expect(ids.at(-1)).toBe(`m${WHATSAPP_CHAT_LOG_MAX + 4}`);
  });

  it("cuts a stored text to the delivery limit", () => {
    const r = linkedRoot();
    const long = "start " + "x".repeat(3 * APP_MESSAGE_MAX_CHARS);
    openChatLog(r, U, MOM).append(line(1, { text: long }));
    const [stored] = openChatLog(r, U, MOM).lines();
    expect(stored.text.length).toBeLessThanOrEqual(APP_MESSAGE_MAX_CHARS);
    expect(stored.text.startsWith("start xxx")).toBe(true);
    // The condition: a short text is kept as it is.
    openChatLog(r, U, MOM).append(line(2, { text: "short" }));
    expect(openChatLog(r, U, MOM).lines()[1].text).toBe("short");
  });

  it("keeps each chat apart; removing one chat's log keeps the other", () => {
    const r = linkedRoot();
    openChatLog(r, U, MOM).append(line(1));
    openChatLog(r, U, FAMILY).append(line(2));
    expect(
      openChatLog(r, U, MOM)
        .lines()
        .map((l) => l.id),
    ).toEqual(["m1"]);
    expect(
      openChatLog(r, U, FAMILY)
        .lines()
        .map((l) => l.id),
    ).toEqual(["m2"]);
    removeChatLog(r, U, MOM);
    expect(openChatLog(r, U, MOM).lines()).toEqual([]);
    expect(filesWith(r, "text 1")).toEqual([]);
    expect(
      openChatLog(r, U, FAMILY)
        .lines()
        .map((l) => l.id),
    ).toEqual(["m2"]);
    // Removing a log that is not there is no error.
    removeChatLog(r, U, MOM);
  });

  it("is a 0600 file in the member's directory, written whole: no temp file stays", () => {
    const r = linkedRoot();
    const log = openChatLog(r, U, MOM);
    log.append(line(1, { text: "the marker text" }));
    log.mark(["m1"], "delivered");
    const files = filesWith(r, "the marker text");
    expect(files).toHaveLength(1);
    expect(statSync(files[0]).mode & 0o777).toBe(0o600);
    expect(walk(memberDir(r, U)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("a file that does not parse reads as no lines, and the next append works", () => {
    const r = linkedRoot();
    openChatLog(r, U, MOM).append(line(1, { text: "the marker text" }));
    const [file] = filesWith(r, "the marker text");
    writeFileSync(file, "{ not json");
    expect(openChatLog(r, U, MOM).lines()).toEqual([]);
    expect(openChatLog(r, U, MOM).append(line(2))).toBe(true);
    expect(
      openChatLog(r, U, MOM)
        .lines()
        .map((l) => l.id),
    ).toEqual(["m2"]);
  });

  it("writes nothing when the member's directory is gone: before a link, and a late write after an unlink", () => {
    const r = root();
    openChatLog(r, U, MOM).append(line(1));
    expect(existsSync(memberDir(r, U))).toBe(false);

    ensureMemberDir(r, U);
    const held = openChatLog(r, U, MOM);
    held.append(line(2));
    // The condition: the linked member's log is on disk.
    expect(filesWith(r, "text 2")).toHaveLength(1);
    removeMemberDir(r, U);
    held.append(line(3));
    held.mark(["m2"], "delivered");
    expect(existsSync(memberDir(r, U))).toBe(false);
  });

  it("a dead link's session removal (removeSession) deletes the logs", () => {
    const r = linkedRoot();
    openChatLog(r, U, MOM).append(line(1));
    removeSession(r, U);
    expect(openChatLog(r, U, MOM).lines()).toEqual([]);
    expect(filesWith(r, "text 1")).toEqual([]);
  });

  it("a chat id that is not a WhatsApp chat id is never a file name: nothing is written outside or inside the member's directory", () => {
    const parent = root();
    const r = join(parent, "state");
    ensureMemberDir(r, U);
    for (const chat of [
      "../../../escape@g.us",
      "../escape",
      "/abs@g.us",
      "a/b@g.us",
      "",
    ]) {
      openChatLog(r, U, chat).append(line(1, { text: "never written" }));
      expect({ chat, lines: openChatLog(r, U, chat).lines() }).toEqual({
        chat,
        lines: [],
      });
      removeChatLog(r, U, chat);
    }
    expect(
      walk(parent).filter((f) =>
        readFileSync(f, "utf8").includes("never written"),
      ),
    ).toEqual([]);
    // The condition: a real chat id is logged in the same root.
    openChatLog(r, U, FAMILY).append(line(2, { text: "written" }));
    expect(filesWith(r, "written")).toHaveLength(1);
  });
});
