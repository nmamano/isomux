// The restore of isolated members' agent spaces from a backup copy
// (member-restore.ts, slice 3c-ii of task b94dfd25). Her runner's side is the
// real files-in / files-place / files-undo code, in process, over a real
// home. The properties:
// - only a finished copy of this office is read (else exit 2, nothing sent);
// - a member is restored only when this office, passwd and her runner name
//   the OS user and uid of her member.json; a refused member does not stop
//   the next one (exit 1);
// - what is sent: her files as listed, to her passwd home, never through a
//   link in the copy (G1), never a path the exclusions leave out now (G2),
//   never a link, never a file whose size changed; what is there stays;
// - a failed place is undone;
// - every name of hers is printed quoted (G3).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  doneFiles,
  placeFiles,
  receiveFiles,
  undoFiles,
  type MoveInInput,
  type PlaceInput,
} from "./member-move-receive.ts";
import {
  restoreMemberSpaces,
  type RestoreDeps,
  type RestoreRunner,
} from "./member-restore.ts";

let top = "";
beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), "member-restore-"));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

let serial = 0;
const fresh = (name: string) => {
  const dir = join(top, `${name}-${++serial}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const ALICE = { id: "u-alice", name: "isomux-alice", uid: 4711 };
const BOB = { id: "u-bob", name: "isomux-bob", uid: 4712 };
type Who = typeof ALICE;

interface Tree {
  files?: Record<string, string>;
  // Manifest-only file lines whose size differs from the file in space/.
  sizes?: Record<string, number>;
  links?: Record<string, string>;
  state?: "copied" | "carried" | "skipped";
  carriedFrom?: string;
}

// A finished copy of `stateRoot` with these members.
function makeCopy(
  stateRoot: string,
  members: [Who, Tree][],
  over: object = {},
) {
  const copy = join(fresh("backups"), "isomux-2026-11-16");
  mkdirSync(join(copy, "members"), { recursive: true });
  writeFileSync(
    join(copy, "backup.json"),
    JSON.stringify({ kind: "folder", office: stateRoot, id: "c", ...over }),
  );
  for (const [who, tree] of members) {
    const dir = join(copy, "members", who.id);
    mkdirSync(dir);
    const state = tree.state ?? "copied";
    writeFileSync(
      join(dir, "member.json"),
      JSON.stringify({
        userId: who.id,
        osUser: { name: who.name, uid: who.uid },
        state,
        at: Date.UTC(2026, 10, 16),
        copiedAt: Date.UTC(2026, 10, 15),
        ...(tree.carriedFrom ? { carriedFrom: tree.carriedFrom } : {}),
      }),
    );
    // A skipped member gets a tree too when the test gives one: then only
    // the state can refuse her.
    const space = join(dir, "space");
    mkdirSync(space);
    const lines: object[] = [];
    const folders = new Set<string>();
    const folder = (rel: string) => {
      for (let d = dirname(rel); d !== "."; d = dirname(d))
        if (!folders.has(d)) {
          folders.add(d);
          mkdirSync(join(space, d), { recursive: true });
        }
    };
    for (const [rel, text] of Object.entries(tree.files ?? {})) {
      folder(rel);
      writeFileSync(join(space, rel), text);
      lines.push({
        p: rel,
        k: "f",
        s: tree.sizes?.[rel] ?? Buffer.byteLength(text),
        o: 0o600,
      });
    }
    for (const [rel, target] of Object.entries(tree.links ?? {})) {
      folder(rel);
      lines.push({ p: rel, k: "l", t: target });
    }
    for (const d of folders) lines.unshift({ p: d, k: "d", o: 0o700 });
    writeFileSync(
      join(dir, "manifest.jsonl.gz"),
      gzipSync(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"),
    );
  }
  return copy;
}

// Her home and her runner, in process: the real files-in / files-place.
function member(
  who: Who,
  over: {
    info?: () => Promise<{ uid: number; user: string }>;
    placeThrows?: boolean;
  } = {},
) {
  const home = fresh(`home-${who.name}`);
  const agentRoot = join(home, ".isomux-agent");
  mkdirSync(agentRoot, { mode: 0o700 });
  const calls: string[] = [];
  const runner: RestoreRunner = {
    info: over.info ?? (async () => ({ uid: who.uid, user: who.name })),
    entry: async (name, input) => {
      calls.push(name);
      if (name === "files-place") {
        const answer = placeFiles(input as PlaceInput);
        if (over.placeThrows) throw new Error("the place failed");
        return answer;
      }
      if (name === "files-undo") return undoFiles(input as PlaceInput);
      if (name === "files-done") return doneFiles(input as PlaceInput);
      throw new Error(`unknown entry ${name}`);
    },
    stream: async (name, input, body) => {
      calls.push(name);
      return receiveFiles(input as MoveInInput, body, {
        freeBytes: () => 2 ** 40,
      });
    },
  };
  return { who, home, agentRoot, calls, runner };
}
type Member = ReturnType<typeof member>;

function deps(
  stateRoot: string,
  members: Member[],
  over: Partial<RestoreDeps> = {},
) {
  const lines: string[] = [];
  const byName = new Map(members.map((m) => [m.who.name, m]));
  const full: RestoreDeps = {
    stateRoot,
    memberState: (userId) => {
      const m = members.find((x) => x.who.id === userId);
      return m
        ? { kind: "isolated", osUser: { name: m.who.name, uid: m.who.uid } }
        : { kind: "none" };
    },
    home: (name, uid) => {
      const m = byName.get(name);
      return m && m.who.uid === uid ? m.home : null;
    },
    runner: (name) => byName.get(name)!.runner,
    out: (line) => lines.push(line),
    ...over,
  };
  return { full, lines };
}

const placedFiles = (m: Member) =>
  existsSync(m.agentRoot)
    ? (
        readdirSync(m.agentRoot, {
          recursive: true,
          withFileTypes: true,
        }) as import("node:fs").Dirent[]
      )
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(m.agentRoot.length + 1))
        .sort()
    : [];

describe("the copy", () => {
  it("is refused whole, with nothing sent, unless it is a finished copy of this office", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE);
    const trees: [Who, Tree][] = [[ALICE, { files: { "a.txt": "A" } }]];
    const other = makeCopy(stateRoot, trees, { office: "/elsewhere/.isomux" });
    const notFolder = makeCopy(stateRoot, trees, { kind: "tar" });
    const partial = makeCopy(stateRoot, trees);
    const partialPath = `${partial}.partial`;
    const { renameSync } = await import("node:fs");
    renameSync(partial, partialPath);
    const noMarker = makeCopy(stateRoot, trees);
    rmSync(join(noMarker, "backup.json"));
    const codes: number[] = [];
    for (const copy of [
      other,
      notFolder,
      partialPath,
      noMarker,
      join(top, "missing"),
      undefined,
    ]) {
      const { full } = deps(stateRoot, [alice]);
      codes.push(await restoreMemberSpaces(copy, full));
    }
    expect([codes, alice.calls, placedFiles(alice)]).toEqual([
      [2, 2, 2, 2, 2, 2],
      [],
      [],
    ]);
  });
});

describe("a member", () => {
  it("is restored to her passwd home, and what is there stays", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE);
    writeFileSync(join(alice.agentRoot, "kept.txt"), "HERS NOW");
    const copy = makeCopy(stateRoot, [
      [
        ALICE,
        {
          files: {
            "provider-homes/u1/claude/s.jsonl": "TRANSCRIPT",
            "kept.txt": "OLD",
          },
        },
      ],
    ]);
    const { full, lines } = deps(stateRoot, [alice]);
    const code = await restoreMemberSpaces(copy, full);
    expect({
      code,
      files: placedFiles(alice),
      transcript: readFileSync(
        join(alice.agentRoot, "provider-homes/u1/claude/s.jsonl"),
        "utf8",
      ),
      kept: readFileSync(join(alice.agentRoot, "kept.txt"), "utf8"),
      calls: alice.calls,
      staging: existsSync(join(alice.agentRoot, ".move-in"))
        ? readdirSync(join(alice.agentRoot, ".move-in"))
        : [],
      keptNamed: lines.some((l) => l.includes(JSON.stringify("kept.txt"))),
    }).toEqual({
      code: 0,
      files: ["kept.txt", "provider-homes/u1/claude/s.jsonl"],
      transcript: "TRANSCRIPT",
      kept: "HERS NOW",
      calls: ["files-in", "files-place", "files-done"],
      staging: [],
      keptNamed: true,
    });
  });

  it("restores a carried tree and says which copy made it", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE);
    const copy = makeCopy(stateRoot, [
      [
        ALICE,
        {
          files: { "a.txt": "A" },
          state: "carried",
          carriedFrom: "isomux-2026-11-01",
        },
      ],
    ]);
    const { full, lines } = deps(stateRoot, [alice]);
    expect([await restoreMemberSpaces(copy, full), placedFiles(alice)]).toEqual(
      [0, ["a.txt"]],
    );
    expect(
      lines.some(
        (l) => l.includes("isomux-2026-11-01") && l.includes("2026-11-15"),
      ),
    ).toBe(true);
  });

  const refusals: [
    string,
    (alice: Member, stateRoot: string) => Partial<RestoreDeps>,
    Tree?,
  ][] = [
    ["the copy has no files of hers", () => ({}), { state: "skipped" }],
    [
      "she is not isolated here",
      () => ({ memberState: () => ({ kind: "none" }) }),
    ],
    [
      "this office runs her as another uid",
      () => ({
        memberState: () => ({
          kind: "isolated",
          osUser: { name: ALICE.name, uid: 9999 },
        }),
      }),
    ],
    [
      "this office runs her as another name",
      () => ({
        memberState: () => ({
          kind: "isolated",
          osUser: { name: "isomux-eve", uid: ALICE.uid },
        }),
      }),
    ],
    [
      "her record is broken",
      () => ({ memberState: () => ({ kind: "broken", reason: "x" }) }),
    ],
    ["passwd has no such user and uid", () => ({ home: () => null })],
    [
      "her runner answers as another uid",
      (a) => ({
        runner: () => ({
          ...a.runner,
          info: async () => ({ uid: 0, user: ALICE.name }),
        }),
      }),
    ],
    [
      "her runner answers as another user",
      (a) => ({
        runner: () => ({
          ...a.runner,
          info: async () => ({ uid: ALICE.uid, user: "root" }),
        }),
      }),
    ],
    [
      "her runner does not answer",
      (a) => ({
        runner: () => ({
          ...a.runner,
          info: () => Promise.reject(new Error("ECONNREFUSED")),
        }),
      }),
    ],
  ];
  for (const [label, override, tree] of refusals)
    it(`is refused when ${label}, and the next member is restored`, async () => {
      const stateRoot = fresh("state");
      const alice = member(ALICE);
      const bob = member(BOB);
      const copy = makeCopy(stateRoot, [
        [ALICE, { files: { "a.txt": "A" }, ...tree }],
        [BOB, { files: { "b.txt": "B" } }],
      ]);
      const base = deps(stateRoot, [alice, bob]).full;
      const o = override(alice, stateRoot);
      // The override is for Alice only.
      const full: RestoreDeps = {
        ...base,
        memberState: (id) =>
          id === ALICE.id && o.memberState
            ? o.memberState(id)
            : base.memberState!(id),
        home: (name, uid) =>
          name === ALICE.name && o.home
            ? o.home(name, uid)
            : base.home!(name, uid),
        runner: (name, uid) =>
          name === ALICE.name && o.runner
            ? o.runner(name, uid)
            : base.runner!(name, uid),
      };
      const code = await restoreMemberSpaces(copy, full);
      expect([code, alice.calls, placedFiles(alice), placedFiles(bob)]).toEqual(
        [1, [], [], ["b.txt"]],
      );
    });

  it("is refused when her folder in the copy is a link, and nothing is read through it", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE);
    const copy = makeCopy(stateRoot, []);
    // A tree that looks like hers, outside the copy.
    const elsewhere = makeCopy(stateRoot, [
      [ALICE, { files: { "a.txt": "OFFICE" } }],
    ]);
    symlinkSync(
      join(elsewhere, "members", ALICE.id),
      join(copy, "members", ALICE.id),
    );
    const { full } = deps(stateRoot, [alice]);
    expect([
      await restoreMemberSpaces(copy, full),
      alice.calls,
      placedFiles(alice),
    ]).toEqual([1, [], []]);
  });

  it("is undone when the place fails", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE, { placeThrows: true });
    writeFileSync(join(alice.agentRoot, "kept.txt"), "HERS");
    const copy = makeCopy(stateRoot, [
      [ALICE, { files: { "a.txt": "A", "kept.txt": "OLD" } }],
    ]);
    const { full } = deps(stateRoot, [alice]);
    expect([
      await restoreMemberSpaces(copy, full),
      placedFiles(alice),
      alice.calls,
    ]).toEqual([1, ["kept.txt"], ["files-in", "files-place", "files-undo"]]);
  });
});

describe("what is sent", () => {
  it("never reads through a link in her space/, never sends what backups leave out now, a link or a changed file", async () => {
    const stateRoot = fresh("state");
    // An office folder with a secret, and a folder of her space/ that is a
    // link to it.
    const office = fresh("office-secrets");
    writeFileSync(join(office, "token"), "OFFICE-SECRET");
    const alice = member(ALICE);
    const copy = makeCopy(stateRoot, [
      [
        ALICE,
        {
          files: {
            "ok.txt": "OK",
            "via/token": "decoy!-------",
            "provider-homes/u1/claude/.credentials.json": "LOGIN",
            "apps/units/x.sh": "LAUNCHER",
            "short.txt": "SHORT",
          },
          sizes: { "short.txt": 99, "via/token": 13 },
          links: { "etc-link": "/etc" },
        },
      ],
    ]);
    const space = join(copy, "members", ALICE.id, "space");
    rmSync(join(space, "via"), { recursive: true });
    symlinkSync(office, join(space, "via"));
    const { full, lines } = deps(stateRoot, [alice]);
    const code = await restoreMemberSpaces(copy, full);
    const all = placedFiles(alice)
      .map((rel) => readFileSync(join(alice.agentRoot, rel), "utf8"))
      .join("|");
    expect({
      code,
      files: placedFiles(alice),
      secret: all.includes("OFFICE-SECRET"),
      link: existsSync(join(alice.agentRoot, "etc-link")),
      named: ["via/token", "short.txt", "etc-link"].map((n) =>
        lines.some((l) => l.includes(JSON.stringify(n))),
      ),
    }).toEqual({
      code: 0,
      files: ["ok.txt"],
      secret: false,
      link: false,
      named: [true, true, true],
    });
  });

  it("prints her names quoted, so they cannot act on the terminal", async () => {
    const stateRoot = fresh("state");
    const alice = member(ALICE);
    const evil = "x\u001b[2J\nu-alice: restored 999 files";
    const copy = makeCopy(stateRoot, [
      [ALICE, { files: { "a.txt": "A" }, links: { [evil]: "/" } }],
    ]);
    const { full, lines } = deps(stateRoot, [alice]);
    await restoreMemberSpaces(copy, full);
    const text = lines.join("\n");
    expect({
      escape: text.includes("\u001b"),
      fakeLine: text
        .split("\n")
        .some((l) => l.startsWith("u-alice: restored 999")),
      quoted: text.includes(JSON.stringify(evil)),
    }).toEqual({ escape: false, fakeLine: false, quoted: true });
  });
});
