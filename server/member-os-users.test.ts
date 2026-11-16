// The record of isolated members (internal-docs/member-os-user-design.md,
// slice 1a): STATE_ROOT/member-os-users.json, read fail closed. A member whose
// entry is malformed, and every member when the file does not parse, must
// never come back as "none": "none" sends their agents to the office user.
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { STATE_ROOT } from "./config.ts";
import {
  forgetMemberOsUser,
  hasMemberOsUser,
  MEMBER_OS_UID_TIES_FILE,
  memberOsUidTies,
  memberOsUserState,
  memberOsUsersForMove,
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";

function writeRegistry(text: string): void {
  writeFileSync(memberOsUsersPath(), text);
  reloadMemberOsUsers();
}

const tiesPath = () => join(STATE_ROOT, MEMBER_OS_UID_TIES_FILE);

afterEach(() => {
  rmSync(memberOsUsersPath(), { force: true });
  rmSync(tiesPath(), { force: true });
  reloadMemberOsUsers();
});

describe("member OS user record", () => {
  it("with no file, no member is isolated", () => {
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice").kind).toBe("none");
    expect(hasMemberOsUser("u-alice")).toBe(false);
    expect(memberOsUserState(null).kind).toBe("none");
  });

  it("records an entry on disk and reads it back after a reload", () => {
    recordMemberOsUser("u-alice", { name: "isomux-alice", uid: 2001 });
    expect(existsSync(memberOsUsersPath())).toBe(true);
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice")).toEqual({
      kind: "isolated",
      osUser: { name: "isomux-alice", uid: 2001 },
    });
    expect(hasMemberOsUser("u-alice")).toBe(true);
    // Another member stays on the office user.
    expect(memberOsUserState("u-bob").kind).toBe("none");
    forgetMemberOsUser("u-alice");
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice").kind).toBe("none");
  });

  it("refuses to record an entry it would read back as malformed", () => {
    for (const osUser of [
      { name: "Alice", uid: 2001 },
      { name: "isomux-alice;id", uid: 2001 },
      { name: "a".repeat(33), uid: 2001 },
      { name: "isomux-alice", uid: 0 },
      { name: "isomux-alice", uid: 1.5 },
    ]) {
      expect(() => recordMemberOsUser("u-alice", osUser)).toThrow();
    }
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice").kind).toBe("none");
  });

  it("puts a member with a malformed entry on the not-ready side, not on the office user", () => {
    for (const entry of [
      { name: "Alice", uid: 2001 },
      { name: "isomux-alice", uid: 0 },
      { name: "isomux-alice", uid: -5 },
      { name: "isomux-alice", uid: "2001" },
      { name: "isomux-alice" },
      "isomux-alice",
      null,
    ]) {
      writeRegistry(
        JSON.stringify({
          "u-alice": entry,
          "u-carol": { name: "isomux-carol", uid: 2003 },
        }),
      );
      const state = memberOsUserState("u-alice");
      expect(state.kind).toBe("broken");
      expect(hasMemberOsUser("u-alice")).toBe(true);
      // One bad entry leaves the good ones and the members without one.
      expect(memberOsUserState("u-carol").kind).toBe("isolated");
      expect(memberOsUserState("u-bob").kind).toBe("none");
    }
  });

  it("puts every member on the not-ready side when the file does not parse", () => {
    for (const text of ["{", "[]", '"x"', "null", "42"]) {
      writeRegistry(text);
      expect(memberOsUserState("u-alice").kind).toBe("broken");
      expect(memberOsUserState("u-bob").kind).toBe("broken");
      expect(hasMemberOsUser("u-bob")).toBe(true);
      // An agent with no manager is not a member's agent.
      expect(memberOsUserState(null).kind).toBe("none");
    }
  });

  it("does not rewrite or drop a file it cannot parse when another entry is recorded", () => {
    writeRegistry("{");
    expect(() =>
      recordMemberOsUser("u-bob", { name: "isomux-bob", uid: 2002 }),
    ).toThrow();
    expect(readFileSync(memberOsUsersPath(), "utf8")).toBe("{");
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice").kind).toBe("broken");
  });
});

