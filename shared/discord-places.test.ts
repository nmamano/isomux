// The places a discord-route step may route (task 386ec4d6): the agent gives
// a part of a Discord name, and the server and the ask card both list the
// member's places whose name holds it. One rule for both sides, so what the
// card offers is what the server takes.
import { describe, expect, it } from "bun:test";
import {
  discordPlacesMatching,
  type DiscordGuildSeen,
  type DiscordPlace,
} from "./discord.ts";

const BOT = "1100000000000000001";
const BOT2 = "1100000000000000002";
const GUILD = "1200000000000000001";
const GUILD2 = "1200000000000000002";
const CAT = "1300000000000000001";
const LEGAL = "1300000000000000002";
const FORUM = "1300000000000000003";
const LOOSE = "1300000000000000004";
const G2_CHAN = "1300000000000000005";
const G2_CAT = "1300000000000000006";

const AKIDO: DiscordGuildSeen = {
  id: GUILD,
  name: "Akido HQ",
  channels: [
    { id: CAT, name: "Akido Talk", kind: "category", parentId: null },
    { id: LEGAL, name: "akido-legal", kind: "text", parentId: CAT },
    { id: FORUM, name: "akido-help", kind: "forum", parentId: CAT },
    { id: LOOSE, name: "random", kind: "text", parentId: null },
  ],
};
const ELSEWHERE: DiscordGuildSeen = {
  id: GUILD2,
  name: "Elsewhere",
  channels: [
    { id: G2_CAT, name: "Ops", kind: "category", parentId: null },
    { id: G2_CHAN, name: "akido-ops", kind: "text", parentId: G2_CAT },
  ],
};

const ONE_BOT = [{ botId: BOT, guilds: [AKIDO, ELSEWHERE] }];

// A place as a short key, so a miss prints one line per place.
const key = (p: DiscordPlace) => `${p.botId}:${p.scope}:${p.targetId}`;
const keys = (places: DiscordPlace[]) => places.map(key);
const sorted = (places: DiscordPlace[]) => keys(places).sort();

describe("discordPlacesMatching", () => {
  it("with no scope, every kind whose name holds the text: the server by its name, a category, a text channel and a forum", () => {
    expect(sorted(discordPlacesMatching("akido", undefined, ONE_BOT))).toEqual(
      [
        `${BOT}:server:${GUILD}`,
        `${BOT}:category:${CAT}`,
        `${BOT}:channel:${LEGAL}`,
        `${BOT}:channel:${FORUM}`,
        `${BOT}:channel:${G2_CHAN}`,
      ].sort(),
    );
  });

  it("a scope narrows to that kind: a channel scope never takes a category, a category scope never a channel", () => {
    expect(sorted(discordPlacesMatching("akido", "server", ONE_BOT))).toEqual([
      `${BOT}:server:${GUILD}`,
    ]);
    expect(sorted(discordPlacesMatching("akido", "category", ONE_BOT))).toEqual(
      [`${BOT}:category:${CAT}`],
    );
    expect(sorted(discordPlacesMatching("akido", "channel", ONE_BOT))).toEqual(
      [
        `${BOT}:channel:${LEGAL}`,
        `${BOT}:channel:${FORUM}`,
        `${BOT}:channel:${G2_CHAN}`,
      ].sort(),
    );
    // "Ops" is a category, so a channel scope does not take it; the text
    // channel "akido-ops" holds "ops" too.
    expect(sorted(discordPlacesMatching("ops", "channel", ONE_BOT))).toEqual([
      `${BOT}:channel:${G2_CHAN}`,
    ]);
    expect(sorted(discordPlacesMatching("ops", "category", ONE_BOT))).toEqual([
      `${BOT}:category:${G2_CAT}`,
    ]);
  });

  it("each place carries its bot, its server and its Discord name; a server place targets the server itself", () => {
    const found = discordPlacesMatching("legal", undefined, ONE_BOT);
    expect(found).toEqual([
      {
        botId: BOT,
        guildId: GUILD,
        guildName: "Akido HQ",
        scope: "channel",
        targetId: LEGAL,
        name: "akido-legal",
      },
    ]);
    expect(discordPlacesMatching("hq", undefined, ONE_BOT)).toEqual([
      {
        botId: BOT,
        guildId: GUILD,
        guildName: "Akido HQ",
        scope: "server",
        targetId: GUILD,
        name: "Akido HQ",
      },
    ]);
    expect(discordPlacesMatching("talk", undefined, ONE_BOT)).toEqual([
      {
        botId: BOT,
        guildId: GUILD,
        guildName: "Akido HQ",
        scope: "category",
        targetId: CAT,
        name: "Akido Talk",
      },
    ]);
  });

  it("matches a part of the name in any case, after trimming the text; a blank text matches nothing", () => {
    for (const text of ["LEGAL", "  Akido-Le ", "kido-leg"])
      expect({
        text,
        found: keys(discordPlacesMatching(text, "channel", ONE_BOT)),
      }).toEqual({
        text,
        found: [`${BOT}:channel:${LEGAL}`],
      });
    for (const text of ["", "   ", "legal team", "akido legal"])
      expect({
        text,
        found: keys(discordPlacesMatching(text, undefined, ONE_BOT)),
      }).toEqual({ text, found: [] });
  });

  it('drops one leading "#" of the text, as an agent writes a channel; "#" alone matches nothing', () => {
    expect(
      keys(discordPlacesMatching("#akido-legal", undefined, ONE_BOT)),
    ).toEqual([`${BOT}:channel:${LEGAL}`]);
    expect(
      keys(discordPlacesMatching("  #random", "channel", ONE_BOT)),
    ).toEqual([`${BOT}:channel:${LOOSE}`]);
    expect(keys(discordPlacesMatching("#", undefined, ONE_BOT))).toEqual([]);
    // Only one "#" goes: "#random" is not in any name.
    expect(keys(discordPlacesMatching("##random", undefined, ONE_BOT))).toEqual(
      [],
    );
  });

  it("goes by bot, then server, then channel, in the order seen; a server two bots share is one place per bot", () => {
    const found = discordPlacesMatching("akido", "channel", [
      { botId: BOT2, guilds: [ELSEWHERE, AKIDO] },
      { botId: BOT, guilds: [AKIDO] },
    ]);
    expect(keys(found)).toEqual([
      `${BOT2}:channel:${G2_CHAN}`,
      `${BOT2}:channel:${LEGAL}`,
      `${BOT2}:channel:${FORUM}`,
      `${BOT}:channel:${LEGAL}`,
      `${BOT}:channel:${FORUM}`,
    ]);
  });

  it("a bot in no server, or no bot, has no places", () => {
    expect(
      discordPlacesMatching("akido", undefined, [{ botId: BOT, guilds: [] }]),
    ).toEqual([]);
    expect(discordPlacesMatching("akido", undefined, [])).toEqual([]);
  });
});
