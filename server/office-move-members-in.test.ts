// The new office's check of the members with their own OS user in an
// office move, and her moved home while it waits for the enable command
// (task 78733adf, slice 5c-2; server/office-move-members-in.ts). The
// properties: each member gets the one block that stops the enable command
// here (E1, D3), with the home that command would make; her moved home is
// removed whole even when it holds read-only folders (D4); the boot sweep
// removes only the homes of members who are no longer movedIn.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CONTAINER_MEMBER_HOMES,
  memberHomesHere,
  movedHomeDir,
  predictedMemberHome,
  removeMovedHome,
  sweepMovedHomes,
  useraddHomeBase,
  type MembersHereDeps,
  type MemberToMove,
} from "./office-move-members-in.ts";
import type { MemberUserSupport } from "./member-os-user-view.ts";

const INSTALLER: MemberUserSupport = { ok: true, shape: "installer" };
const CONTAINER: MemberUserSupport = { ok: true, shape: "container" };
const DOCKER: MemberUserSupport = {
  ok: true,
  shape: "docker",
  container: "isomux",
};

const alice: MemberToMove = {
  userId: "u-alice",
  name: "Alice",
  osUser: "isomux-alice",
  home: "/home/isomux-alice",
};

function here(over: Partial<MembersHereDeps> = {}): MembersHereDeps {
  return {
    support: INSTALLER,
    passwd: () => null,
    exists: () => false,
    homeBase: () => "/home",
    ...over,
  };
}

describe("the home the enable command makes here", () => {
  it("reads HOME= of useradd's defaults, else /home", () => {
    expect(useraddHomeBase(null)).toBe("/home");
    expect(useraddHomeBase("")).toBe("/home");
    // Ubuntu ships the line commented out.
    expect(useraddHomeBase("# HOME=/srv/users\nSHELL=/bin/sh\n")).toBe("/home");
    expect(useraddHomeBase("SHELL=/bin/sh\nHOME=/srv/users\n")).toBe(
      "/srv/users",
    );
  });

  it("is under the home base on an installer box and on the data volume in a container", () => {
    expect(predictedMemberHome("isomux-alice", INSTALLER, "/srv/users")).toBe(
      "/srv/users/isomux-alice",
    );
    for (const shape of [CONTAINER, DOCKER])
      expect(predictedMemberHome("isomux-alice", shape, "/home")).toBe(
        `${CONTAINER_MEMBER_HOMES}/isomux-alice`,
      );
    expect(
      predictedMemberHome(
        "isomux-alice",
        { ok: false, reason: "not_linux" },
        "/home",
      ),
    ).toBeNull();
  });
});

