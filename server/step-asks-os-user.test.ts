// A member-os-user action step (task 4088f164): an agent asks the owner to
// turn a member's own OS user on or off from the ask card, as the Run on
// Settings › Members › OS user does. The properties, through createStepAsks
// with a fake of the office's reads:
// - the create stores the member by id and the target the agent named, and
//   refuses a bad shape (400), an unknown member (422), a member the asked
//   one could not run it for (403), an office with no Run (409), a done step
//   (409), a named user for a member who has one (409), an off for a member
//   who came with an office move (409), and a name that is not an existing
//   user (existing) or is taken (new) when the names were read in full
//   (422); a name that could not be read is accepted;
// - the step is done when the state reaches the asked one, and only then;
// - the run is the Members page's Run route under the member's name now,
//   with the target from the step only and the card's password only when it
//   is a string; it refuses a run when the state has changed since the create
//   so that the root command must refuse it, or a run or a move goes on.
// The office wiring, the password's path and the hooks are in
// server/test-support/routes-action-asks-os-user.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AskEntry } from "../shared/types.ts";
import type { MemberOsUserWire } from "../shared/contract-shapes.ts";
import { createAskFilePersistence, createAskStore } from "./asks.ts";
import { createStepAsks } from "./step-asks.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const OWNER = "u-owner";
const BOB = "u-bob";
const MIA = "u-mia";
const RUN_PATH = (name: string) =>
  `/api/users/${encodeURIComponent(name)}/os-user/run`;

const COMMANDS = {
  enable: "sudo /usr/local/sbin/isomux-member-user enable 0a1b2c3d",
  disable: "sudo /usr/local/sbin/isomux-member-user disable 0a1b2c3d",
};

// The Members page's view of Mia, as memberOsUserView gives it.
function view(over: Partial<MemberOsUserWire> = {}): MemberOsUserWire {
  return {
    state: "off",
    commands: COMMANDS,
    run: "password",
    support: { ok: true },
    newUserName: "mia",
    ...over,
  };
}
const on = (name: string, over: Partial<MemberOsUserWire> = {}) =>
  view({ state: "on", osUser: { name, uid: 2001 }, ...over });

type Settled = { askId: string };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "isomux-step-asks-os-user-"));
  roots.push(root);
  const asks = createAskStore({
    persistence: createAskFilePersistence(join(root, "asks.json")),
  });
  // The state the fake reads; tests change it in place.
  const box = {
    names: new Map<string, string>([
      ["mia", MIA],
      ["bob", BOB],
    ]),
    memberName: new Map<string, string>([
      [MIA, "mia"],
      [BOB, "bob"],
    ]),
    view: view() as MemberOsUserWire | null,
    run: "password" as MemberOsUserWire["run"],
    names_: {
      existing: ["alice", "carol"] as string[] | null,
      taken: ["alice", "carol", "mia2", "root"] as string[] | null,
    },
  };
  const settled: Settled[] = [];
  const runs = {
    memberIdByName: (username: string) => box.names.get(username) ?? null,
    member: (userId: string) => {
      const name = box.memberName.get(userId);
      return name === undefined
        ? null
        : { name, role: "member" as const, allowedRooms: [] };
    },
    memberOsUser: (userId: string) =>
      box.memberName.has(userId) ? box.view : null,
    osUserRunMode: async () => box.run,
    osUserNames: async () => box.names_,
    // The run route is owner-only, browser sessions only.
    authorizeAs: (userId: string) =>
      userId === OWNER
        ? null
        : { status: 403, code: "forbidden", message: "owner only" },
  } as unknown as NonNullable<Parameters<typeof createStepAsks>[0]["runs"]>;
  const steps = createStepAsks({
    asks,
    isOfficeOwner: (userId) => userId === OWNER,
    providerConnected: async () => false,
    mcpServer: () => null,
    browserPaired: () => false,
    roomLinked: () => false,
    settled: (_agentId, askId) => settled.push({ askId }),
    runs,
  });
  const check = (step: unknown, memberUserId = OWNER) =>
    steps.check({
      step,
      agentId: "a1",
      roomId: "r1",
      managerUserId: OWNER,
      memberUserId,
      memberNamed: true,
    });
  async function open(step: Record<string, unknown>): Promise<AskEntry> {
    const checked = await check(step);
    if (!checked.ok) throw new Error(`check refused: ${checked.code}`);
    const made = asks.create({
      agentId: "a1",
      memberUserId: OWNER,
      prompt: "Please turn on Mia's OS user.",
      link: checked.link,
      step: checked.step,
    });
    if (!made.ok) throw new Error("create refused");
    return made.entry;
  }
  const openIds = () =>
    asks
      .listAll()
      .map((e) => e.id)
      .sort();
  return { asks, steps, box, settled, check, open, openIds };
}

