// Fine-grained limits on a personal API token (task 23339bea): the shape a
// mint accepts, the route check the executor runs, and the presets the mint
// dialog offers. The executor and the route table use these; their own tests
// cover the wiring (server/test-support/route-executor.test.ts,
// server/test-support/routes-table.test.ts).

import { describe, expect, it } from "bun:test";
import {
  API_TOKEN_AREAS,
  API_TOKEN_PRESETS,
  FULL_ACCESS_WRITE_AREAS,
  READ_SHOWS_SECRETS,
  parseApiTokenLimits,
  routeAllowedByLimits,
  type ApiTokenLimits,
} from "./api-token-limits.ts";

describe("parseApiTokenLimits", () => {
  it("accepts known areas at read or write, and an empty area map", () => {
    const value: ApiTokenLimits = {
      areas: { agents: "write", logs: "read", voice: "read" },
    };
    expect(parseApiTokenLimits(value)).toEqual(value);
    // Empty: the token can only drain its own inbox.
    expect(parseApiTokenLimits({ areas: {} })).toEqual({ areas: {} });
  });

  it("accepts room ids, alone (every area) or with areas, and no rooms", () => {
    for (const value of [
      { rooms: ["room-a", "room-b"] },
      { rooms: [] },
      { areas: { tasks: "read" }, rooms: ["room-a"] },
    ]) {
      expect(parseApiTokenLimits(value)).toEqual(value as ApiTokenLimits);
    }
    // Areas absent is every area, not none.
    expect("areas" in parseApiTokenLimits({ rooms: ["room-a"] })!).toBe(false);
  });

  it("refuses an unknown area, an unknown level and extra keys", () => {
    const refused: Array<[string, unknown]> = [
      ["null", null],
      ["a string", "readOnly"],
      ["an array", []],
      // Full access is no limits field, never an empty value.
      ["no axis", {}],
      ["areas null", { areas: null }],
      ["areas an array", { areas: [] }],
      ["unknown area", { areas: { bogus: "read" } }],
      // Names every plain object inherits are not areas.
      ["inherited name", { areas: { toString: "read" } }],
      ["inherited name", { areas: { constructor: "write" } }],
      ["own __proto__ key", { areas: JSON.parse('{"__proto__":"read"}') }],
      // Absent is none: "none" is not a level on the wire.
      ["level none", { areas: { agents: "none" } }],
      ["unknown level", { areas: { agents: "admin" } }],
      ["level null", { areas: { agents: null } }],
      ["level boolean", { areas: { agents: true } }],
      ["extra top-level key", { areas: {}, bogus: true }],
      ["rooms null", { rooms: null }],
      ["rooms a string", { rooms: "room-a" }],
      ["rooms an object", { rooms: { 0: "room-a" } }],
      ["room id not a string", { rooms: [7] }],
      ["room id empty", { rooms: [""] }],
      ["duplicate room id", { rooms: ["room-a", "room-a"] }],
    ];
    for (const [label, value] of refused) {
      expect({ label, parsed: parseApiTokenLimits(value) }).toEqual({
        label,
        parsed: null,
      });
    }
  });
});

describe("parseApiTokenLimits: replies only", () => {
  it("accepts replies only on a token that can write agents, with or without other axes", () => {
    for (const value of [
      { repliesOnly: true },
      { areas: { agents: "write" }, repliesOnly: true },
      { areas: { agents: "write", tasks: "read" }, repliesOnly: true },
      { rooms: ["room-a"], repliesOnly: true },
    ]) {
      expect(parseApiTokenLimits(value)).toEqual(value as ApiTokenLimits);
    }
  });

  it("refuses any value but true, and replies only on a token that cannot write agents", () => {
    const refused: Array<[string, unknown]> = [
      // An absent axis does not limit, so false is not a value.
      ["false", { repliesOnly: false }],
      ["a string", { repliesOnly: "true" }],
      ["a number", { repliesOnly: 1 }],
      ["null", { repliesOnly: null }],
      ["agents read", { areas: { agents: "read" }, repliesOnly: true }],
      ["agents absent", { areas: { tasks: "write" }, repliesOnly: true }],
      ["no areas at all", { areas: {}, repliesOnly: true }],
    ];
    for (const [label, value] of refused) {
      expect({ label, parsed: parseApiTokenLimits(value) }).toEqual({
        label,
        parsed: null,
      });
    }
  });
});

