// The Discord gateway child's stdio protocol and the snowflake helpers
// (task 7fd44c30). A line the child or the server cannot trust reads as
// null, never as a half-filled event; snowflakes compare by value.

import { describe, expect, it } from "bun:test";
import {
  DISCORD_EPOCH_MS,
  compareSnowflakes,
  snowflakeFromTime,
  snowflakeTime,
} from "../../shared/discord.ts";
import {
  encodeGatewayCommand,
  parseGatewayCommand,
  parseGatewayEvent,
  type DiscordMessage,
  type GatewayEvent,
} from "./protocol.ts";

// Discord's documented example: this id was made at 2016-04-30T11:18:25.796Z.
const DOC_ID = "175928847299117063";
const DOC_MS = 1_462_015_105_796;

describe("snowflakes", () => {
  it("reads the time a snowflake was made", () => {
    expect(snowflakeTime(DOC_ID)).toBe(DOC_MS);
    expect(snowflakeTime(snowflakeFromTime(DISCORD_EPOCH_MS).toString())).toBe(
      DISCORD_EPOCH_MS,
    );
  });

  it("makes the smallest snowflake of a time", () => {
    const low = snowflakeFromTime(DOC_MS);
    expect(typeof low).toBe("bigint");
    expect(low <= BigInt(DOC_ID)).toBe(true);
    // The low 22 bits (worker, process, increment) are zero.
    expect(low & ((1n << 22n) - 1n)).toBe(0n);
    expect(snowflakeTime(low.toString())).toBe(DOC_MS);
    // One ms later is above every id of this ms.
    expect(snowflakeFromTime(DOC_MS + 1) > BigInt(DOC_ID)).toBe(true);
  });

  it("compares by value: not as strings, and not as Numbers past 2^53", () => {
    // A string compare puts the shorter id after the longer one.
    expect(compareSnowflakes("99999999999999999", "100000000000000000")).toBe(
      -1,
    );
    expect(compareSnowflakes("100000000000000000", "99999999999999999")).toBe(
      1,
    );
    // As Numbers both are 2^53.
    expect(compareSnowflakes("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareSnowflakes("9007199254740992", "9007199254740993")).toBe(-1);
    expect(compareSnowflakes(DOC_ID, DOC_ID)).toBe(0);
  });

  it("refuses a string that is not a snowflake", () => {
    for (const bad of ["", "abc", "-1", "1.5", "12 3", "0x10"])
      expect(() => compareSnowflakes(bad, DOC_ID)).toThrow();
  });
});

const MESSAGE: DiscordMessage = {
  ev: "message",
  id: DOC_ID,
  guildId: "81384788765712384",
  channelId: "81384788765712385",
  author: { id: "80351110224678912", name: "Nelly", bot: false },
  webhook: false,
  type: 0,
  content: "hello <@123>",
  mentionsBot: true,
  replyToBot: false,
  attachments: [{ name: "a.png", url: "https://cdn.discordapp.com/a.png" }],
  ts: DOC_MS,
};

const EVENTS: GatewayEvent[] = [
  { ev: "ready", user: { id: "123", name: "Office Bot" } },
  { ev: "resumed" },
  {
    ev: "guild",
    guild: {
      id: "1",
      name: "Isomux",
      channels: [
        { id: "2", name: "general", kind: "text", parentId: "3" },
        { id: "3", name: "Talk", kind: "category", parentId: null },
        { id: "4", name: "help", kind: "forum", parentId: null },
      ],
    },
    botRoleIds: ["5"],
  },
  { ev: "guild-gone", guildId: "1" },
  {
    ev: "channel",
    guildId: "1",
    channel: { id: "2", name: "general", kind: "text", parentId: null },
  },
  { ev: "channel-gone", guildId: "1", channelId: "2" },
  { ev: "thread", guildId: "1", id: "6", parentId: "2" },
  { ev: "thread-gone", guildId: "1", id: "6" },
  { ev: "closed", code: 4014 },
  { ev: "log", text: "gateway: reconnecting" },
  MESSAGE,
];

describe("parseGatewayEvent", () => {
  it("reads back every event the child writes", () => {
    for (const event of EVENTS)
      expect(parseGatewayEvent(JSON.stringify(event))).toEqual(event);
  });

  it("reads a line that is not a valid event as null", () => {
    const bad: unknown[] = [
      "not json",
      "",
      null,
      42,
      [],
      { ev: "nope" },
      { ev: "ready" },
      { ev: "ready", user: { id: 5, name: "x" } },
      { ev: "closed", code: "4014" },
      { ev: "log" },
      { ev: "thread", guildId: "1", id: "6" },
      {
        ev: "guild",
        guild: { id: "1", name: "x", channels: [] },
      },
      {
        ev: "guild",
        guild: {
          id: "1",
          name: "x",
          channels: [{ id: "2", name: "y", kind: "voice", parentId: null }],
        },
        botRoleIds: [],
      },
    ];
    for (const value of bad) {
      const line = typeof value === "string" ? value : JSON.stringify(value);
      expect({ line, event: parseGatewayEvent(line) }).toEqual({
        line,
        event: null,
      });
    }
  });

  it("reads a message with a missing or mistyped field as null", () => {
    const broken: Record<string, unknown>[] = [];
    for (const key of Object.keys(MESSAGE).filter((k) => k !== "ev")) {
      const without: Record<string, unknown> = { ...MESSAGE };
      delete without[key];
      broken.push(without);
    }
    broken.push({ ...MESSAGE, author: { id: "1", name: "x" } });
    broken.push({ ...MESSAGE, attachments: "a.png" });
    broken.push({ ...MESSAGE, attachments: [{ name: "a.png" }] });
    broken.push({ ...MESSAGE, mentionsBot: "yes" });
    broken.push({ ...MESSAGE, type: "0" });
    broken.push({ ...MESSAGE, ts: "now" });
    for (const value of broken) {
      const line = JSON.stringify(value);
      expect({ line, event: parseGatewayEvent(line) }).toEqual({
        line,
        event: null,
      });
    }
  });
});

describe("parseGatewayCommand", () => {
  it("reads back what the server encodes, one command per line", () => {
    for (const cmd of [
      { op: "start", token: "t0ken", url: "ws://127.0.0.1:1/gw" },
      { op: "stop" },
    ] as const) {
      const line = encodeGatewayCommand(cmd);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1).includes("\n")).toBe(false);
      expect(parseGatewayCommand(line.trimEnd())).toEqual(cmd);
    }
  });

  it("reads a line that is not a valid command as null", () => {
    for (const value of [
      "not json",
      { op: "start", token: "t" },
      { op: "start", url: "ws://x" },
      { op: "start", token: 5, url: "ws://x" },
      { op: "start", token: "", url: "ws://x" },
      { op: "logout" },
      {},
    ]) {
      const line = typeof value === "string" ? value : JSON.stringify(value);
      expect({ line, cmd: parseGatewayCommand(line) }).toEqual({
        line,
        cmd: null,
      });
    }
  });
});