const answer = (result: { ok: boolean; status?: number; code?: string }) =>
  result.ok ? "ok" : `${result.status} ${result.code}`;

const step = (over: Record<string, unknown> = {}) => ({
  kind: "member-os-user",
  username: "mia",
  on: true,
  ...over,
});

describe("a member-os-user step's create", () => {
  it("stores the member by id and the target the agent named, with no link", async () => {
    const s = setup();
    for (const [sent, stored] of [
      [step(), { kind: "member-os-user", userId: MIA, on: true }],
      [
        step({ osUser: "mia" }),
        { kind: "member-os-user", userId: MIA, on: true, osUser: "mia" },
      ],
      [
        step({ osUser: "alice", existing: true }),
        {
          kind: "member-os-user",
          userId: MIA,
          on: true,
          osUser: "alice",
          existing: true,
        },
      ],
    ] as const) {
      expect(await s.check(sent)).toEqual({ ok: true, step: stored });
    }
    s.box.view = on("mia");
    expect(await s.check(step({ on: false }))).toEqual({
      ok: true,
      step: { kind: "member-os-user", userId: MIA, on: false },
    });
  });

  it("refuses a bad shape: on not a boolean, a name the root command does not take, existing without a name or not a boolean, a target with off, and any other key such as a password (400)", async () => {
    const s = setup();
    const bad: Record<string, unknown>[] = [
      { kind: "member-os-user", username: "mia" },
      step({ on: "yes" }),
      step({ osUser: "Root!" }),
      step({ osUser: "-mia" }),
      step({ osUser: "" }),
      step({ osUser: 7 }),
      step({ existing: true }),
      step({ osUser: "alice", existing: "yes" }),
      step({ on: false, osUser: "mia" }),
      step({ on: false, existing: false }),
      step({ password: "hunter2" }),
      step({ userId: MIA }),
      { kind: "member-os-user", on: true },
    ];
    for (const sent of bad)
      expect({ sent, got: answer(await s.check(sent)) }).toEqual({
        sent,
        got: "400 invalid_request",
      });
  });

  it("refuses an unknown member (422) and a member the asked one cannot run it for (403)", async () => {
    const s = setup();
    expect(answer(await s.check(step({ username: "nobody" })))).toBe(
      "422 unknown_member",
    );
    // The enabling condition: the same step opens for the owner.
    expect(answer(await s.check(step()))).toBe("ok");
    expect(answer(await s.check(step(), BOB))).toBe("403 member_not_allowed");
  });

  it("refuses an office where the server cannot run the command (409 run_unavailable), and opens where sudo needs no password", async () => {
    const s = setup();
    s.box.run = null;
    expect(answer(await s.check(step()))).toBe("409 run_unavailable");
    s.box.run = "no_password";
    expect(answer(await s.check(step()))).toBe("ok");
  });

  it("refuses a step that is done (409 step_done): on as any user for a plain on, on as the named user, off for an off", async () => {
    const s = setup();
    s.box.view = on("isomux-mia");
    expect(answer(await s.check(step()))).toBe("409 step_done");
    s.box.view = on("alice", { adopted: true });
    expect(
      answer(await s.check(step({ osUser: "alice", existing: true }))),
    ).toBe("409 step_done");
    s.box.view = view();
    expect(answer(await s.check(step({ on: false })))).toBe("409 step_done");
  });

  it("refuses a named user for a member who has an OS user (409 os_user_on), with the fix in its message; a plain on for them opens", async () => {
    const s = setup();
    for (const now of [
      view({ state: "not_ready", osUser: { name: "mia", uid: 2001 } }),
      on("bob"),
      view({ state: "broken", reason: "bad record" }),
    ]) {
      s.box.view = now;
      const got = await s.check(step({ osUser: "mia" }));
      expect({ state: now.state, got: answer(got) }).toEqual({
        state: now.state,
        got: "409 os_user_on",
      });
      // The fix names the field to leave out: an agent on /mcp reads no
      // reference page.
      expect(!got.ok && got.message.includes("osUser")).toBe(true);
    }
    // A not-ready member: a plain on runs the enable again.
    s.box.view = view({
      state: "not_ready",
      osUser: { name: "mia", uid: 2001 },
      unfinished: true,
    });
    expect(answer(await s.check(step()))).toBe("ok");
  });

  it("refuses an off for a member who came with an office move (409 moved_in); an on for them opens", async () => {
    const s = setup();
    s.box.view = view({
      state: "not_ready",
      osUser: { name: "mia", uid: 2001 },
      movedIn: true,
    });
    expect(answer(await s.check(step({ on: false })))).toBe("409 moved_in");
    expect(answer(await s.check(step()))).toBe("ok");
  });

  it("refuses an existing user that is not one of the box's (422 unknown_os_user) and a new name that is taken (422 os_user_taken), and accepts either when the names were not read in full", async () => {
    const s = setup();
    expect(
      answer(await s.check(step({ osUser: "mallory", existing: true }))),
    ).toBe("422 unknown_os_user");
    expect(answer(await s.check(step({ osUser: "mia2" })))).toBe(
      "422 os_user_taken",
    );
    // An existing user's name is taken as a new user's, and the other way.
    expect(
      answer(await s.check(step({ osUser: "carol", existing: true }))),
    ).toBe("ok");
    expect(answer(await s.check(step({ osUser: "mia3" })))).toBe("ok");
    s.box.names_ = { existing: null, taken: null };
    expect(
      answer(await s.check(step({ osUser: "mallory", existing: true }))),
    ).toBe("ok");
    expect(answer(await s.check(step({ osUser: "mia2" })))).toBe("ok");
  });
});

