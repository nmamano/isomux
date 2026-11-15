// The reach of a member with their own OS user (task b94dfd25 part 2c,
// server/identity/member-reach.ts), against the rule functions with faked
// guard deps. The office: Alice has her own OS user and manages agent
// "alice-agent"; Bob has none and manages "bob-agent"; the owner manages
// "office-agent"; "gone" is no live agent.
//
// What each test pins, and the mutant it was seen red on, is named above it.

import { describe, expect, it } from "bun:test";
import { API_ROUTES } from "../routes/table.ts";
import type { Identity } from "./index.ts";
import type { GuardDeps } from "./guards.ts";
import {
  agentReachRefusal,
  MEMBER_REACH,
  memberReachRefusal,
  promptAnswerRefused,
  reachActor,
  reachRuleRefusal,
  REACH_TABLE,
  WS_REACH,
  type ReachRule,
} from "./member-reach.ts";

function office(managers: Record<string, string | null> = {}) {
  const manager: Record<string, string | null> = {
    "alice-agent": "alice",
    "alice-agent-2": "alice",
    "bob-agent": "bob",
    "office-agent": "owner",
    "unmanaged-agent": null,
    ...managers,
  };
  const killed: Record<string, string> = {
    "alice-killed": "alice",
    "office-killed": "owner",
  };
  const deps = {
    roomIdForAgent: (id: string) => (id in manager ? "room-1" : null),
    agentManagerUserId: (id: string) => manager[id] ?? null,
    killedAgentManagerUserId: (id: string) => killed[id] ?? null,
    memberIsolated: (userId: string) => userId === "alice",
  } as unknown as GuardDeps;
  return { deps, manager };
}

const user = (userId: string, role: "owner" | "member" = "member"): Identity =>
  ({ scope: "user", userId, role, capabilities: [] }) as Identity;
const api = (userId: string): Identity =>
  ({ scope: "api", userId, role: "member", capabilities: [] }) as Identity;
const agentToken = (agentId: string, spawnedBy: string | null): Identity =>
  ({
    scope: "agent",
    userId: spawnedBy,
    agentId,
    role: "member",
    capabilities: [],
  }) as Identity;
const cronRun = (userId: string | null): Identity =>
  ({ scope: "cron-run", userId, role: "member", capabilities: [] }) as Identity;
const app = (userId: string | null): Identity =>
  ({ scope: "app", userId, role: "member", capabilities: [] }) as Identity;

// A body that every gated rule refuses for an isolated actor.
const HOSTILE_BODY = {
  cwd: "/srv/office",
  permissionMode: "bypass",
  name: "x",
};
// Every param a rule reads, pointing at the office's agent.
const OFFICE_PARAMS = {
  id: "office-agent",
  agentId: "office-agent",
  roomId: "room-1",
};

describe("the table", () => {
  // MUTANT: a route left out of REACH_TABLE (dies on the set check).
  it("has one row for every route", () => {
    const routes = API_ROUTES.map((r) => r.opId).sort();
    const rows = Object.keys(REACH_TABLE).sort();
    expect(rows.filter((op) => !routes.includes(op))).toEqual([]);
    expect(routes.filter((op) => !rows.includes(op))).toEqual([]);
  });

  it("gives every open row a reason, and every refuse row a reason and a message", () => {
    const rules: ReachRule[] = [
      ...Object.values(REACH_TABLE),
      ...Object.values(WS_REACH),
    ];
    for (const rule of rules) {
      if (rule.kind === "open") expect(rule.reason.length).toBeGreaterThan(10);
      if (rule.kind === "refuse") {
        expect(rule.reason.length).toBeGreaterThan(10);
        expect(rule.message.length).toBeGreaterThan(10);
      }
    }
  });

  // The routes that let an actor act through another agent's host, or set
  // what an office agent loads, are gated. MUTANT per row: that row turned
  // open (dies on its name).
  it("gates every route that runs or loads code through another agent's host", () => {
    const { deps } = office();
    const gated = [
      "agents.openFile",
      "agents.saveFile",
      "agents.closeFile",
      "agents.runDeniedCommand",
      "agents.setInstructions",
      "agents.setAccess",
      "agents.setPrivileged",
      "agents.respondInteraction",
      "agents.update",
      "agents.setManager",
      "rooms.setInstructions",
      "rooms.rename",
      "skills.saveFile",
      "skills.create",
      "skills.deleteFile",
    ];
    const open = gated.filter(
      (op) =>
        memberReachRefusal(
          user("alice"),
          { opId: op },
          OFFICE_PARAMS,
          HOSTILE_BODY,
          deps,
        ) === null,
    );
    expect(open).toEqual([]);
    for (const frame of [
      "terminal_open",
      "terminal_input",
      "terminal_resize",
      "terminal_restart",
      "terminal_close",
      "terminal_status_request",
    ] as const)
      expect(WS_REACH[frame]).toEqual({ kind: "agent", param: "agentId" });
  });
});

