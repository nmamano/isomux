// A manager change between hosts moves the agent (server/agent-host-move.ts,
// internal-docs/member-os-user-design.md 2.4, task abdb452b). The
// orchestration, with every host and file step a recording stand-in. The
// properties:
//   - a refusal (a runner not connected, a member busy, the ceiling, an
//     unknown agent, a second move of the agent) changes nothing and holds
//     nothing;
//   - the move claims exactly the members that have an OS user, and gives
//     them back on every outcome;
//   - each direction runs its own steps in order: the hold before the
//     apps leave, the apps before the files, the clamp after the files,
//     the pins before the fields to the office and after them to a member;
//   - member->member plans its second stage from what the first placed,
//     never from a new search;
//   - a failure before the fields undoes the files, puts the apps back on
//     the old host, releases the agent and writes one chat line;
//   - the folder and each moved app's folder follow the new host's rule.
// Copy is never matched: the reason of a failure is checked to carry the
// stand-in's own error text.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  agentHostMoving,
  moveAgentHost,
  setAgentHostMoveDeps,
  setAgentHostMoveWiring,
  type AgentHostChange,
  type AgentHostMoveResult,
} from "./agent-host-move.ts";
import type { AgentHost } from "./agent-host.ts";
import type { CeilingClamp } from "./member-ceiling.ts";
import type { CwdProblem } from "./cwd-utils.ts";
import type { MemberMovePlan, PinChange, StagedMove } from "./member-move.ts";
import type { MoveOutResult } from "./member-move-out.ts";
import { createMember, deleteUserById } from "./users.ts";
import type { AgentInfo, AppRecord } from "../shared/types.ts";

const OFFICE_UID = 1000;
const AGENT = "agent-host-move-1";
const CWD = "/srv/work/repo";