describe("a member-os-user step's done predicate", () => {
  const STATES: [string, MemberOsUserWire][] = [
    ["off", view()],
    ["on as mia", on("mia")],
    ["on as alice", on("alice", { adopted: true })],
    [
      "not_ready",
      view({ state: "not_ready", osUser: { name: "mia", uid: 2001 } }),
    ],
    ["moving", view({ state: "moving", osUser: { name: "mia", uid: 2001 } })],
    ["broken", view({ state: "broken", reason: "bad record" })],
  ];

  // Opens the ask from a state where it is not done, moves to each state,
  // and gives the states where the reconcile closed it.
  async function closesAt(
    sent: Record<string, unknown>,
    from: MemberOsUserWire,
  ): Promise<string[]> {
    const closed: string[] = [];
    for (const [label, now] of STATES) {
      const s = setup();
      s.box.view = from;
      const entry = await s.open(sent);
      s.box.view = now;
      await s.steps.reconcile();
      if (!s.openIds().includes(entry.id)) {
        closed.push(label);
        expect(s.settled.map((x) => x.askId)).toEqual([entry.id]);
      }
    }
    return closed;
  }

  it("a plain on is done on as any user, and only then", async () => {
    expect(await closesAt(step(), view())).toEqual([
      "on as mia",
      "on as alice",
    ]);
  });

  it("an on as a named user is done on as that user, and only then", async () => {
    expect(
      await closesAt(step({ osUser: "alice", existing: true }), view()),
    ).toEqual(["on as alice"]);
  });

  it("an off is done off, and only then", async () => {
    expect(await closesAt(step({ on: false }), on("mia"))).toEqual(["off"]);
  });
});