describe("an actor without their own OS user", () => {
  // A1: an office with no isolated member is unchanged. Every row, with every
  // kind of actor that is not isolated, passes. The enabling condition: the
  // same calls refuse for Alice. MUTANTS: the not-isolated exit after the
  // rule (dies here); a gone agent's token refused whoever spawned it (dies
  // on the gone row).
  it("passes every route row and every WS row", () => {
    const { deps } = office();
    const actors: [string, Identity][] = [
      ["a member", user("bob")],
      ["an owner", user("owner", "owner")],
      ["an API token", api("bob")],
      ["an office agent's token", agentToken("office-agent", "owner")],
      ["Bob's agent's token", agentToken("bob-agent", "bob")],
      ["an unmanaged agent's token", agentToken("unmanaged-agent", null)],
      ["a gone agent's token", agentToken("gone", "bob")],
      ["an unowned cron run", cronRun(null)],
      ["Bob's cron run", cronRun("bob")],
      ["an office app", app(null)],
    ];
    const rows: [string, ReachRule][] = [
      ...Object.entries(REACH_TABLE),
      ...Object.entries(WS_REACH),
      ["no-such-route", undefined as unknown as ReachRule],
    ];
    const refused: string[] = [];
    for (const [who, identity] of actors)
      for (const [op, rule] of rows)
        if (
          reachRuleRefusal(
            rule,
            identity,
            OFFICE_PARAMS,
            HOSTILE_BODY,
            deps,
            op,
          )
        )
          refused.push(`${who}: ${op}`);
    expect(refused).toEqual([]);

    const aliceRefused = rows.filter(([op, rule]) =>
      reachRuleRefusal(
        rule,
        user("alice"),
        OFFICE_PARAMS,
        HOSTILE_BODY,
        deps,
        op,
      ),
    );
    expect(aliceRefused.length).toBeGreaterThan(30);
  });
});