// The members this file made, deleted after each test: a member left in
// the users store breaks later files in the same bun process.
const created: string[] = [];
function member(name: string): string {
  const made = createMember(name, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  created.push(made.user.id);
  return made.user.id;
}

let zoe = ""; // no OS user: the office's host
let alice = ""; // own OS user
let bob = ""; // own OS user

beforeEach(() => {
  const n = created.length;
  zoe = member(`HostMoveZoe${n}`);
  alice = member(`HostMoveAlice${n}`);
  bob = member(`HostMoveBob${n}`);
});

afterEach(() => {
  setAgentHostMoveDeps(null);
  setAgentHostMoveWiring(null);
  for (const id of created.splice(0)) deleteUserById(id);
});

interface Options {
  from: () => string;
  to: () => string;
  // The members whose runner is connected (default: every isolated one).
  connected?: () => string[];
  // Members already claimed by a go-on, a disable or another move.
  busy?: () => string[];
  clamp?: CeilingClamp;
  cwd?: string;
  // The owners of a path and its ancestors (default: root and the office).
  owners?: (path: string) => number[];
  // A folder that a member's host cannot enter: `${userId}:${path}`.
  problems?: () => string[];
  apps?: () => AppRecord[];
  fail?: Partial<
    Record<"stageIn" | "transferOut" | "setAccess" | "pins" | "vanish", boolean>
  >;
  // Runs inside stageIn or transferOut, before it answers.
  during?: () => Promise<void>;
}

function world(o: Options) {
  const uids: Record<string, number> = { [alice]: 2001, [bob]: 2002 };
  const isolated = new Set([alice, bob]);
  const connected = new Set(o.connected ? o.connected() : [alice, bob]);
  const busy = new Set(o.busy ? o.busy() : []);
  const problems = new Set(o.problems ? o.problems() : []);
  const apps = o.apps ? o.apps() : [];
  const events: string[] = [];
  const lines: string[] = [];
  const changes: AgentHostChange[] = [];
  const claims: string[][] = [];
  const planInTrees: string[][] = [];
  const planOutNames: string[][] = [];
  const kept: string[][] = [];
  const grants: { access?: string }[] = [];
  let outGiven: MoveOutResult | null = null;
  let outSeen: MoveOutResult | null = null;
  let gone = false;
  const agent = {
    id: AGENT,
    name: "Mover",
    userId: o.from(),
    manager: "old",
    cwd: o.cwd ?? CWD,
    agentType: "claude",
    access: "standard",
  } as unknown as AgentInfo;
  const host = (userId: string) =>
    ({
      kind: "runner",
      member: userId,
      home: () => `/home/os-${userId}`,
      agentRoot: () => `/home/os-${userId}/.isomux-agent`,
    }) as unknown as AgentHost;
  const pin = (root: string): PinChange[] => [
    { agentId: AGENT, sessionId: "s-1", root },
  ];
  const fail = o.fail ?? {};
  setAgentHostMoveWiring({
    getAgent: (id) => (id === AGENT && !gone ? agent : undefined),
    clampFor: () => o.clamp ?? { kind: "keep" },
    setAccess: async (_id, grant) => {
      events.push("setAccess");
      if (fail.setAccess) throw new Error("stand-in access refused");
      grants.push(grant as { access?: string });
      (agent as { access: unknown }).access = grant;
      return agent;
    },
    holdAgent: async () => {
      events.push("hold");
    },
    releaseAgent: () => {
      events.push("release");
    },
    setManager: async (_id, toUserId, _manager, _by, change) => {
      events.push("setManager");
      changes.push(change);
      change.beforeFields();
      events.push("fields");
      (agent as { userId: string }).userId = toUserId;
      if (change.cwd) (agent as { cwd: string }).cwd = change.cwd.to;
      change.afterFields();
      return agent;
    },
    agentApps: (_id, fromUserId) =>
      apps.filter((app) => app.userId === fromUserId),
    transferMade: (_id, _from, _to, keepApps) => {
      events.push("transferMade");
      kept.push([...keepApps].sort());
    },
    systemLine: (_id, text) => {
      lines.push(text);
    },
  });
  setAgentHostMoveDeps({
    hasOsUser: (userId) => !!userId && isolated.has(userId),
    memberHost: (userId) => (connected.has(userId) ? host(userId) : undefined),
    claimMembers: (ids) => {
      if (ids.some((id) => busy.has(id))) return false;
      for (const id of ids) busy.add(id);
      claims.push([...ids].sort());
      return true;
    },
    releaseMembers: (ids) => {
      for (const id of ids) busy.delete(id);
    },
    planIn: (_agent, _from, toUserId, appTrees) => {
      events.push("planIn");
      planInTrees.push(appTrees.map((tree) => tree.destParts.at(-1)!));
      return {
        userId: toUserId,
        trees: appTrees,
        codex: [],
        claude: [
          {
            agentId: AGENT,
            sessionId: "s-1",
            cwd: CWD,
            root: "/office/claude",
            personal: false,
          },
        ],
      } satisfies MemberMovePlan;
    },
    planInFromOut: (_agent, out, toUserId) => {
      events.push("planInFromOut");
      outSeen = out;
      return {
        userId: toUserId,
        trees: [],
        codex: [],
        claude: [
          {
            agentId: AGENT,
            sessionId: "s-1",
            cwd: CWD,
            root: "/office/claude",
            personal: false,
          },
        ],
      };
    },
    stageIn: async (_plan, to) => {
      events.push(`stageIn ${to.member}`);
      await o.during?.();
      if (fail.vanish) gone = true;
      if (fail.stageIn) throw new Error("stand-in runner refused files-in");
      return {
        pins: pin(`/home/os-${to.member}/.claude`),
        undo: async () => {
          events.push("stage undo");
        },
        done: async () => {
          events.push("stage done");
        },
        deleteOfficeCopies: () => {
          events.push("office copies deleted");
        },
      } satisfies StagedMove;
    },
    planOut: (_agent, fromUserId, _host, appNames) => {
      events.push("planOut");
      planOutNames.push([...appNames].sort());
      return { userId: fromUserId, sources: [], personal: [] };
    },
    transferOut: async () => {
      events.push("transferOut");
      await o.during?.();
      if (fail.transferOut)
        throw new Error("stand-in runner refused files-out");
      outGiven = {
        pins: pin("/office/claude"),
        undo: () => {
          events.push("out undo");
        },
        removeMemberCopy: async () => {
          events.push("member copies removed");
        },
        done: () => {
          events.push("out done");
        },
      } as unknown as MoveOutResult;
      return outGiven;
    },
    applyPins: (pins) => {
      events.push(`pins ${pins.map((p) => p.root).join(",")}`);
      if (fail.pins) throw new Error("stand-in pin write failed");
    },
    appsLeave: async (userId, names) => {
      events.push(`appsLeave ${userId} ${[...names].sort().join(",")}`);
      return names.map((name) => ({ name, running: true }));
    },
    appsArrive: (userId, left) => {
      events.push(
        `appsArrive ${userId} ${left
          .map((l) => l.name)
          .sort()
          .join(",")}`,
      );
    },
    cwdProblem: async (cwd, userId) =>
      problems.has(`${userId}:${cwd}`)
        ? ({ kind: "inaccessible", path: cwd } satisfies CwdProblem)
        : null,
    ownerUids: (path) => (o.owners ? o.owners(path) : [0, OFFICE_UID]),
    osUid: (userId) => uids[userId],
    agentHome: (userId) => `/home/of-${userId}`,
    removeShareFiles: (userId) => {
      events.push(`share files removed ${userId}`);
    },
    refreshSkills: () => {
      events.push("skills");
    },
    log: () => {},
  });
  return {
    agent,
    events,
    lines,
    changes,
    claims,
    busy,
    planInTrees,
    planOutNames,
    kept,
    grants,
    out: () => ({ given: outGiven, seen: outSeen }),
    move: () => moveAgentHost(AGENT, o.to(), "Owner"),
  };
}

const at = (events: string[], event: string): number => {
  const i = events.indexOf(event);
  if (i < 0) throw new Error(`no "${event}" in ${JSON.stringify(events)}`);
  return i;
};

// Each pair [a, b]: a comes before b.
function inOrder(events: string[], pairs: [string, string][]): void {
  for (const [a, b] of pairs)
    expect([a, b, at(events, a) < at(events, b)]).toEqual([a, b, true]);
}

const notOk = (r: AgentHostMoveResult) =>
  r.ok ? { ok: true } : { ok: false, status: r.status, code: r.code };

// The steps that change something; a refusal runs none.
const EFFECTS = [
  "hold",
  "setAccess",
  "planIn",
  "planOut",
  "transferOut",
  "setManager",
  "fields",
];
const effects = (events: string[]) =>
  events.filter(
    (e) =>
      EFFECTS.includes(e) ||
      e.startsWith("stageIn") ||
      e.startsWith("appsLeave") ||
      e.startsWith("pins"),
  );

const app = (name: string, userId: string, cwd: string): AppRecord =>
  ({
    name,
    cwd,
    userId,
    username: "x",
    createdBy: "Mover",
    createdByAgentId: AGENT,
  }) as unknown as AppRecord;

describe("a refusal changes nothing and holds nothing", () => {
  // MUTANT: no connected check for the new member (dies on office->Alice:
  // stageIn runs); none for the old member (dies on Alice->office).
  it("refuses member_os_user when a runner the move needs is not connected", async () => {
    const rows: [string, () => string, () => string, () => string[]][] = [
      ["office->Alice, Alice off", () => zoe, () => alice, () => [bob]],
      ["Alice->office, Alice off", () => alice, () => zoe, () => [bob]],
      ["Alice->Bob, Bob off", () => alice, () => bob, () => [alice]],
      ["Alice->Bob, Alice off", () => alice, () => bob, () => [bob]],
    ];
    for (const [label, from, to, connected] of rows) {
      const w = world({ from, to, connected });
      const r = await w.move();
      expect([label, notOk(r)]).toEqual([
        label,
        { ok: false, status: 409, code: "member_os_user" },
      ]);
      expect([label, effects(w.events)]).toEqual([label, []]);
      expect([label, [...w.busy]]).toEqual([label, []]);
      expect([label, w.agent.userId]).toEqual([label, from()]);
      expect(agentHostMoving(AGENT)).toBe(false);
    }
  });

  // MUTANT: no claim (dies: the move runs while Alice's go-on runs); a
  // claim of the new member only (dies on Alice->Bob with Alice busy).
  it("refuses move_in_progress while either member is busy, and claims nothing", async () => {
    const rows: [string, () => string, () => string, () => string[]][] = [
      ["office->Alice, Alice busy", () => zoe, () => alice, () => [alice]],
      ["Alice->office, Alice busy", () => alice, () => zoe, () => [alice]],
      ["Alice->Bob, Alice busy", () => alice, () => bob, () => [alice]],
      ["Alice->Bob, Bob busy", () => alice, () => bob, () => [bob]],
    ];
    for (const [label, from, to, busy] of rows) {
      const w = world({ from, to, busy });
      const r = await w.move();
      expect([label, notOk(r)]).toEqual([
        label,
        { ok: false, status: 409, code: "move_in_progress" },
      ]);
      expect([label, effects(w.events)]).toEqual([label, []]);
      // Only the go-on's own claim is left.
      expect([label, [...w.busy]]).toEqual([label, busy()]);
    }
  });

  // MUTANT: the ceiling checked after the hold (dies: hold runs).
  it("refuses cannot_move_down before it holds anything", async () => {
    const w = world({
      from: () => zoe,
      to: () => alice,
      clamp: { kind: "cannot", grant: "standard" as never },
    });
    const r = await w.move();
    expect(notOk(r)).toEqual({
      ok: false,
      status: 409,
      code: "cannot_move_down",
    });
    expect(effects(w.events)).toEqual([]);
    expect([...w.busy]).toEqual([]);
  });

  it("answers agent_not_found for an agent it does not know", async () => {
    const w = world({ from: () => zoe, to: () => alice });
    const r = await moveAgentHost("agent-not-there", alice, "Owner");
    expect(notOk(r)).toEqual({
      ok: false,
      status: 404,
      code: "agent_not_found",
    });
    expect(effects(w.events)).toEqual([]);
  });

  // MUTANT: agentHostMoving always false, or the per-agent mark cleared
  // before the move ends (dies on the second move or on the mark).
  it("refuses a second move of the same agent while the first runs, and marks the agent until it ends", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const w = world({
      from: () => zoe,
      to: () => alice,
      during: async () => {
        entered();
        await gate;
      },
    });
    expect(agentHostMoving(AGENT)).toBe(false);
    const first = w.move();
    await inside;
    expect(agentHostMoving(AGENT)).toBe(true);
    const second = await moveAgentHost(AGENT, bob, "Owner");
    expect(notOk(second)).toEqual({
      ok: false,
      status: 409,
      code: "move_in_progress",
    });
    open();
    expect((await first).ok).toBe(true);
    expect(agentHostMoving(AGENT)).toBe(false);
    // One files-in only: the second move did not reach the files.
    expect(w.events.filter((e) => e.startsWith("stageIn"))).toHaveLength(1);
  });
});