describe("a member-os-user step's run", () => {
  const route = (name: string, body: Record<string, unknown>): unknown => ({
    ok: true,
    routes: [{ method: "POST", path: RUN_PATH(name), body }],
  });
  const runOf = (
    s: ReturnType<typeof setup>,
    entry: AskEntry,
    pick: unknown,
  ): unknown => s.steps.routeOf(entry.step!, OWNER, undefined, pick);

  it("runs the Members page's Run with the step's verb and target and the card's password", async () => {
    const s = setup();
    const plain = await s.open(step());
    const named = await s.open(step({ osUser: "mia3" }));
    const existing = await s.open(step({ osUser: "alice", existing: true }));
    s.box.view = on("mia");
    const off = await s.open(step({ on: false }));
    s.box.view = view();
    const pw = { password: "pa55-word" };
    expect(runOf(s, plain, pw)).toEqual(
      route("mia", { action: "enable", password: "pa55-word" }),
    );
    expect(runOf(s, named, pw)).toEqual(
      route("mia", { action: "enable", osUser: "mia3", password: "pa55-word" }),
    );
    expect(runOf(s, existing, pw)).toEqual(
      route("mia", {
        action: "enable",
        osUser: "alice",
        existing: true,
        password: "pa55-word",
      }),
    );
    s.box.view = on("mia");
    expect(runOf(s, off, pw)).toEqual(
      route("mia", { action: "disable", password: "pa55-word" }),
    );
  });

  it("sends a password only when the card's is a string, and takes nothing else from the card", async () => {
    const s = setup();
    const entry = await s.open(step({ osUser: "mia3" }));
    const bare = route("mia", { action: "enable", osUser: "mia3" });
    for (const pick of [undefined, null, {}, { password: 5 }, "pa55-word"])
      expect({ pick, run: runOf(s, entry, pick) }).toEqual({ pick, run: bare });
    // The card cannot change the verb or the target.
    expect(
      runOf(s, entry, {
        password: "pa55-word",
        action: "disable",
        osUser: "root",
        existing: true,
      }),
    ).toEqual(
      route("mia", { action: "enable", osUser: "mia3", password: "pa55-word" }),
    );
  });

  it("runs under the member's name now, and refuses a member who is gone (422)", async () => {
    const s = setup();
    const entry = await s.open(step());
    s.box.memberName.set(MIA, "mia-renamed");
    expect(runOf(s, entry, {})).toEqual(
      route("mia-renamed", { action: "enable" }),
    );
    s.box.memberName.delete(MIA);
    expect(answer(s.steps.routeOf(entry.step!, OWNER, undefined, {})!)).toBe(
      "422 unknown_member",
    );
  });

  it("refuses a run the root command must refuse since the state changed, and a run while a run or a move goes on (409)", async () => {
    const s = setup();
    const named = await s.open(step({ osUser: "mia3" }));
    const plain = await s.open(step());
    s.box.view = on("mia");
    const off = await s.open(step({ on: false }));
    const run = (entry: AskEntry) =>
      answer(s.steps.routeOf(entry.step!, OWNER, undefined, {})!);

    // Turned on from Settings with another user since the create.
    s.box.view = view({
      state: "not_ready",
      osUser: { name: "bob", uid: 2002 },
    });
    expect(run(named)).toBe("409 os_user_on");
    // A plain on finishes the enable: it runs.
    expect(run(plain)).toBe("ok");

    // Came with an office move since the create: a plain off is refused.
    s.box.view = view({
      state: "not_ready",
      osUser: { name: "mia", uid: 2001 },
      movedIn: true,
    });
    expect(run(off)).toBe("409 moved_in");

    // A run from Settings or by hand, or a move of the member's files.
    for (const busy of [
      view({ attempt: { action: "enable", status: "running", at: 1 } }),
      view({ state: "moving", osUser: { name: "mia", uid: 2001 } }),
    ]) {
      s.box.view = busy;
      expect({ busy: busy.state, got: run(plain) }).toEqual({
        busy: busy.state,
        got: "409 run_in_progress",
      });
    }
    // A failed attempt is not a run that goes on: the card can try again.
    s.box.view = view({
      attempt: { action: "enable", status: "failed", at: 1, message: "no" },
    });
    expect(run(plain)).toBe("ok");
  });
});
