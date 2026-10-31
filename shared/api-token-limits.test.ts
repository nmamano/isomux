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

  it("refuses an unknown area, an unknown level and extra keys", () => {
    const refused: Array<[string, unknown]> = [
      ["null", null],
      ["a string", "readOnly"],
      ["an array", []],
      ["no areas", {}],
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
      ["extra top-level key", { areas: {}, rooms: null }],
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

  it("grants read with read, read and write with write, and nothing in another area", () => {
    const cases: Array<[ApiTokenLimits, "read" | "write", boolean]> = [
      [readTasks, "read", true],
      [readTasks, "write", false],
      [writeTasks, "read", true],
      [writeTasks, "write", true],
    ];
    for (const [limits, level, allowed] of cases) {
      expect({
        held: limits.areas.tasks,
        level,
        allowed: routeAllowedByLimits(limits, { area: "tasks", level }),
      }).toEqual({ held: limits.areas.tasks, level, allowed });
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
    // The agreed list plus rooms, files, asks and skills (design round,
    // 2026-10-31): each puts text in an agent's prompt, code on the box or an
    // order to an agent.
    expect<string[]>([...FULL_ACCESS_WRITE_AREAS].sort()).toEqual(
      [
        "office",
        "rooms",
        "agents",
        "agentManagement",
        "files",
        "asks",
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

  it("each preset is a value a mint accepts", () => {
    for (const preset of Object.values(API_TOKEN_PRESETS)) {
      expect(parseApiTokenLimits(preset)).toEqual(preset);
    }
  });
});