describe("the members a move claims", () => {
  // MUTANT: claim [from, to] whatever their host (dies on the office
  // member in the claim); release skipped on a failure (dies on the
  // failing rows).
  it("claims exactly the members with an OS user and gives them back, moved or failed", async () => {
    const rows: [
      string,
      () => string,
      () => string,
      () => string[],
      boolean,
    ][] = [
      ["office->Alice", () => zoe, () => alice, () => [alice], false],
      ["Alice->office", () => alice, () => zoe, () => [alice], false],
      ["Alice->Bob", () => alice, () => bob, () => [alice, bob].sort(), false],
      ["office->Alice, fails", () => zoe, () => alice, () => [alice], true],
      ["Alice->office, fails", () => alice, () => zoe, () => [alice], true],
    ];
    for (const [label, from, to, claimed, failing] of rows) {
      const w = world({
        from,
        to,
        fail: failing ? { stageIn: true, transferOut: true } : {},
      });
      const r = await w.move();
      expect([label, r.ok]).toEqual([label, !failing]);
      expect([label, w.claims]).toEqual([label, [claimed()]]);
      expect([label, [...w.busy]]).toEqual([label, []]);
      expect([label, agentHostMoving(AGENT)]).toEqual([label, false]);
    }
  });
});

describe("office -> member", () => {
  // MUTANT: pins before the fields on a move to a member (dies on the
  // fields/pins order); the clamp before the files (dies on
  // stageIn/setAccess); the release before the apps arrive (dies on
  // appsArrive/release).
  it("holds, tears down, stages, clamps, writes the fields then the pins, installs, cleans up and releases, in that order", async () => {
    const w = world({
      from: () => zoe,
      to: () => alice,
      clamp: { kind: "move", grant: "office" as never },
      apps: () => [app("made-app", zoe, "/srv/made-app")],
    });
    const r = await w.move();
    expect(r.ok).toBe(true);
    expect(w.agent.userId).toBe(alice);
    const e = w.events;
    const pins = `pins /home/os-${alice}/.claude`;
    inOrder(e, [
      ["hold", `appsLeave ${zoe} made-app`],
      [`appsLeave ${zoe} made-app`, `stageIn ${alice}`],
      [`stageIn ${alice}`, "setAccess"],
      ["setAccess", "setManager"],
      ["fields", pins],
      ["fields", `appsArrive ${alice} made-app`],
      ["fields", "skills"],
      ["fields", "office copies deleted"],
      [`appsArrive ${alice} made-app`, "release"],
      ["skills", "release"],
      ["office copies deleted", "release"],
    ]);
    expect(w.planInTrees).toEqual([["made-app"]]);
    // Nothing of a member's share to clean: the old host is the office's.
    expect(e.filter((x) => x.startsWith("share files removed"))).toEqual([]);
    expect(w.lines).toEqual([]);
  });
});

