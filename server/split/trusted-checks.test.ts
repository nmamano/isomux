import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import {
  ACL_GROUP,
  ACL_GROUP_OBJ,
  ACL_MASK,
  ACL_OTHER,
  ACL_USER,
  ACL_USER_OBJ,
  parseAclXattr,
  readAcl,
  type AclEntry,
} from "./acl.ts";
import {
  agentAccess,
  runTrustedChecks,
  type AgentIdentity,
  type FileFacts,
  type FsProbe,
} from "./trusted-checks.ts";

const SERVER = 900;
const AGENT: AgentIdentity = { uid: 1000, gid: 1000, groups: [1000, 1500] };

const acl = (...entries: [number, number, number?][]): AclEntry[] =>
  entries.map(([tag, perm, id = 0]) => ({ tag, perm, id }));

describe("agentAccess", () => {
  const facts = { uid: SERVER, gid: SERVER, mode: 0o750 };

  it("follows owner, group and other bits without an ACL", () => {
    expect(agentAccess({ ...facts, uid: 1000, mode: 0o700 }, null, AGENT)).toBe(
      7,
    );
    expect(agentAccess({ ...facts, gid: 1500, mode: 0o770 }, null, AGENT)).toBe(
      7,
    );
    expect(agentAccess({ ...facts, mode: 0o752 }, null, AGENT)).toBe(2);
    expect(agentAccess(facts, null, AGENT)).toBe(0);
  });

  it("gives a named user entry, limited by the mask", () => {
    const entries = acl(
      [ACL_USER_OBJ, 7],
      [ACL_USER, 6, 1000],
      [ACL_GROUP_OBJ, 5],
      [ACL_MASK, 4],
      [ACL_OTHER, 0],
    );
    expect(agentAccess(facts, entries, AGENT)).toBe(4);
    entries[3].perm = 7;
    expect(agentAccess(facts, entries, AGENT)).toBe(6);
  });

  it("unites the matching group entries and ignores other once a group matched", () => {
    const entries = acl(
      [ACL_USER_OBJ, 7],
      [ACL_GROUP_OBJ, 0],
      [ACL_GROUP, 2, 1500],
      [ACL_MASK, 7],
      [ACL_OTHER, 7],
    );
    expect(agentAccess(facts, entries, AGENT)).toBe(2);
    entries[2].id = 4242;
    expect(agentAccess(facts, entries, AGENT)).toBe(7);
  });
});