describe("who the actor is", () => {
  // Q1. MUTANT: the agent scope resolved to identity.userId (the spawning
  // member) instead of the current manager (dies on both manager checks).
  it("is an agent's current manager, read at each call", () => {
    const { deps, manager } = office();
    // Bob spawned it; it now belongs to Alice.
    manager["moved-agent"] = "alice";
    const token = agentToken("moved-agent", "bob");
    expect(reachActor(token, deps)).toEqual({
      kind: "member",
      userId: "alice",
    });
    expect(agentReachRefusal(token, "office-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
    manager["moved-agent"] = "bob";
    expect(reachActor(token, deps)).toEqual({ kind: "member", userId: "bob" });
    expect(agentReachRefusal(token, "office-agent", deps)).toBeNull();
  });

  it("is the member of a session, an API token, a cron run and an app", () => {
    const { deps } = office();
    for (const identity of [
      user("alice"),
      api("alice"),
      cronRun("alice"),
      app("alice"),
    ]) {
      expect(reachActor(identity, deps)).toEqual({
        kind: "member",
        userId: "alice",
      });
      expect(agentReachRefusal(identity, "office-agent", deps)?.code).toBe(
        MEMBER_REACH,
      );
      expect(agentReachRefusal(identity, "alice-agent", deps)).toBeNull();
    }
  });

  // MUTANT: an unresolved actor that passes (dies on the gated row).
  it("is unresolved for a gone agent, which is refused on gated rows and passes open ones when its spawner is isolated", () => {
    const { deps } = office();
    const token = agentToken("gone", "alice");
    expect(reachActor(token, deps)).toEqual({ kind: "unresolved" });
    expect(agentReachRefusal(token, "alice-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
    expect(
      memberReachRefusal(
        token,
        { opId: "agents.logs" },
        OFFICE_PARAMS,
        {},
        deps,
      ),
    ).toBeNull();
  });
});

describe("the rules for Alice", () => {
  // MUTANT: ownsAgent always true (dies on the office agent).
  it("agent: her own agents only", () => {
    const { deps } = office();
    const alice = user("alice");
    expect(agentReachRefusal(alice, "office-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
    expect(agentReachRefusal(alice, "bob-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
    expect(agentReachRefusal(alice, "unmanaged-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
    expect(agentReachRefusal(alice, "gone", deps)?.code).toBe(MEMBER_REACH);
    expect(agentReachRefusal(alice, "alice-agent", deps)).toBeNull();
    // Her agent's token reaches her other agent, not the office's.
    const token = agentToken("alice-agent", "alice");
    expect(agentReachRefusal(token, "alice-agent-2", deps)).toBeNull();
    expect(agentReachRefusal(token, "office-agent", deps)?.code).toBe(
      MEMBER_REACH,
    );
  });

  // MUTANTS: the open-key check removed (dies on cwd); every key refused on
  // her own agent (dies on the own row).
  it("agentFields: only name and outfit on another agent, anything on her own", () => {
    const { deps } = office();
    const patch = (id: string, body: unknown) =>
      memberReachRefusal(
        user("alice"),
        { opId: "agents.update" },
        { id },
        body,
        deps,
      );
    expect(patch("office-agent", { name: "N", outfit: { hat: 1 } })).toBeNull();
    for (const key of [
      "cwd",
      "agentType",
      "customInstructions",
      "permissionMode",
      "codexSandbox",
      "model",
      "effort",
      "brandNewField",
    ])
      expect(patch("office-agent", { name: "N", [key]: "x" })?.code).toBe(
        MEMBER_REACH,
      );
    expect(patch("alice-agent", { cwd: "/x", permissionMode: "y" })).toBeNull();
  });

  // MUTANTS: the result compare removed (dies on the office revive); spawn
  // read from the actor instead of identity.userId (dies on the moved
  // agent's spawn).
  it("result: she spawns and revives only agents she manages", () => {
    const { deps, manager } = office();
    const call = (identity: Identity, opId: string, id?: string) =>
      memberReachRefusal(identity, { opId }, id ? { id } : {}, {}, deps);
    expect(call(user("alice"), "agents.spawn")).toBeNull();
    expect(call(user("alice"), "agents.revive", "alice-killed")).toBeNull();
    expect(call(user("alice"), "agents.revive", "office-killed")?.code).toBe(
      MEMBER_REACH,
    );
    // An agent Bob spawned that now runs as Alice: a spawn by its token would
    // make an agent for Bob, so it is refused (fail closed).
    manager["moved-agent"] = "alice";
    expect(call(agentToken("moved-agent", "bob"), "agents.spawn")?.code).toBe(
      MEMBER_REACH,
    );
    expect(call(agentToken("alice-agent", "alice"), "agents.spawn")).toBeNull();
  });

  // MUTANT: roomCwd refusing any body (dies on the rename).
  it("roomCwd: a rename passes, a folder does not", () => {
    const { deps } = office();
    const rename = (body: unknown) =>
      memberReachRefusal(
        user("alice"),
        { opId: "rooms.rename" },
        { roomId: "room-1" },
        body,
        deps,
      );
    expect(rename({ name: "Lab" })).toBeNull();
    expect(rename({ cwd: "/srv" })?.code).toBe(MEMBER_REACH);
    expect(rename({ name: "Lab", cwd: null })?.code).toBe(MEMBER_REACH);
  });

  // MUTANT: an unknown route open for an isolated actor (dies here).
  it("refuses a route the table does not know", () => {
    const { deps } = office();
    expect(
      memberReachRefusal(user("alice"), { opId: "no.such.route" }, {}, {}, deps)
        ?.code,
    ).toBe(MEMBER_REACH);
  });

  it("refuses an answer to another agent's prompt, and never her own", () => {
    const { deps } = office();
    expect(promptAnswerRefused(user("alice"), "office-agent", deps)).toBe(true);
    expect(promptAnswerRefused(user("alice"), "alice-agent", deps)).toBe(false);
    expect(promptAnswerRefused(user("bob"), "office-agent", deps)).toBe(false);
  });

  // Her own agent while her host is not ready: memberIsolated still answers
  // true, and the write passes.
  it("keeps her own agent while her host is not ready", () => {
    const { deps } = office();
    expect(
      memberReachRefusal(
        user("alice"),
        { opId: "agents.setInstructions" },
        { id: "alice-agent" },
        {},
        deps,
      ),
    ).toBeNull();
  });
});