describe("a legacy agent with no manager", () => {
  // MUTANT: appsLeave(from ?? "") (dies: the app it made is not torn down
  // on the office, while transferMade gives it to Alice).
  it("tears down on the office the apps it made with no owner, and installs them on the new host", async () => {
    const w = world({
      from: () => null as unknown as string,
      to: () => alice,
      apps: () => [app("legacy-app", null as unknown as string, "/srv/legacy")],
    });
    const r = await w.move();
    expect(r.ok).toBe(true);
    inOrder(w.events, [
      ["hold", "appsLeave null legacy-app"],
      ["appsLeave null legacy-app", `stageIn ${alice}`],
      ["fields", `appsArrive ${alice} legacy-app`],
    ]);
  });
});

describe("member -> office", () => {
  // MUTANT: pins after the fields on a move to the office (dies on the
  // pins/fields order); the member's copies removed before the fields
  // (dies on fields/member copies removed).
  it("reads the files back, writes the pins then the fields, then removes the member's copies and share files", async () => {
    const w = world({
      from: () => alice,
      to: () => zoe,
      apps: () => [app("made-app", alice, "/srv/made-app")],
    });
    const r = await w.move();
    expect(r.ok).toBe(true);
    expect(w.agent.userId).toBe(zoe);
    const e = w.events;
    inOrder(e, [
      ["hold", `appsLeave ${alice} made-app`],
      [`appsLeave ${alice} made-app`, "transferOut"],
      ["pins /office/claude", "fields"],
      ["fields", "member copies removed"],
      ["fields", `share files removed ${alice}`],
      ["fields", `appsArrive ${zoe} made-app`],
      [`appsArrive ${zoe} made-app`, "release"],
      ["member copies removed", "release"],
    ]);
    expect(w.planOutNames).toEqual([["made-app"]]);
    expect(e.filter((x) => x.startsWith("stageIn"))).toEqual([]);
  });
});

