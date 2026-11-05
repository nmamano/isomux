// A member's Discord files (task 7fd44c30): bots with their tokens, routes and
// each bot's cursors, in STATE_ROOT/discord/<userId>/. A real temp STATE_ROOT.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { DiscordRoute } from "../../shared/discord.ts";
import { WHATSAPP_ID_RING_MAX } from "../whatsapp/routes-store.ts";
import {
  discordMemberDir,
  discordRoot,
  listDiscordMembers,
  openDiscordSentRing,
  readBots,
  readCursors,
  readDiscordRoutes,
  removeCursors,
  removeDiscordMember,
  writeBots,
  writeCursors,
  writeDiscordRoutes,
  type StoredBot,
} from "./store.ts";

const U = "u-alice";
const V = "u-bob";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "t-7fd44c30-store-"));
  roots.push(r);
  return r;
}

const BOT: StoredBot = {
  id: "1100000000000000001",
  name: "Office Bot",
  token: "fake-token-0001",
  addedAt: 1_800_000_000_000,
};
const BOT2 = "1100000000000000002";

const ROUTE: DiscordRoute = {
  id: "r-1",
  botId: BOT.id,
  guildId: "1200000000000000001",
  scope: "channel",
  targetId: "1300000000000000001",
  name: "general",
  agentId: "agent-1",
  trigger: "all",
  replyMode: "bot",
  prefix: "[Agent]: ",
  includeBots: true,
  createdAt: 1_800_000_000_100,
};

describe("discord store", () => {
  it("keeps each member's files under STATE_ROOT/discord/<userId>", () => {
    const r = root();
    expect(discordRoot(r)).toBe(join(r, "discord"));
    expect(discordMemberDir(r, U)).toBe(join(r, "discord", U));
  });

  it("refuses a user id that could leave the root", () => {
    const r = root();
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "."])
      expect(() => discordMemberDir(r, bad)).toThrow();
  });

  it("round trip: bots, routes and cursors come back as written, 0600 in a 0700 directory, no temp file left", () => {
    const r = root();
    writeBots(r, U, [BOT]);
    writeDiscordRoutes(r, U, [ROUTE]);
    const cursors = { "1300000000000000001": "1400000000000000001" };
    writeCursors(r, U, BOT.id, cursors);
    expect(readBots(r, U)).toEqual([BOT]);
    expect(readDiscordRoutes(r, U)).toEqual([ROUTE]);
    expect(readCursors(r, U, BOT.id)).toEqual(cursors);

    const dir = discordMemberDir(r, U);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["bots.json", "cursors.json", "routes.json"]);
    for (const f of files)
      expect([f, statSync(join(dir, f)).mode & 0o777]).toEqual([f, 0o600]);

    // A second write replaces the first; another member is apart.
    writeBots(r, U, []);
    expect(readBots(r, U)).toEqual([]);
    expect(readBots(r, V)).toEqual([]);
    expect(readDiscordRoutes(r, V)).toEqual([]);
    expect(readCursors(r, V, BOT.id)).toEqual({});
  });

  it("each bot has its own cursors: a write keeps the other bot's, and a removal takes only that bot's", () => {
    const r = root();
    const a = { "1300000000000000001": "1400000000000000001" };
    const b = { "1300000000000000001": "1400000000000000009" };
    writeCursors(r, U, BOT.id, a);
    writeCursors(r, U, BOT2, b);
    expect(readCursors(r, U, BOT.id)).toEqual(a);
    expect(readCursors(r, U, BOT2)).toEqual(b);
    writeCursors(r, U, BOT.id, {});
    expect(readCursors(r, U, BOT2)).toEqual(b);
    writeCursors(r, U, BOT.id, a);
    removeCursors(r, U, BOT2);
    expect(readCursors(r, U, BOT2)).toEqual({});
    expect(readCursors(r, U, BOT.id)).toEqual(a);
    // Another member's bot of the same id is apart; a removal with no file
    // is a no-op.
    expect(readCursors(r, V, BOT.id)).toEqual({});
    removeCursors(r, V, BOT.id);
  });

  it("a missing or bad file reads as empty", () => {
    const r = root();
    const dir = discordMemberDir(r, U);
    mkdirSync(dir, { recursive: true });
    for (const bad of ["{", "", "null", "5", '"a"']) {
      for (const f of ["bots.json", "routes.json", "cursors.json"])
        writeFileSync(join(dir, f), bad);
      expect([
        bad,
        readBots(r, U),
        readDiscordRoutes(r, U),
        readCursors(r, U, BOT.id),
      ]).toEqual([bad, [], [], {}]);
    }
  });

  it("drops a cursor that is not a snowflake", () => {
    const r = root();
    const dir = discordMemberDir(r, U);
    mkdirSync(dir, { recursive: true });
    // cursors.json: bot id -> channel or thread id -> message id.
    writeFileSync(
      join(dir, "cursors.json"),
      JSON.stringify({
        [BOT.id]: {
          "1300000000000000001": "1400000000000000001",
          "1300000000000000002": 1400000000,
          "1300000000000000003": "abc",
          "1300000000000000004": "",
          "1300000000000000005": null,
          "1300000000000000006": "-5",
        },
        [BOT2]: "1400000000000000001",
      }),
    );
    expect(readCursors(r, U, BOT.id)).toEqual({
      "1300000000000000001": "1400000000000000001",
    });
    expect(readCursors(r, U, BOT2)).toEqual({});
  });

  it("the sent ring keeps its ids on disk, 0600, per member, the newest up to the cap, and goes with the member's directory", () => {
    const r = root();
    const ring = openDiscordSentRing(r, U);
    expect(ring.has("ask:1")).toBe(false);
    ring.add("ask:1");
    ring.add("ask:1");
    expect(openDiscordSentRing(r, U).has("ask:1")).toBe(true);
    expect(openDiscordSentRing(r, V).has("ask:1")).toBe(false);
    const file = join(discordMemberDir(r, U), "sent.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const many = openDiscordSentRing(r, U);
    for (let i = 2; i <= WHATSAPP_ID_RING_MAX + 1; i++) many.add(`ask:${i}`);
    const back = openDiscordSentRing(r, U);
    expect([
      back.has("ask:1"),
      back.has("ask:2"),
      back.has(`ask:${WHATSAPP_ID_RING_MAX + 1}`),
    ]).toEqual([false, true, true]);
    removeDiscordMember(r, U);
    expect(openDiscordSentRing(r, U).has("ask:2")).toBe(false);
  });

  it("lists the members with a directory, and removes one member's files only", () => {
    const r = root();
    expect(listDiscordMembers(r)).toEqual([]);
    writeBots(r, U, [BOT]);
    writeBots(r, V, [{ ...BOT, id: "1100000000000000002" }]);
    writeFileSync(join(discordRoot(r), "stray-file"), "x");
    expect(listDiscordMembers(r).sort()).toEqual([U, V]);

    removeDiscordMember(r, U);
    expect(existsSync(discordMemberDir(r, U))).toBe(false);
    expect(listDiscordMembers(r)).toEqual([V]);
    expect(readBots(r, V)).toHaveLength(1);
    // Removing a member with no directory is a no-op.
    removeDiscordMember(r, U);
  });
});
