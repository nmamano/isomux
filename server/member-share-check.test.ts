// The member share check (server/member-share-check.ts,
// internal-docs/member-os-user-design.md 1.1): the member runs code from its
// share, so only root and the office user may change anything in it, a second
// member may not read it, and the only link is runtime/current naming a
// runtime folder. Each case changes one entry of a share that passes and
// names the entry the check must refuse. The probe is a table, so owners and
// set-id bits that a test user cannot make are cases too.
import { describe, expect, it } from "bun:test";
import {
  checkMemberShare,
  type ShareEntry,
  type ShareProbe,
} from "./member-share-check.ts";

const OFFICE = 1001;
const MEMBER = 2001;
const MEMBER_GID = 2001;
const OFFICE_GID = 1001;
const THIRD = 3001;
const HASH = "a".repeat(64);
const OLD = "b".repeat(64);

const PARENT = "/srv/share";
const SHARE = `${PARENT}/isomux-alice`;
const RUNTIME = `${SHARE}/runtime`;
const DIR = `${RUNTIME}/${HASH}`;
const CURRENT = `${RUNTIME}/current`;

type Tree = Map<string, ShareEntry>;

const dir = (mode: number, uid = OFFICE, gid = MEMBER_GID): ShareEntry => ({
  type: "dir",
  uid,
  gid,
  mode,
});
const file = (mode: number, uid = OFFICE, gid = MEMBER_GID): ShareEntry => ({
  type: "file",
  uid,
  gid,
  mode,
});
const link = (target: string, uid = OFFICE): ShareEntry => ({
  type: "symlink",
  uid,
  gid: MEMBER_GID,
  mode: 0o777,
  linkTarget: target,
});

// A share that passes: what the install writes. A hard link of an office
// file keeps the office group; a copy takes the share's group; a folder made
// in the setgid share is setgid too.
function goodTree(): Tree {
  return new Map<string, ShareEntry>([
    [PARENT, dir(0o755, 0, 0)],
    [SHARE, dir(0o2750)],
    [RUNTIME, dir(0o2755)],
    [DIR, dir(0o2755)],
    [`${DIR}/runner.js`, file(0o644)],
    [`${DIR}/bun`, file(0o755, OFFICE, OFFICE_GID)],
    [`${DIR}/node_modules`, dir(0o2755)],
    [`${DIR}/node_modules/claude`, file(0o755, 0, 0)],
    [`${RUNTIME}/${OLD}`, dir(0o755)],
    [CURRENT, link(HASH)],
  ]);
}

function probeOf(tree: Tree): ShareProbe {
  return {
    lstat: (path) => tree.get(path) ?? null,
    readdir: (path) =>
      [...tree.keys()]
        .filter((p) => p.startsWith(`${path}/`))
        .map((p) => p.slice(path.length + 1))
        .filter((rest) => !rest.includes("/")),
  };
}

type Scope = "all" | "root" | { runtime: string };

function check(tree: Tree, memberGid = MEMBER_GID, scope?: Scope) {
  return checkMemberShare({
    share: SHARE,
    officeUid: OFFICE,
    memberGid,
    probe: probeOf(tree),
    ...(scope ? { scope } : {}),
  });
}

// The refused path, or "ok".
function verdict(tree: Tree, scope?: Scope): string {
  const result = check(tree, MEMBER_GID, scope);
  if (result.ok) return "ok";
  // A refusal says why.
  expect(result.reason.length).toBeGreaterThan(0);
  return result.path;
}

function changed(edit: (tree: Tree) => void): Tree {
  const tree = goodTree();
  edit(tree);
  return tree;
}

type Case = [string, (tree: Tree) => void, string];

// The parent and share-root cases: what the server does not make, so every
// scope refuses them.
const ROOT_CASES: Case[] = [
  // The parent: only root may rename or replace a share.
  ["the parent is missing", (t) => t.delete(PARENT), PARENT],
  [
    "the parent is owned by the office",
    (t) => t.set(PARENT, dir(0o755, OFFICE, 0)),
    PARENT,
  ],
  [
    "the parent is group-writable",
    (t) => t.set(PARENT, dir(0o775, 0, 0)),
    PARENT,
  ],
  [
    "the parent is writable by others",
    (t) => t.set(PARENT, dir(0o757, 0, 0)),
    PARENT,
  ],
  [
    "the parent is a link",
    (t) => t.set(PARENT, { ...link("/elsewhere", 0) }),
    PARENT,
  ],
  // The share: the member's group, nothing for others.
  ["the share is missing", (t) => t.delete(SHARE), SHARE],
  ["the share is a link", (t) => t.set(SHARE, link("/elsewhere")), SHARE],
  [
    "the share has another group",
    (t) => t.set(SHARE, dir(0o2750, OFFICE, OFFICE_GID)),
    SHARE,
  ],
  ["others can search the share", (t) => t.set(SHARE, dir(0o2751)), SHARE],
  ["others can read the share", (t) => t.set(SHARE, dir(0o2754)), SHARE],
  [
    "the share is owned by the member",
    (t) => t.set(SHARE, dir(0o2750, MEMBER)),
    SHARE,
  ],
  ["the share is group-writable", (t) => t.set(SHARE, dir(0o2770)), SHARE],
];