describe("member -> member", () => {
  // MUTANT: the second stage planned with planIn, a new root search (dies
  // on planIn and on the out object).
  it("goes through the office: the second stage is planned from what the first placed", async () => {
    const w = world({ from: () => alice, to: () => bob });
    const r = await w.move();
    expect(r.ok).toBe(true);
    expect(w.agent.userId).toBe(bob);
    const e = w.events;
    expect(e).not.toContain("planIn");
    expect(w.out().seen).not.toBeNull();
    expect(w.out().seen === w.out().given).toBe(true);
    inOrder(e, [
      ["transferOut", "planInFromOut"],
      ["planInFromOut", `stageIn ${bob}`],
      [`stageIn ${bob}`, "setManager"],
      ["fields", `pins /home/os-${bob}/.claude`],
      ["fields", "member copies removed"],
      ["fields", "office copies deleted"],
      ["fields", `share files removed ${alice}`],
      ["member copies removed", "release"],
    ]);
  });
});

describe("a failure before the fields changes nothing", () => {
  // MUTANT: no undo of the staged files on a failed clamp (dies on "stage
  // undo"); the apps not put back (dies on appsArrive to the old member);
  // no chat line (dies on lines); the member's copies removed on a
  // failure (dies on "member copies removed"); the clamp kept after a
  // later failure (dies on the grants of the clamp row).
  it("undoes the files, puts the apps back where they ran, releases the agent and writes one chat line", async () => {
    const rows: {
      label: string;
      from: () => string;
      to: () => string;
      fail: Options["fail"];
      clamp?: CeilingClamp;
      undo: string | null;
      text: string;
      // The clamp ran before the failure: its grant is given back.
      restored?: boolean;
    }[] = [
      {
        label: "office->Alice, files-in fails",
        from: () => zoe,
        to: () => alice,
        fail: { stageIn: true },
        undo: null,
        text: "files-in",
      },
      {
        label: "office->Alice, the clamp fails",
        from: () => zoe,
        to: () => alice,
        fail: { setAccess: true },
        clamp: { kind: "move", grant: "office" as never },
        undo: "stage undo",
        text: "access refused",
      },
      {
        label: "Alice->office, files-out fails",
        from: () => alice,
        to: () => zoe,
        fail: { transferOut: true },
        undo: null,
        text: "files-out",
      },
      {
        label: "Alice->office, the pins fail",
        from: () => alice,
        to: () => zoe,
        fail: { pins: true },
        undo: "out undo",
        text: "pin write",
      },
      {
        label: "Alice->office, the pins fail after the clamp",
        from: () => alice,
        to: () => zoe,
        fail: { pins: true },
        clamp: { kind: "move", grant: { access: "office" } as never },
        undo: "out undo",
        text: "pin write",
        restored: true,
      },
      {
        label: "Alice->Bob, the second stage fails",
        from: () => alice,
        to: () => bob,
        fail: { stageIn: true },
        undo: "out undo",
        text: "files-in",
      },
    ];
    for (const row of rows) {
      const from = row.from();
      const w = world({
        from: row.from,
        to: row.to,
        fail: row.fail,
        clamp: row.clamp,
        apps: () => [app("made-app", from, "/srv/made-app")],
      });
      const r = await w.move();
      const label = row.label;
      expect([label, notOk(r)]).toEqual([
        label,
        { ok: false, status: 500, code: "host_move_failed" },
      ]);
      expect([label, !r.ok && r.reason.includes(row.text)]).toEqual([
        label,
        true,
      ]);
      expect([label, w.agent.userId]).toEqual([label, from]);
      expect([label, w.events.includes("fields")]).toEqual([label, false]);
      if (row.undo)
        expect([label, w.events.includes(row.undo)]).toEqual([label, true]);
      expect([
        label,
        w.events.filter((e) => e.startsWith("appsArrive")),
      ]).toEqual([label, [`appsArrive ${from} made-app`]]);
      for (const never of [
        "member copies removed",
        "office copies deleted",
        "transferMade",
      ])
        expect([label, never, w.events.includes(never)]).toEqual([
          label,
          never,
          false,
        ]);
      expect([label, w.events.at(-1)]).toEqual([label, "release"]);
      expect([label, w.lines.length]).toEqual([label, 1]);
      if (row.restored)
        expect([label, w.grants.map((g) => g.access)]).toEqual([
          label,
          ["office", "standard"],
        ]);
      expect([label, [...w.busy]]).toEqual([label, []]);
      expect([label, agentHostMoving(AGENT)]).toEqual([label, false]);
    }
  });

  // MUTANT: no getAgent check after the files await (dies: setManager runs
  // for an agent that is gone).
  it("undoes the files when the agent is gone during the move", async () => {
    const w = world({
      from: () => zoe,
      to: () => alice,
      fail: { vanish: true },
    });
    const r = await w.move();
    expect(notOk(r)).toEqual({
      ok: false,
      status: 500,
      code: "host_move_failed",
    });
    expect(w.events).toContain("stage undo");
    expect(w.events).not.toContain("setManager");
    expect([...w.busy]).toEqual([]);
  });
});