// Slice 2d-ii of task b94dfd25: the secret proxy ties each member OS user's
// uid to its member. The tie outlives the entry: after a disable, a process
// of the uid that still runs must keep only its member's secrets, never
// fall back to every secret.
describe("the uid ties", () => {
  it("tie a recorded uid to its member, and keep the tie after a disable", () => {
    recordMemberOsUser("u-alice", { name: "isomux-alice", uid: 2001 });
    expect(memberOsUidTies()).toEqual([{ uid: 2001, userId: "u-alice" }]);
    forgetMemberOsUser("u-alice");
    reloadMemberOsUsers();
    expect(memberOsUserState("u-alice").kind).toBe("none");
    expect(memberOsUidTies()).toEqual([{ uid: 2001, userId: "u-alice" }]);
  });

  it("give a uid to the member recorded with it last", () => {
    recordMemberOsUser("u-alice", { name: "isomux-alice", uid: 2001 });
    forgetMemberOsUser("u-alice");
    recordMemberOsUser("u-bob", { name: "isomux-bob", uid: 2001 });
    forgetMemberOsUser("u-bob");
    reloadMemberOsUsers();
    expect(memberOsUidTies()).toEqual([{ uid: 2001, userId: "u-bob" }]);
  });

  it("count a recorded entry when the tie file cannot be read, and refuse a new record then", () => {
    recordMemberOsUser("u-alice", { name: "isomux-alice", uid: 2001 });
    writeFileSync(tiesPath(), "{ not json");
    expect(memberOsUidTies()).toEqual([{ uid: 2001, userId: "u-alice" }]);
    expect(() =>
      recordMemberOsUser("u-bob", { name: "isomux-bob", uid: 2002 }),
    ).toThrow();
    reloadMemberOsUsers();
    // No entry without its tie.
    expect(memberOsUserState("u-bob").kind).toBe("none");
    expect(readFileSync(tiesPath(), "utf8")).toBe("{ not json");
  });
});

// Task 78733adf, slice 3: an office move's preflight and lock read the record
// of the state root they are given, now (no cache), and list every member it
// holds, so a lock never misses one the move would strand.
describe("the members with their own OS user, for an office move", () => {
  let root = "";
  const write = (text: string) =>
    writeFileSync(join(root, "member-os-users.json"), text);
  const names: Record<string, string | null> = {
    "u-a": "Zed",
    "u-b": "Amy",
    "u-c": null,
  };
  const nameOf = (id: string) => names[id] ?? null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });
  const fresh = () => {
    root = mkdtempSync(join(tmpdir(), "member-os-users-move-"));
    // The office's own record names someone else: the read must not use it.
    writeRegistry(
      JSON.stringify({ "u-office": { name: "isomux-o", uid: 3001 } }),
    );
    expect(memberOsUserState("u-office").kind).toBe("isolated");
  };

  it("names every entry, valid or not, by name or else by id, sorted, as the file is now", () => {
    fresh();
    write(
      JSON.stringify({
        "u-c": { name: "Bad Name!", uid: -1 },
        "u-b": { name: "isomux-amy", uid: 2002 },
        "u-a": { name: "isomux-zed", uid: 2001, moving: true },
      }),
    );
    expect(memberOsUsersForMove(root, nameOf)).toEqual({
      names: ["Amy", "Zed", "u-c"],
    });
    // Read again at each call: a disable shows at once.
    write(JSON.stringify({ "u-b": { name: "isomux-amy", uid: 2002 } }));
    expect(memberOsUsersForMove(root, nameOf)).toEqual({ names: ["Amy"] });
  });

  it("names nobody when the state root has no record", () => {
    fresh();
    expect(memberOsUsersForMove(root, nameOf)).toEqual({ names: [] });
  });

  it("is broken when the record cannot be read or is not a JSON object", () => {
    fresh();
    const seen: unknown[] = [];
    for (const text of ["{", "[]", "null", '"x"'])
      seen.push((write(text), memberOsUsersForMove(root, nameOf)));
    rmSync(join(root, "member-os-users.json"));
    mkdirSync(join(root, "member-os-users.json"));
    seen.push(memberOsUsersForMove(root, nameOf));
    expect(seen).toEqual(Array(5).fill({ broken: true }));
  });
});