describe("checkMemberShare", () => {
  it("passes the share an install writes: root-owned files, office files of the office group, setgid folders, one current link", () => {
    expect(verdict(goodTree())).toBe("ok");
  });

  const cases: Case[] = [
    ...ROOT_CASES,
    // Owners: the office user or root, nobody else.
    [
      "a file is owned by the member",
      (t) => t.set(`${DIR}/runner.js`, file(0o644, MEMBER)),
      `${DIR}/runner.js`,
    ],
    [
      "a file is owned by a third user",
      (t) => t.set(`${DIR}/bun`, file(0o755, THIRD)),
      `${DIR}/bun`,
    ],
    [
      "a folder is owned by the member",
      (t) => t.set(`${DIR}/node_modules`, dir(0o755, MEMBER)),
      `${DIR}/node_modules`,
    ],
    [
      "the current link is owned by the member",
      (t) => t.set(CURRENT, link(HASH, MEMBER)),
      CURRENT,
    ],
    // Write: with an ACL the group bits are the mask, so a named grant shows as group write.
    [
      "a file of the member's group is group-writable",
      (t) => t.set(`${DIR}/runner.js`, file(0o664)),
      `${DIR}/runner.js`,
    ],
    [
      "a file under an ACL mask with write",
      (t) => t.set(`${DIR}/bun`, file(0o775, OFFICE, OFFICE_GID)),
      `${DIR}/bun`,
    ],
    [
      "a file is writable by others",
      (t) => t.set(`${DIR}/node_modules/claude`, file(0o757, 0, 0)),
      `${DIR}/node_modules/claude`,
    ],
    [
      "a folder is group-writable",
      (t) => t.set(`${DIR}/node_modules`, dir(0o2775)),
      `${DIR}/node_modules`,
    ],
    [
      "a folder is writable by others",
      (t) => t.set(`${RUNTIME}/${OLD}`, dir(0o757)),
      `${RUNTIME}/${OLD}`,
    ],
    // Set-id: a setuid or setgid office file would run with the office's ids.
    ["a setuid file", (t) => t.set(`${DIR}/bun`, file(0o4755)), `${DIR}/bun`],
    ["a setgid file", (t) => t.set(`${DIR}/bun`, file(0o2755)), `${DIR}/bun`],
    [
      "a root-owned setuid file",
      (t) => t.set(`${DIR}/node_modules/claude`, file(0o4755, 0, 0)),
      `${DIR}/node_modules/claude`,
    ],
    // Links: only runtime/current, naming an existing runtime folder by its hash.
    // Its target is a valid runtime name: only the "current only" rule refuses it.
    [
      "a link other than current",
      (t) => t.set(`${RUNTIME}/previous`, link(OLD)),
      `${RUNTIME}/previous`,
    ],
    [
      "a link deep in a runtime",
      (t) => t.set(`${DIR}/node_modules/x`, link(HASH)),
      `${DIR}/node_modules/x`,
    ],
    [
      "a link named current outside runtime/",
      (t) => t.set(`${SHARE}/current`, link(HASH)),
      `${SHARE}/current`,
    ],
    [
      "current names a path out of runtime/",
      (t) => t.set(CURRENT, link(`../${HASH}`)),
      CURRENT,
    ],
    [
      "current names a path below a folder",
      (t) => t.set(CURRENT, link(`${HASH}/node_modules`)),
      CURRENT,
    ],
    [
      "current names an absolute path",
      (t) => t.set(CURRENT, link(DIR)),
      CURRENT,
    ],
    [
      "current names something that is not a hash",
      (t) => t.set(CURRENT, link("g".repeat(64))),
      CURRENT,
    ],
    // An existing folder that is not a runtime: only the hash rule refuses it.
    [
      "current names a folder that is not a hash",
      (t) => {
        t.set(`${RUNTIME}/.tmp-abc`, dir(0o755));
        t.set(CURRENT, link(".tmp-abc"));
      },
      CURRENT,
    ],
    [
      "current names a hash with no folder",
      (t) => t.set(CURRENT, link("c".repeat(64))),
      CURRENT,
    ],
    [
      "current names a hash that is a file",
      (t) => {
        t.set(`${RUNTIME}/${"d".repeat(64)}`, file(0o644));
        t.set(CURRENT, link("d".repeat(64)));
      },
      CURRENT,
    ],
    // Nothing but files, folders and that one link.
    [
      "a fifo",
      (t) =>
        t.set(`${DIR}/pipe`, {
          type: "other",
          uid: OFFICE,
          gid: MEMBER_GID,
          mode: 0o644,
        }),
      `${DIR}/pipe`,
    ],
  ];
  for (const [name, edit, path] of cases) {
    it(`refuses when ${name}`, () => {
      expect(verdict(changed(edit))).toBe(path);
    });
  }

  it("refuses a share whose group is not the member's, even when every bit is right", () => {
    expect(check(goodTree(), MEMBER_GID + 1).ok).toBe(false);
  });

  it("walks deep: a bad entry at the bottom of a package is found", () => {
    const deep = `${DIR}/node_modules/@scope/pkg/lib/vendor/bin/tool`;
    const tree = goodTree();
    for (const folder of [
      `${DIR}/node_modules/@scope`,
      `${DIR}/node_modules/@scope/pkg`,
      `${DIR}/node_modules/@scope/pkg/lib`,
      `${DIR}/node_modules/@scope/pkg/lib/vendor`,
      `${DIR}/node_modules/@scope/pkg/lib/vendor/bin`,
    ])
      tree.set(folder, dir(0o2755));
    tree.set(deep, file(0o755));
    expect(verdict(tree)).toBe("ok");
    tree.set(deep, file(0o4755));
    expect(verdict(tree)).toBe(deep);
  });
});