describe("routeAllowedByLimits", () => {
  const readTasks: ApiTokenLimits = { areas: { tasks: "read" } };
  const writeTasks: ApiTokenLimits = { areas: { tasks: "write" } };

  it("lets a token without limits call every route, with or without an area", () => {
    expect(routeAllowedByLimits(undefined, undefined)).toBe(true);
    expect(
      routeAllowedByLimits(undefined, { area: "environment", level: "write" }),
    ).toBe(true);
  });

  it("fails closed for a limited token on a route without an area", () => {
    expect(routeAllowedByLimits({ areas: {} }, undefined)).toBe(false);
    expect(routeAllowedByLimits(writeTasks, undefined)).toBe(false);
  });

  it("lets every limited token call an always route", () => {
    expect(routeAllowedByLimits({ areas: {} }, "always")).toBe(true);
  });

  it("gives a rooms-only token every area at write, and still fails closed without an area", () => {
    const roomsOnly: ApiTokenLimits = { rooms: ["room-a"] };
    expect(
      routeAllowedByLimits(roomsOnly, { area: "environment", level: "write" }),
    ).toBe(true);
    expect(
      routeAllowedByLimits({ rooms: [] }, { area: "tasks", level: "read" }),
    ).toBe(true);
    expect(routeAllowedByLimits(roomsOnly, undefined)).toBe(false);
  });

  it("grants read with read, read and write with write, and nothing in another area", () => {
    const cases: Array<[ApiTokenLimits, "read" | "write", boolean]> = [
      [readTasks, "read", true],
      [readTasks, "write", false],
      [writeTasks, "read", true],
      [writeTasks, "write", true],
    ];
    for (const [limits, level, allowed] of cases) {
      expect({
        held: limits.areas?.tasks,
        level,
        allowed: routeAllowedByLimits(limits, { area: "tasks", level }),
      }).toEqual({ held: limits.areas?.tasks, level, allowed });
    }
    expect(
      routeAllowedByLimits(writeTasks, { area: "pager", level: "read" }),
    ).toBe(false);
  });
});

describe("areas and presets", () => {
  it("flags the areas whose read shows secret values", () => {
    expect<string[]>([...READ_SHOWS_SECRETS].sort()).toEqual(
      ["environment", "files", "logs"].sort(),
    );
  });

  it("flags the areas whose write equals full access", () => {
    // The agreed list plus rooms, files and skills (design round,
    // 2026-10-31): each puts text in an agent's prompt or code on the box.
    // Agents, agentManagement and asks write are not in it: the pack rule
    // bounds them (task 134b8f77, shared/pack-fit.ts).
    expect<string[]>([...FULL_ACCESS_WRITE_AREAS].sort()).toEqual(
      [
        "office",
        "rooms",
        "files",
        "memory",
        "skills",
        "schedules",
        "apps",
        "webhooks",
        "environment",
      ].sort(),
    );
  });

  it("Read only reads every area whose read shows no secret, and writes nothing", () => {
    const secret = new Set(["environment", "files", "logs"]);
    const expected = Object.fromEntries(
      API_TOKEN_AREAS.filter((area) => !secret.has(area)).map((area) => [
        area,
        "read",
      ]),
    );
    expect(API_TOKEN_PRESETS.readOnly).toEqual({ areas: expected });
    expect(Object.keys(expected)).toHaveLength(API_TOKEN_AREAS.length - 3);
  });

  it("Talk to agents is Read only plus write on agents", () => {
    expect(API_TOKEN_PRESETS.talkToAgents).toEqual({
      areas: { ...API_TOKEN_PRESETS.readOnly.areas, agents: "write" },
    });
    expect(API_TOKEN_PRESETS.readOnly.areas.agents).toBe("read");
  });

  it("Replies only is Talk to agents with the replies only switch", () => {
    expect(API_TOKEN_PRESETS.repliesOnly).toEqual({
      areas: API_TOKEN_PRESETS.talkToAgents.areas,
      repliesOnly: true,
    });
  });

  it("each preset is a value a mint accepts", () => {
    for (const preset of Object.values(API_TOKEN_PRESETS)) {
      expect(parseApiTokenLimits(preset)).toEqual(preset);
    }
  });
});
