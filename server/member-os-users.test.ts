// The record of isolated members (internal-docs/member-os-user-design.md,
// slice 1a): STATE_ROOT/member-os-users.json, read fail closed. A member whose
// entry is malformed, and every member when the file does not parse, must
// never come back as "none": "none" sends their agents to the office user.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import {
  forgetMemberOsUser,
  hasMemberOsUser,
  memberOsUserState,
  memberOsUsersPath,
  recordMemberOsUser,
  reloadMemberOsUsers,
} from "./member-os-users.ts";

function writeRegistry(text: string): void {
  writeFileSync(memberOsUsersPath(), text);
  reloadMemberOsUsers();
}

afterEach(() => {
  rmSync(memberOsUsersPath(), { force: true });
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