describe("parseAclXattr", () => {
  it("reads a version-2 ACL and refuses anything else", () => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeUInt16LE(ACL_USER, 4);
    data.writeUInt16LE(6, 6);
    data.writeUInt32LE(1000, 8);
    expect(parseAclXattr(data)).toEqual([{ tag: ACL_USER, perm: 6, id: 1000 }]);
    expect(() => parseAclXattr(data.subarray(0, 10))).toThrow();
    data.writeUInt32LE(3, 0);
    expect(() => parseAclXattr(data)).toThrow();
  });

  const hasSetfacl = spawnSync("setfacl", ["--version"]).status === 0;
  it.skipIf(!hasSetfacl)("reads a real ACL and reports none", () => {
    const dir = mkdtempSync(join(tmpdir(), "split-acl-"));
    try {
      const file = join(dir, "f");
      writeFileSync(file, "x");
      expect(readAcl(file, "access")).toBeNull();
      execFileSync("setfacl", ["-m", `u:${userInfo().uid}:r`, file]);
      expect(readAcl(file, "access")).toContainEqual({
        tag: ACL_USER,
        perm: 4,
        id: userInfo().uid,
      });
      expect(readAcl(dir, "default")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A fake file system: path -> facts, with optional ACLs and symlink targets.
interface FakeEntry extends FileFacts {
  target?: string;
  access?: AclEntry[];
  default?: AclEntry[];
}

const dir = (uid: number, gid: number, mode: number): FakeEntry => ({
  uid,
  gid,
  mode,
  kind: "dir",
});
const file = (uid: number, gid: number, mode: number): FakeEntry => ({
  uid,
  gid,
  mode,
  kind: "file",
});

function cleanTree(): Map<string, FakeEntry> {
  return new Map<string, FakeEntry>([
    ["/", dir(0, 0, 0o755)],
    ["/srv", dir(0, 0, 0o755)],
    ["/srv/server", dir(SERVER, SERVER, 0o711)],
    ["/srv/server/.isomux", dir(SERVER, SERVER, 0o700)],
    ["/srv/server/share", dir(SERVER, 1000, 0o2750)],
    ["/srv/server/share/files", dir(SERVER, 1000, 0o2750)],
    ["/srv/server/share/files/a.png", file(SERVER, 1000, 0o640)],
    ["/srv/server/share/authority", dir(SERVER, 1000, 0o2750)],
    [
      "/srv/server/share/authority/authority.sock",
      { uid: SERVER, gid: 1000, mode: 0o660, kind: "socket" },
    ],
    ["/opt", dir(0, 0, 0o755)],
    ["/opt/code", dir(0, 0, 0o755)],
    ["/opt/code/package.json", file(0, 0, 0o644)],
    ["/opt/code/server", dir(0, 0, 0o755)],
    ["/opt/code/server/a.ts", file(0, 0, 0o644)],
    ["/opt/code/server/deep", dir(0, 0, 0o755)],
    ["/opt/code/server/deep/b.ts", file(0, 0, 0o644)],
  ]);
}

function probe(tree: Map<string, FakeEntry>): FsProbe {
  const get = (path: string) => {
    const entry = tree.get(path);
    if (!entry) throw new Error(`ENOENT ${path}`);
    return entry;
  };
  return {
    lstat: (path) => get(path),
    readlink: (path) => {
      const entry = get(path);
      if (entry.kind !== "symlink") throw new Error(`EINVAL ${path}`);
      return entry.target!;
    },
    readdir: (path) =>
      [...tree.keys()]
        .filter(
          (key) =>
            key !== path &&
            key.startsWith(path === "/" ? "/" : `${path}/`) &&
            !key.slice(path.length + 1).includes("/"),
        )
        .map((key) => key.slice(key.lastIndexOf("/") + 1)),
    acl: (path, kind) =>
      (kind === "access" ? get(path).access : get(path).default) ?? null,
  };
}

function check(tree: Map<string, FakeEntry>, codeDepth = 2) {
  return runTrustedChecks({
    serverUid: SERVER,
    serverGid: SERVER,
    agent: AGENT,
    stateRoot: "/srv/server/.isomux",
    shareRoot: "/srv/server/share",
    codeRoot: "/opt/code",
    codeDepth,
    fs: probe(tree),
  }).map((f) => `${f.check} ${f.path ?? ""}`.trim());
}

describe("runTrustedChecks", () => {
  it("passes a correct split", () => {
    expect(check(cleanTree(), Infinity)).toEqual([]);
  });

  it("refuses identities that are no split", () => {
    const run = (agent: AgentIdentity, serverGid = SERVER) =>
      runTrustedChecks({
        serverUid: SERVER,
        serverGid,
        agent,
        stateRoot: "/srv/server/.isomux",
        shareRoot: "/srv/server/share",
        codeRoot: "/opt/code",
        codeDepth: 2,
        fs: probe(cleanTree()),
      }).map((f) => f.check);
    expect(run({ uid: 0, gid: 0, groups: [0] })).toContain("agent-not-root");
    expect(run({ uid: SERVER, gid: 1000, groups: [] })).toContain(
      "agent-not-server",
    );
    expect(run({ ...AGENT, groups: [1000, SERVER] })).toEqual([
      "server-group-private",
    ]);
  });

  it("names each broken private entry", () => {
    const cases: [string, (tree: Map<string, FakeEntry>) => void, string][] = [
      [
        "state readable",
        (t) => (t.get("/srv/server/.isomux")!.mode = 0o755),
        "state-root-closed /srv/server/.isomux",
      ],
      [
        "code owned by the agent",
        (t) => (t.get("/opt/code/package.json")!.uid = 1000),
        "private-owner /opt/code/package.json",
      ],
      [
        "ancestor writable by the agent's group",
        (t) => Object.assign(t.get("/srv")!, { gid: 1500, mode: 0o775 }),
        "private-agent-write /srv",
      ],
      [
        "named write grant",
        (t) =>
          (t.get("/opt/code/server/a.ts")!.access = acl(
            [ACL_USER_OBJ, 6],
            [ACL_USER, 6, 1000],
            [ACL_GROUP_OBJ, 4],
            [ACL_MASK, 6],
            [ACL_OTHER, 4],
          )),
        "private-agent-write /opt/code/server/a.ts",
      ],
      [
        "default ACL that gives new files to the agent",
        (t) =>
          (t.get("/opt/code/server")!.default = acl(
            [ACL_USER_OBJ, 7],
            [ACL_USER, 7, 1000],
            [ACL_GROUP_OBJ, 5],
            [ACL_MASK, 7],
            [ACL_OTHER, 5],
          )),
        "private-agent-write /opt/code/server",
      ],
    ];
    for (const [, breakIt, expected] of cases) {
      const tree = cleanTree();
      breakIt(tree);
      expect(check(tree)).toContain(expected);
    }
  });

  it("accepts a read-only named grant, also in a default ACL", () => {
    const tree = cleanTree();
    const readOnly = acl(
      [ACL_USER_OBJ, 7],
      [ACL_USER, 7, 1000],
      [ACL_GROUP_OBJ, 5],
      [ACL_MASK, 5],
      [ACL_OTHER, 5],
    );
    tree.get("/opt/code/server")!.access = readOnly;
    tree.get("/opt/code/server")!.default = readOnly;
    expect(check(tree)).toEqual([]);
  });

  it("judges a symlink by its target and the target's ancestors", () => {
    const tree = cleanTree();
    tree.set("/tmp", dir(0, 0, 0o1777));
    tree.set("/tmp/agent", file(1000, 1000, 0o644));
    tree.set("/opt/code/LICENSE", {
      ...file(0, 0, 0o777),
      kind: "symlink",
      target: "/tmp/agent",
    });
    expect(check(tree)).toEqual([
      "private-agent-write /tmp",
      "private-owner /tmp/agent",
      "private-agent-write /tmp/agent",
    ]);
    tree.set("/opt/code/LICENSE", {
      ...file(0, 0, 0o777),
      kind: "symlink",
      target: "/opt/code/package.json",
    });
    expect(check(tree)).toEqual([]);
  });

  const link = (target: string, uid = 0): FakeEntry => ({
    uid,
    gid: uid,
    mode: 0o777,
    kind: "symlink",
    target,
  });

  it("walks a linked directory at its target, with the remaining depth", () => {
    const tree = cleanTree();
    tree.set("/opt/target", dir(0, 0, 0o755));
    tree.set("/opt/target/writable.js", file(0, 0, 0o666));
    tree.set("/opt/code/linked", link("/opt/target"));
    expect(check(tree, 2)).toEqual([
      "private-agent-write /opt/target/writable.js",
    ]);
    // One level less: the link is still resolved, its contents are not walked.
    expect(check(tree, 1)).toEqual([]);
  });

  it("checks every link and directory on the way to a target", () => {
    const tree = cleanTree();
    tree.set("/opt/hop", dir(1000, 1000, 0o755));
    tree.set("/opt/hop/next", link("/opt/code/package.json", 1000));
    tree.set("/opt/code/via-hop", link("/opt/hop/next"));
    expect(check(tree)).toEqual([
      "private-owner /opt/hop",
      "private-agent-write /opt/hop",
      "private-owner /opt/hop/next",
    ]);
    // A relative target resolves against the link's directory.
    const relative = cleanTree();
    relative.set("/opt/code/rel", link("../hop/x"));
    relative.set("/opt/hop", dir(0, 0, 0o777));
    relative.set("/opt/hop/x", file(0, 0, 0o644));
    expect(check(relative)).toEqual(["private-agent-write /opt/hop"]);
  });

  it("applies .. in a link target after the link before it", () => {
    // /opt/code/rel -> ../outside/hop/../safe.js, where hop -> /opt/agent/deeper:
    // the kernel reads /opt/agent/safe.js, not /opt/outside/safe.js.
    const tree = cleanTree();
    tree.set("/opt/outside", dir(0, 0, 0o755));
    tree.set("/opt/outside/safe.js", file(0, 0, 0o644));
    tree.set("/opt/outside/hop", link("/opt/agent/deeper"));
    tree.set("/opt/agent", dir(1000, 1000, 0o755));
    tree.set("/opt/agent/deeper", dir(1000, 1000, 0o755));
    tree.set("/opt/agent/safe.js", file(1000, 1000, 0o644));
    tree.set("/opt/code/rel", link("../outside/hop/../safe.js"));
    expect(check(tree)).toEqual([
      "private-owner /opt/agent",
      "private-agent-write /opt/agent",
      "private-owner /opt/agent/deeper",
      "private-agent-write /opt/agent/deeper",
      "private-owner /opt/agent/safe.js",
      "private-agent-write /opt/agent/safe.js",
    ]);
  });

  it("resolves a relative target the way the kernel does", () => {
    const root = mkdtempSync(join(tmpdir(), "split-links-"));
    try {
      const at = (name: string) => join(root, name);
      for (const d of ["outside", "agent", "agent/deeper", "code", "state"])
        mkdirSync(at(d), { mode: 0o755 });
      chmodSync(at("state"), 0o700);
      chmodSync(at("agent"), 0o777);
      writeFileSync(at("outside/safe.js"), "safe");
      writeFileSync(at("agent/safe.js"), "agent-controlled");
      symlinkSync(at("agent/deeper"), at("outside/hop"));
      symlinkSync("../outside/hop/../safe.js", at("code/rel"));
      // What the kernel resolves and reads through the link.
      expect(realpathSync(at("code/rel"))).toBe(at("agent/safe.js"));
      expect(readFileSync(at("code/rel"), "utf8")).toBe("agent-controlled");
      const failures = runTrustedChecks({
        serverUid: process.getuid!(),
        serverGid: process.getgid!(),
        agent: { uid: 4242, gid: 4242, groups: [4242] },
        stateRoot: at("state"),
        shareRoot: at("state"),
        codeRoot: at("code"),
        codeDepth: 2,
      })
        .filter((f) => f.path?.startsWith(root))
        .map((f) => `${f.check} ${f.path}`);
      // The agent can write the directory the link really ends in.
      expect(failures).toContain(`private-agent-write ${at("agent")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a link cycle instead of looping", () => {
    const tree = cleanTree();
    tree.set("/opt/code/a", link("/opt/code/b"));
    tree.set("/opt/code/b", link("/opt/code/a"));
    expect(check(tree)).toContain("missing /opt/code/a");
    const loop = cleanTree();
    loop.set("/opt/code/server/up", link("/opt/code"));
    expect(check(loop, Infinity)).toEqual([]);
  });

  it("walks the code tree only to the given depth", () => {
    const tree = cleanTree();
    tree.get("/opt/code/server/deep/b.ts")!.mode = 0o666;
    expect(check(tree, 2)).toEqual([]);
    expect(check(tree, Infinity)).toEqual([
      "private-agent-write /opt/code/server/deep/b.ts",
    ]);
  });

  it("names each broken share entry", () => {
    const cases: [(tree: Map<string, FakeEntry>) => void, string][] = [
      [
        (t) => (t.get("/srv/server/share/files")!.mode = 0o750),
        "share-setgid /srv/server/share/files",
      ],
      [
        (t) => (t.get("/srv/server/share/files/a.png")!.uid = 1000),
        "share-owner /srv/server/share/files/a.png",
      ],
      [
        (t) => (t.get("/srv/server/share/files/a.png")!.gid = SERVER),
        "share-group /srv/server/share/files/a.png",
      ],
      [
        (t) => (t.get("/srv/server/share/files")!.mode = 0o2770),
        "share-agent-write /srv/server/share/files",
      ],
      [
        (t) =>
          t.set("/srv/server/share/files/x.sock", {
            uid: SERVER,
            gid: 1000,
            mode: 0o660,
            kind: "socket",
          }),
        "share-entry-type /srv/server/share/files/x.sock",
      ],
      [
        (t) =>
          (t.get("/srv/server/share/authority/authority.sock")!.mode = 0o666),
        "share-agent-write /srv/server/share/authority/authority.sock",
      ],
    ];
    for (const [breakIt, expected] of cases) {
      const tree = cleanTree();
      breakIt(tree);
      expect(check(tree)).toContain(expected);
    }
  });

  it("judges a share symlink by its target", () => {
    const tree = cleanTree();
    const link = (target: string): FakeEntry => ({
      uid: SERVER,
      gid: 1000,
      mode: 0o777,
      kind: "symlink",
      target,
    });
    tree.set(
      "/srv/server/share/files/same.png",
      link("/srv/server/share/files/a.png"),
    );
    expect(check(tree)).toEqual([]);
    tree.set("/var", dir(0, 0, 0o755));
    tree.set("/var/agent.png", file(1000, 1000, 0o644));
    tree.set("/srv/server/share/files/out.png", link("/var/agent.png"));
    expect(check(tree)).toEqual([
      "private-owner /var/agent.png",
      "private-agent-write /var/agent.png",
    ]);
  });

  it("fails closed when an ACL cannot be read", () => {
    const fs = probe(cleanTree());
    const failures = runTrustedChecks({
      serverUid: SERVER,
      serverGid: SERVER,
      agent: AGENT,
      stateRoot: "/srv/server/.isomux",
      shareRoot: "/srv/server/share",
      codeRoot: "/opt/code",
      codeDepth: 2,
      fs: {
        ...fs,
        acl: (path, kind) => {
          if (path === "/opt/code/package.json") throw new Error("EIO");
          return fs.acl(path, kind);
        },
      },
    }).map((f) => f.check);
    expect(failures).toContain("acl-unreadable");
  });
});
