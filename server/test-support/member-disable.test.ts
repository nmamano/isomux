// The disable verb moves the member's files back (server/member-user-admin.ts,
// internal-docs/member-os-user-design.md 2.3; slice 1c-ii-b of task
// b94dfd25). The member is isolated and connected through the real connect
// (member-host-fixture.ts); each step of the move is a recording dep. The
// properties: the refusals come before any hold (not isolated, not
// connected, a move in progress); keepFiles forgets the member with no
// move; a disable holds, plans and moves after the hold, writes the pins
// after the files, removes the member's copy after the pins, and forgets the
// record last; a failure at any step keeps the record and the member's copy,
// undoes the office's side once it was written, and releases.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  handleMemberUserAdmin,
  setMemberUserAdminDeps,
} from "../member-user-admin.ts";
import {
  forgetMemberHost,
  hostFor,
  memberHostConnected,
} from "../member-hosts.ts";
import { memberOsUserState } from "../member-os-users.ts";
import { officeAgentHost, type AgentHost } from "../agent-host.ts";
import type { MemberMoveOutPlan, MoveOutResult } from "../member-move-out.ts";
import { createMember, deleteUserById } from "../users.ts";
import { isolateMember, type IsolatedMember } from "./member-host-fixture.ts";

let iso: IsolatedMember;
let alice: string;
let steps: string[];
let seen: Record<string, string>;
let holds: (() => void)[];
const created: string[] = [];

beforeEach(async () => {
  const made = createMember(`DisAlice${created.length}`, { role: "member" });
  if (!made.ok) throw new Error(made.error);
  alice = made.user.id;
  created.push(alice);
  iso = await isolateMember(alice);
  steps = [];
  seen = {};
  holds = [];
});

afterEach(() => {
  for (const release of holds.splice(0)) release();
  setMemberUserAdminDeps(null);
  iso.dispose();
  for (const id of created.splice(0)) deleteUserById(id);
});

const PLAN = { userId: "", sources: [], personal: [] } as MemberMoveOutPlan;

// Every step recorded with the record state it saw; `fail` throws there.
// `waitHold` keeps the hold pending until releaseHolds().
function moveDeps(fail?: string, waitHold = false) {
  const step = (name: string) => {
    steps.push(name);
    seen[name] = memberOsUserState(alice).kind;
    if (name === fail) throw new Error(`${name} failed`);
  };
  setMemberUserAdminDeps({
    enabled: true,
    holdMember: async () => {
      steps.push("hold");
      if (waitHold) await new Promise<void>((resolve) => holds.push(resolve));
      steps.push("held");
    },
    releaseMember: () => void steps.push("release"),
    memberAgents: () => [],
    moveHost: (userId) => (step("moveHost"), hostFor(userId) as AgentHost),
    planMoveOut: () => (step("plan"), PLAN),
    transferOut: async (): Promise<MoveOutResult> => {
      step("transfer");
      return {
        pins: [],
        undo: () => void steps.push("undo"),
        removeMemberCopy: async () => step("remove"),
        done: () => void steps.push("done"),
      };
    },
    applyPins: () => step("pins"),
  });
}

async function disable(body: Record<string, unknown> = {}) {
  const response = await handleMemberUserAdmin("/admin/member-user/disable", {
    member: alice,
    ...body,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("disable", () => {
  it("holds, plans after the hold, writes the pins after the files, removes the member's copy after the pins, and forgets the record last", async () => {
    moveDeps();
    expect(memberHostConnected(alice)).toBe(true);
    const answer = await disable();
    expect(answer.body).toMatchObject({ ok: true });
    expect(steps).toEqual([
      "hold",
      "held",
      "moveHost",
      "plan",
      "transfer",
      "pins",
      "remove",
      "release",
      "done",
    ]);
    for (const name of ["plan", "transfer", "pins", "remove"])
      expect([name, seen[name]]).toEqual([name, "isolated"]);
    expect(memberOsUserState(alice).kind).toBe("none");
    expect(hostFor(alice) === officeAgentHost()).toBe(true);
  });

  for (const fail of ["plan", "transfer", "pins"])
    it(`keeps the record and the member's copy after a failure at ${fail}, and releases`, async () => {
      moveDeps(fail);
      const answer = await disable();
      expect(answer.body.ok).toBe(false);
      expect(steps).not.toContain("remove");
      expect(steps.filter((s) => s === "undo")).toHaveLength(
        fail === "pins" ? 1 : 0,
      );
      expect(steps.filter((s) => s === "release")).toHaveLength(1);
      expect(memberOsUserState(alice).kind).toBe("isolated");
      expect(memberHostConnected(alice)).toBe(true);
    });

  it("refuses a member whose runner is not connected, and holds nothing", async () => {
    moveDeps();
    forgetMemberHost(alice);
    const answer = await disable();
    expect([answer.status, answer.body.error]).toEqual([409, "not_connected"]);
    expect(steps).toEqual([]);
    expect(memberOsUserState(alice).kind).toBe("isolated");
  });

  it("with keepFiles, forgets the member with no move, even when not connected", async () => {
    moveDeps();
    forgetMemberHost(alice);
    const answer = await disable({ keepFiles: true });
    expect(answer.body).toEqual({ ok: true, kept: true });
    expect(steps).toEqual([]);
    expect(memberOsUserState(alice).kind).toBe("none");
  });

  it("refuses a member with no OS user of their own", async () => {
    moveDeps();
    const bobMade = createMember(`DisBob${created.length}`, { role: "member" });
    if (!bobMade.ok) throw new Error(bobMade.error);
    created.push(bobMade.user.id);
    const response = await handleMemberUserAdmin("/admin/member-user/disable", {
      member: bobMade.user.id,
    });
    expect([
      response.status,
      ((await response.json()) as { error?: string }).error,
    ]).toEqual([409, "not_isolated"]);
    expect(steps).toEqual([]);
  });

  it("refuses a second disable while one moves, and holds nothing for it", async () => {
    moveDeps(undefined, true);
    const first = disable();
    for (let i = 0; i < 200 && !steps.includes("hold"); i++) await Bun.sleep(1);
    const second = await Promise.race([
      disable(),
      Bun.sleep(300).then(() => null),
    ]);
    const holdsAsked = steps.filter((s) => s === "hold").length;
    for (const release of holds.splice(0)) release();
    expect(second?.body.error).toBe("move_in_progress");
    expect(holdsAsked).toBe(1);
    expect((await first).body).toMatchObject({ ok: true });
  });
});