describe("memberHomesHere (E1, D3)", () => {
  it("lets a member through when her home lands at the same path, with no user and no folder there", () => {
    const [result] = memberHomesHere([alice], here());
    expect(result).toMatchObject({
      userId: alice.userId,
      name: alice.name,
      osUser: alice.osUser,
      oldHome: alice.home,
      home: "/home/isomux-alice",
      block: null,
    });
  });

  it("blocks every member where this box cannot make member users", () => {
    const results = memberHomesHere(
      [alice, { ...alice, userId: "u-bob", osUser: "isomux-bob" }],
      here({ support: { ok: false, reason: "kubernetes" } }),
    );
    expect(results.map((r) => [r.userId, r.block, r.home])).toEqual([
      ["u-alice", "unsupported", null],
      ["u-bob", "unsupported", null],
    ]);
  });

  it("blocks a home that would land at another path, and names both paths", () => {
    // An installer box moving into a container.
    const [result] = memberHomesHere([alice], here({ support: CONTAINER }));
    expect(result.block).toBe("other_home");
    expect(result.home).toBe(`${CONTAINER_MEMBER_HOMES}/isomux-alice`);
    expect(result.oldHome).toBe(alice.home);
    // Another home base on this box.
    const [based] = memberHomesHere([alice], here({ homeBase: () => "/srv" }));
    expect([based.block, based.home]).toEqual([
      "other_home",
      "/srv/isomux-alice",
    ]);
  });

  it("blocks an OS user name that exists here, whatever its home", () => {
    const [result] = memberHomesHere(
      [alice],
      here({
        passwd: (name) =>
          name === "isomux-alice"
            ? { uid: 1234, home: "/home/isomux-alice" }
            : null,
      }),
    );
    expect(result.block).toBe("name_taken");
  });

  it("blocks a home path that exists before the user does, a link too", () => {
    const seen: string[] = [];
    const [result] = memberHomesHere(
      [alice],
      here({
        exists: (path) => {
          seen.push(path);
          return path === "/home/isomux-alice";
        },
      }),
    );
    expect(result.block).toBe("home_exists");
    expect(seen).toContain("/home/isomux-alice");
  });

  it("checks each member on her own, in the given order", () => {
    const bob = {
      userId: "u-bob",
      name: "Bob",
      osUser: "isomux-bob",
      home: "/home/isomux-bob",
    };
    const results = memberHomesHere(
      [bob, alice],
      here({
        passwd: (name) =>
          name === "isomux-bob"
            ? { uid: 1500, home: "/home/isomux-bob" }
            : null,
      }),
    );
    expect(results.map((r) => [r.userId, r.block])).toEqual([
      ["u-bob", "name_taken"],
      ["u-alice", null],
    ]);
  });
});

describe("her moved home in the state", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "move-members-in-"));
  });
  afterEach(() => {
    // A failed run can leave read-only folders behind.
    for (const d of [join(root, "move-members")])
      if (existsSync(d))
        for (const p of readdirSync(d, { recursive: true }) as string[])
          try {
            chmodSync(join(d, p), 0o700);
          } catch {
            // A link or a file.
          }
    rmSync(root, { recursive: true, force: true });
  });

  it("waits in <state>/move-members/<userId>/home", () => {
    expect(movedHomeDir(root, "u-alice")).toBe(
      join(root, "move-members", "u-alice", "home"),
    );
  });

  // D4: the stage keeps her modes, so a folder she made read-only is
  // read-only in the office's copy too.
  it("removes her moved home whole, with read-only folders at the top and nested, and never follows a link", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    const home = movedHomeDir(root, "u-alice");
    mkdirSync(join(home, "ro", "deeper"), { recursive: true });
    writeFileSync(join(home, "ro", "deeper", "f"), "x");
    writeFileSync(join(home, "ro", "f"), "x");
    symlinkSync(outside, join(home, "ro", "link"));
    chmodSync(join(home, "ro", "deeper"), 0o555);
    chmodSync(join(home, "ro"), 0o555);
    chmodSync(home, 0o500);
    removeMovedHome(root, "u-alice");
    expect(existsSync(join(root, "move-members", "u-alice"))).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  it("removes nothing of another member", () => {
    mkdirSync(movedHomeDir(root, "u-alice"), { recursive: true });
    mkdirSync(movedHomeDir(root, "u-bob"), { recursive: true });
    removeMovedHome(root, "u-alice");
    expect(readdirSync(join(root, "move-members"))).toEqual(["u-bob"]);
  });

  it("at boot, removes the homes of members who are not movedIn and keeps the others", () => {
    for (const id of ["u-alice", "u-bob", "u-carol"])
      mkdirSync(movedHomeDir(root, id), { recursive: true });
    chmodSync(movedHomeDir(root, "u-bob"), 0o555);
    const removed = sweepMovedHomes(root, (id) => id === "u-alice");
    expect(removed.sort()).toEqual(["u-bob", "u-carol"]);
    expect(readdirSync(join(root, "move-members"))).toEqual(["u-alice"]);
  });

  it("at boot, does nothing with no move-members folder", () => {
    expect(sweepMovedHomes(root, () => false)).toEqual([]);
  });
});