// The scopes (round 2 of slice 1b-i): before the install the connect checks
// only what the server does not make, so the install can repair a broken
// runtime; an install that is there is checked as its own runtime only, so a
// bad old runtime does not cost a rewrite at every try.
describe("checkMemberShare scopes", () => {
  const OTHER = `${RUNTIME}/${OLD}`;
  const broken: [string, (tree: Tree) => void][] = [
    ["runtime/current names a runtime that is gone", (t) => t.delete(DIR)],
    [
      "a setuid file deep in a runtime",
      (t) => t.set(`${DIR}/bun`, file(0o4755)),
    ],
    [
      "a member-owned file in an old runtime",
      (t) => t.set(`${OTHER}/x`, file(0o644, MEMBER)),
    ],
    ["runtime/ is group-writable", (t) => t.set(RUNTIME, dir(0o2775))],
    [
      "a stray link in runtime/",
      (t) => t.set(`${RUNTIME}/previous`, link(OLD)),
    ],
  ];

  for (const [name, edit] of broken)
    it(`"root" passes, and "all" refuses, when ${name}`, () => {
      const tree = changed(edit);
      expect(verdict(tree, "root")).toBe("ok");
      expect(verdict(tree, "all")).not.toBe("ok");
    });

  it('"root" and { runtime } still refuse every parent and share-root rule', () => {
    expect(ROOT_CASES.length).toBeGreaterThan(10);
    for (const [name, edit, path] of ROOT_CASES) {
      const tree = changed(edit);
      expect([name, verdict(tree, "root")]).toEqual([name, path]);
      expect([name, verdict(tree, { runtime: HASH })]).toEqual([name, path]);
    }
  });

  it("{ runtime } walks runtime/<hash> whole and checks the runtime/ entry", () => {
    expect(verdict(goodTree(), { runtime: HASH })).toBe("ok");
    const deep = changed((t) =>
      t.set(`${DIR}/node_modules/claude`, file(0o4755, 0, 0)),
    );
    expect(verdict(deep, { runtime: HASH })).toBe(`${DIR}/node_modules/claude`);
    const top = changed((t) => t.set(RUNTIME, dir(0o2775)));
    expect(verdict(top, { runtime: HASH })).toBe(RUNTIME);
    const owner = changed((t) => t.set(RUNTIME, dir(0o2755, MEMBER)));
    expect(verdict(owner, { runtime: HASH })).toBe(RUNTIME);
    const linked = changed((t) => t.set(DIR, link(OLD)));
    expect(verdict(linked, { runtime: HASH })).toBe(DIR);
    expect(
      verdict(
        changed((t) => t.delete(DIR)),
        { runtime: HASH },
      ),
    ).toBe(DIR);
  });

  it("{ runtime } ignores another runtime folder and runtime/current", () => {
    const tree = changed((t) => {
      t.set(`${OTHER}/x`, file(0o4777, MEMBER));
      t.set(CURRENT, link("c".repeat(64)));
    });
    expect(verdict(tree, { runtime: HASH })).toBe("ok");
    expect(verdict(tree, "all")).not.toBe("ok");
  });
});