describe("the folder", () => {
  const ALICE_UID = 2001;
  // MUTANT: the rule as "inside the old member's home" (dies on the
  // Alice-owned ancestor outside her home); the ownership rule on a move to
  // a member too (dies on Alice->Bob); cwdProblem asked for the old manager
  // (dies on the problem rows).
  it("goes to the new manager's home when the new host cannot use it, and stays otherwise", async () => {
    const rows: {
      label: string;
      from: () => string;
      to: () => string;
      owners?: (path: string) => number[];
      problems?: () => string[];
      reset: boolean;
    }[] = [
      {
        label: "to the office, an ancestor Alice owns",
        from: () => alice,
        to: () => zoe,
        owners: () => [0, ALICE_UID, OFFICE_UID],
        reset: true,
      },
      {
        label: "to the office, the folder Alice owns",
        from: () => alice,
        to: () => zoe,
        owners: () => [0, OFFICE_UID, ALICE_UID],
        reset: true,
      },
      {
        label: "to the office, owned by root and the office",
        from: () => alice,
        to: () => zoe,
        reset: false,
      },
      {
        label: "to the office, the office cannot enter it",
        from: () => alice,
        to: () => zoe,
        problems: () => [`${zoe}:${CWD}`],
        reset: true,
      },
      {
        label: "to Alice, she can enter it",
        from: () => zoe,
        to: () => alice,
        reset: false,
      },
      {
        label: "to Alice, she cannot enter it",
        from: () => zoe,
        to: () => alice,
        problems: () => [`${alice}:${CWD}`],
        reset: true,
      },
      {
        label: "Alice to Bob, an Alice-owned folder Bob can enter",
        from: () => alice,
        to: () => bob,
        owners: () => [0, ALICE_UID],
        reset: false,
      },
      {
        label: "Alice to Bob, Bob cannot enter it",
        from: () => alice,
        to: () => bob,
        problems: () => [`${bob}:${CWD}`],
        reset: true,
      },
    ];
    for (const row of rows) {
      const w = world({
        from: row.from,
        to: row.to,
        owners: row.owners,
        problems: row.problems,
      });
      const r = await w.move();
      expect([row.label, r.ok]).toEqual([row.label, true]);
      expect([row.label, w.changes.length]).toEqual([row.label, 1]);
      expect([row.label, w.changes[0].cwd]).toEqual([
        row.label,
        row.reset ? { from: CWD, to: `/home/of-${row.to()}` } : null,
      ]);
    }
  });

  // MUTANT: the moved apps not checked (dies: the Alice-owned app moves
  // to the office).
  it("keeps with the old manager an app whose folder the new host must not use", async () => {
    const aliceHome = "/home/os-alice-app";
    const w = world({
      from: () => alice,
      to: () => zoe,
      owners: (path) =>
        path.startsWith(aliceHome) ? [0, ALICE_UID] : [0, OFFICE_UID],
      apps: () => [
        app("app-ok", alice, "/srv/app-ok"),
        app("app-hers", alice, `${aliceHome}/app`),
      ],
    });
    const r = await w.move();
    expect(r.ok).toBe(true);
    expect(w.events).toContain(`appsLeave ${alice} app-ok`);
    expect(w.events).toContain(`appsArrive ${zoe} app-ok`);
    expect(w.planOutNames).toEqual([["app-ok"]]);
    expect(w.kept).toEqual([["app-hers"]]);
    expect(w.changes[0].appsStayed).toEqual(["app-hers"]);
  });

  it("keeps with the old manager an app whose folder the new member cannot enter", async () => {
    const w = world({
      from: () => zoe,
      to: () => alice,
      problems: () => [`${alice}:/srv/office-app`],
      apps: () => [
        app("app-ok", zoe, "/srv/app-ok"),
        app("app-office", zoe, "/srv/office-app"),
      ],
    });
    const r = await w.move();
    expect(r.ok).toBe(true);
    expect(w.events).toContain(`appsLeave ${zoe} app-ok`);
    expect(w.planInTrees).toEqual([["app-ok"]]);
    expect(w.kept).toEqual([["app-office"]]);
    expect(w.changes[0].appsStayed).toEqual(["app-office"]);
  });
});
