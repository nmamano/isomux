// The swap of an office move-in (task 78733adf, slice 2c-1), on a scratch
// home: the fresh office's home with the old office's stage in it, swapped by
// runMoveInSwapAtBoot as the boot runs it.
//
// The design round's conditions pinned here:
// - B1: the ops come from the home as it is at the swap boot, not at finish;
//   a stored op that finds both stage/p and home/p fails, never skips; a
//   stage entry left after the ops fails.
// - B2: the old office's own unit (its file, drop-in folder and enable links)
//   goes to aside/.from-stage, also when the new box's unit has another name.
// - D3: the keep rule (out and sign-in paths at any depth, the office id, the
//   new office's own unit), hole folders, and the fresh SQLite side files go
//   aside with the fresh database.
// - D5: a crash before each op and each step, then a resume, gives the same
//   home as a run without a crash.
// - D6, D7: the merges of users.json and office-config.json.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MOVE_IN_DIR, MOVE_IN_STATE_FILE } from "./office-move.ts";
import { MOVE_IN_STAGE } from "./office-move-stage.ts";
import { MOVE_UNITS_FILE, type AgentUnit } from "./office-move-units.ts";
import { MOVE_IN_OUTSIDE_FILE } from "./office-move-outside.ts";
import { isValidMemberName } from "./users.ts";
import {
  OFFICE_CONFIG_BOX_KEYS,
  OFFICE_CONFIG_OFFICE_KEYS,
} from "./persistence.ts";
import {
  checkMoveInSwap,
  MOVE_IN_ASIDE,
  MOVE_IN_FROM_STAGE,
  MOVE_IN_SWAP_FILE,
  planMoveInSwap,
  runMoveInSwapAtBoot,
  writeMoveInSwapFile,
  type MoveInSwapFile,
  type MoveInSwapInputs,
} from "./office-move-swap.ts";

const NOW = new Date("2026-11-16T10:00:00Z");
const UNIT_DIR = ".config/systemd/user";

let base = "";
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = "";
});

function scratch(): string {
  base = mkdtempSync(join(tmpdir(), "move-swap-"));
  return base;
}

interface Fixture {
  dir: string;
  home: string;
  root: string;
  stage: string;
  aside: string;
  backups: string;
  inputs: MoveInSwapInputs;
}

interface FixtureOpts {
  /** The old office's owner name (a clash with the fresh "Morgan" when it
   *  differs only in case). */
  oldOwnerName?: string;
  /** The new office's own user unit name; null: a system unit. */
  newUnit?: string | null;
  /** The old office's own user unit name; null: a system unit. */
  oldUnit?: string | null;
  /** More live members of the old office, by name. */
  oldExtraNames?: string[];
  /** The old office's removed members (removed-members.json), by name. */
  removedNames?: string[];
  /** Slice 5b: two folders outside the home with their stage (OUTSIDE). */
  outside?: boolean;
}

/** Slice 5b: the outside folders of a fixture: `p` was on this box (empty),
 *  `q/deep` was made by this box. Each holds its stage. */
const OUTSIDE_MTIME = Date.parse("2026-10-01T12:00:00Z");
function outsideOf(dir: string) {
  const p = join(dir, "out", "p");
  const q = join(dir, "out", "q", "deep");
  return {
    p,
    q,
    stageP: join(p, MOVE_IN_DIR, MOVE_IN_STAGE),
    stageQ: join(q, MOVE_IN_DIR, MOVE_IN_STAGE),
  };
}

const UNITS: AgentUnit[] = [
  {
    name: "tunnel.service",
    fragmentPath: "",
    unitFileState: "enabled",
    activeState: "active",
    transient: false,
  },
];

function sqliteDb(path: string, value: string): void {
  const db = new Database(path);
  db.run("CREATE TABLE t (v TEXT)");
  db.run("INSERT INTO t (v) VALUES (?)", [value]);
  db.close();
}

function put(root: string, rel: string, data: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), data);
}

function link(root: string, rel: string, target: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  symlinkSync(target, join(root, rel));
}

const FRESH_OWNER = {
  id: "u-fresh",
  name: "Morgan",
  role: "owner",
  createdAt: 1_700_000_000_000,
  language: "en",
};

/** A fresh office's home with the old office's stage in it, and swap.json as
 *  finish writes it (inputs only). Built at `dir` (the same path each time,
 *  so two runs compare byte for byte). */
function fixture(dir: string, opts: FixtureOpts = {}): Fixture {
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, "home");
  const root = join(home, ".isomux");
  const stage = join(home, MOVE_IN_DIR, MOVE_IN_STAGE);
  const aside = join(home, MOVE_IN_DIR, MOVE_IN_ASIDE);
  const backups = join(dir, "backups");
  const newUnit = opts.newUnit === undefined ? "isomux.service" : opts.newUnit;
  const oldUnit = opts.oldUnit === undefined ? "isomux.service" : opts.oldUnit;

  // ---- the fresh office ----
  put(
    home,
    ".isomux/users.json",
    JSON.stringify({ [FRESH_OWNER.id]: FRESH_OWNER }),
  );
  put(home, ".isomux/office-id", "aaaaaaaaaaaa\n");
  put(home, ".isomux/sessions.json", "fresh-sessions");
  sqliteDb(join(root, "office.sqlite"), "fresh");
  put(home, ".isomux/office.sqlite-wal", "fresh-wal");
  put(home, ".isomux/office.sqlite-shm", "fresh-shm");
  put(
    home,
    ".isomux/office-config.json",
    JSON.stringify({
      name: "Fresh office",
      prompt: "fresh prompt",
      publicOrigin: "https://new.example.com",
      networkBind: "0.0.0.0",
      backupDir: backups,
    }),
  );
  put(home, ".isomux/agents.json", "fresh-agents");
  put(home, ".isomux/turns-in-flight.json", "fresh-turns");
  put(
    home,
    `.isomux/${MOVE_IN_STATE_FILE}`,
    JSON.stringify({ phase: "swapping" }),
  );
  put(home, ".ssh/id_ed25519", "fresh-ssh");
  // The Hosted control plane's login line on the new box (slice 3: kept).
  put(home, ".ssh/authorized_keys", "fresh-authorized-keys");
  put(home, ".isomux/secrets/office.json", "fresh-secrets");
  put(home, ".config/gh/hosts.yml", "fresh-gh");
  put(home, ".config/fresh-only.conf", "fresh-only");
  put(home, ".claude/.credentials.json", "fresh-cred");
  put(home, ".claude/settings.json", "fresh-settings");
  put(home, ".cache/x", "fresh-cache");
  put(home, "isomux-code/server.ts", "fresh-code");
  put(home, "notes.txt", "fresh-notes");
  put(home, "shared.txt", "fresh-shared");
  if (newUnit) {
    put(home, `${UNIT_DIR}/${newUnit}`, "fresh-unit");
    put(home, `${UNIT_DIR}/${newUnit}.d/override.conf`, "fresh-override");
    link(home, `${UNIT_DIR}/default.target.wants/${newUnit}`, `../${newUnit}`);
  }
  // What the fresh office's backup runs made, and a file of the owner's in
  // the same folder (a backup folder can be shared).
  put(backups, "isomux-2026-11-15.tar.gz", "fresh-backup-1");
  put(backups, "isomux-2026-11-16.tar.gz", "fresh-backup-2");
  put(backups, "isomux-2026-11-16.tar.gz.verified.json", "{}");
  put(backups, "isomux-2026-11-16-2/office.sqlite", "a folder copy");
  put(backups, ".isomux-backup-123.partial", "partial");
  put(backups, "owner-notes.txt", "the owner's own file");

  // ---- the stage: the old office's home ----
  put(
    stage,
    ".isomux/users.json",
    JSON.stringify({
      "u-old1": {
        id: "u-old1",
        name: opts.oldOwnerName ?? "Riley",
        role: "owner",
        createdAt: 1,
      },
      "u-old2": { id: "u-old2", name: "Sam", role: "member", createdAt: 2 },
      ...Object.fromEntries(
        (opts.oldExtraNames ?? []).map((name, i) => [
          `u-extra${i}`,
          { id: `u-extra${i}`, name, role: "member", createdAt: 3 + i },
        ]),
      ),
    }),
  );
  if (opts.removedNames)
    put(
      stage,
      ".isomux/removed-members.json",
      JSON.stringify(
        Object.fromEntries(
          opts.removedNames.map((name, i) => [
            `u-gone${i}`,
            {
              user: { id: `u-gone${i}`, name, role: "member", createdAt: 9 },
              removedAt: 10,
              removedBy: "Riley",
              heirId: null,
              heirName: null,
              passed: {
                agentIds: [],
                killedAgentIds: [],
                cronjobIds: [],
                webhookIds: [],
              },
            },
          ]),
        ),
      ),
    );
  put(stage, ".isomux/office-id", "bbbbbbbbbbbb\n");
  sqliteDb(join(stage, ".isomux/office.sqlite"), "old");
  put(
    stage,
    ".isomux/office-config.json",
    JSON.stringify({
      name: "Old office",
      prompt: "old prompt",
      publicOrigin: "https://old.example.com",
      networkBind: "127.0.0.1",
      trustedProxy: "10.0.0.1",
      backupDir: "/mnt/old-backups",
    }),
  );
  put(stage, ".isomux/agents.json", "old-agents");
  put(stage, ".isomux/turns-in-flight.json", "old-turns");
  put(stage, ".isomux/apps-stopped-by-lock.json", "old-apps");
  put(stage, ".claude/settings.json", "old-settings");
  // Slice 3: the old office's sign-ins and secrets, and its bound files.
  put(stage, ".claude/.credentials.json", "old-cred");
  put(stage, ".ssh/id_ed25519", "old-ssh");
  put(stage, ".ssh/authorized_keys", "old-authorized-keys");
  put(stage, ".config/gh/hosts.yml", "old-gh");
  put(stage, ".isomux/secrets/office.json", "old-secrets");
  put(stage, ".isomux/api-tokens.json", "old-api-tokens");
  put(stage, ".isomux/sessions.json", "old-sessions");
  put(stage, ".claude/projects/p.jsonl", "old-project");
  put(stage, ".config/other.conf", "old-other");
  put(stage, "isomux-code/proj.txt", "old-at-code-dir");
  put(stage, "shared.txt", "old-shared");
  put(stage, "docs/a.txt", "old-docs");
  put(
    stage,
    "docs/isomux.service",
    "a file named like a unit, not in a unit folder",
  );
  put(stage, `${UNIT_DIR}/tunnel.service`, "old-tunnel");
  link(
    stage,
    `${UNIT_DIR}/default.target.wants/tunnel.service`,
    "../tunnel.service",
  );
  if (oldUnit) {
    put(stage, `${UNIT_DIR}/${oldUnit}`, "old-unit");
    put(stage, `${UNIT_DIR}/${oldUnit}.d/override.conf`, "old-override");
    link(stage, `${UNIT_DIR}/default.target.wants/${oldUnit}`, `../${oldUnit}`);
  }

  const box = {
    release: "v2026.11.12",
    commit: "a".repeat(40),
    homePath: home,
    stateRoot: root,
  };
  const unitOf = (name: string | null) =>
    name ? { name, fragmentPath: join(home, UNIT_DIR, name) } : null;
  const inputs: MoveInSwapInputs = {
    version: 1,
    home,
    stateRoot: root,
    codeDir: join(home, "isomux-code"),
    backupDir: backups,
    newOfficeUnit: unitOf(newUnit),
    oldOfficeUnit: unitOf(oldUnit),
    ownerId: FRESH_OWNER.id,
    units: UNITS,
    report: {
      oldOrigin: "https://old.example.com",
      office: { ...box, officeUnit: unitOf(oldUnit) },
      finishedAt: NOW.getTime() - 60_000,
      by: { kind: "member", id: FRESH_OWNER.id, name: "Morgan" },
      excluded: [{ unit: "ssh", entries: 3, bytes: 300 }],
      secretCount: 2,
      missing: [],
    },
  };
  if (opts.outside) {
    const o = outsideOf(dir);
    put(o.stageP, "a.txt", "old-outside-a");
    put(o.stageP, "sub/b.txt", "old-outside-b");
    link(o.stageP, "ln", "a.txt");
    put(o.stageQ, "c.txt", "old-outside-c");
    chmodSync(o.p, 0o700);
    inputs.outside = [
      { path: o.p, mode: 0o750, mtime: OUTSIDE_MTIME },
      { path: o.q, mode: 0o711, mtime: OUTSIDE_MTIME + 1000 },
    ];
    // The record as writeMoveInOutside writes it (its own tests are in
    // office-move-outside.test.ts).
    put(
      join(home, MOVE_IN_DIR),
      MOVE_IN_OUTSIDE_FILE,
      JSON.stringify({
        staged: [o.p, o.q],
        created: [join(dir, "out", "q"), o.q],
      }),
    );
  }
  writeMoveInSwapFile(home, { inputs, ops: null });
  return { dir, home, root, stage, aside, backups, inputs };
}

/** Every entry under `root`: a file's content (or its hash for a binary),
 *  a link's target, "dir" for a folder. */
function snap(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (rel: string) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const p = join(root, r);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[r] = "dir";
        visit(r);
      } else {
        const buf = readFileSync(p);
        out[r] = /\.sqlite$/.test(r)
          ? `sqlite:${createHash("sha256").update(buf).digest("hex")}`
          : buf.toString("utf8");
      }
    }
  };
  if (existsSync(root)) visit("");
  return out;
}

const text = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(text(p)) as Record<string, unknown>;

function dbValue(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT v FROM t").get() as { v: string }).v;
  } finally {
    db.close();
  }
}

/** Files and links left in the stage (empty folders may stay). */
function stageLeft(f: Fixture): string[] {
  return Object.entries(snap(f.stage))
    .filter(([, v]) => v !== "dir")
    .map(([k]) => k);
}

function swap(f: Fixture, onStep?: (step: string) => void) {
  return runMoveInSwapAtBoot({ home: f.home, now: () => NOW, onStep });
}

describe("the swap at boot", () => {
  it("does nothing without swap.json", () => {
    const f = fixture(join(scratch(), "o"));
    rmSync(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE));
    const before = snap(f.dir);
    expect(swap(f).kind).toBe("none");
    expect(snap(f.dir)).toEqual(before);
  });

  it("puts the old office in place with its sign-ins and secrets, and keeps the new box's bound files, identity, code, caches and unit", () => {
    const f = fixture(join(scratch(), "o"));
    const r = swap(f);
    expect(r.kind).toBe("swapped");
    const h = (p: string) => text(join(f.home, p));
    const a = (p: string) => text(join(f.aside, p));
    const fromStage = (p: string) => text(join(f.aside, MOVE_IN_FROM_STAGE, p));

    // In: the old office's state and files, at the top and inside hole folders.
    expect(dbValue(join(f.root, "office.sqlite"))).toBe("old");
    expect(h(".isomux/agents.json")).toBe("old-agents");
    expect(h(".isomux/turns-in-flight.json")).toBe("old-turns");
    expect(h(".isomux/apps-stopped-by-lock.json")).toBe("old-apps");
    expect(h(".claude/settings.json")).toBe("old-settings");
    expect(h(".claude/projects/p.jsonl")).toBe("old-project");
    expect(h(".config/other.conf")).toBe("old-other");
    expect(h("shared.txt")).toBe("old-shared");
    expect(h("docs/a.txt")).toBe("old-docs");
    expect(h("docs/isomux.service")).toContain("not in a unit folder");
    expect(h(`${UNIT_DIR}/tunnel.service`)).toBe("old-tunnel");
    expect(
      readlinkSync(
        join(f.home, UNIT_DIR, "default.target.wants/tunnel.service"),
      ),
    ).toBe("../tunnel.service");

    // In (slice 3): the old office's sign-ins and secrets.
    expect(h(".claude/.credentials.json")).toBe("old-cred");
    expect(h(".ssh/id_ed25519")).toBe("old-ssh");
    expect(h(".config/gh/hosts.yml")).toBe("old-gh");
    expect(h(".isomux/secrets/office.json")).toBe("old-secrets");
    expect(h(".isomux/api-tokens.json")).toBe("old-api-tokens");
    expect(a(".claude/.credentials.json")).toBe("fresh-cred");
    expect(a(".ssh/id_ed25519")).toBe("fresh-ssh");
    expect(a(".isomux/secrets/office.json")).toBe("fresh-secrets");

    // Kept: identity, the files bound to the box or its origin, code, caches.
    expect(h(".isomux/office-id")).toBe("aaaaaaaaaaaa\n");
    expect(h(".isomux/sessions.json")).toBe("fresh-sessions");
    expect(h(".ssh/authorized_keys")).toBe("fresh-authorized-keys");
    expect(fromStage(".isomux/sessions.json")).toBe("old-sessions");
    expect(fromStage(".ssh/authorized_keys")).toBe("old-authorized-keys");
    expect(h(".cache/x")).toBe("fresh-cache");
    expect(h("isomux-code/server.ts")).toBe("fresh-code");
    // The new office's own unit, its drop-in and its link.
    expect(h(`${UNIT_DIR}/isomux.service`)).toBe("fresh-unit");
    expect(h(`${UNIT_DIR}/isomux.service.d/override.conf`)).toBe(
      "fresh-override",
    );
    expect(
      readlinkSync(
        join(f.home, UNIT_DIR, "default.target.wants/isomux.service"),
      ),
    ).toBe("../isomux.service");

    // Aside: the fresh entries the old ones replaced, and fresh-only entries.
    expect(dbValue(join(f.aside, ".isomux/office.sqlite"))).toBe("fresh");
    expect(a(".isomux/agents.json")).toBe("fresh-agents");
    expect(a(".claude/settings.json")).toBe("fresh-settings");
    expect(a(".config/fresh-only.conf")).toBe("fresh-only");
    expect(a("notes.txt")).toBe("fresh-notes");
    expect(a("shared.txt")).toBe("fresh-shared");
    expect(existsSync(join(f.home, "notes.txt"))).toBe(false);
    expect(existsSync(join(f.home, ".config/fresh-only.conf"))).toBe(false);

    // From the stage, set aside: entries at kept paths.
    expect(fromStage(".isomux/office-id")).toBe("bbbbbbbbbbbb\n");
    expect(fromStage("isomux-code/proj.txt")).toBe("old-at-code-dir");
    expect(fromStage(`${UNIT_DIR}/isomux.service`)).toBe("old-unit");
    expect(existsSync(join(f.home, "isomux-code/proj.txt"))).toBe(false);

    // Nothing of the stage is left behind, and swap.json goes last.
    expect(stageLeft(f)).toEqual([]);
    expect(existsSync(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(
      false,
    );
    // A second boot does nothing.
    expect(swap(f).kind).toBe("none");
  });

  it("D3 R: the fresh database's -wal and -shm go aside with it, never next to the old database", () => {
    const f = fixture(join(scratch(), "o"));
    expect(swap(f).kind).toBe("swapped");
    expect(existsSync(join(f.root, "office.sqlite-wal"))).toBe(false);
    expect(existsSync(join(f.root, "office.sqlite-shm"))).toBe(false);
    expect(text(join(f.aside, ".isomux/office.sqlite-wal"))).toBe("fresh-wal");
    expect(text(join(f.aside, ".isomux/office.sqlite-shm"))).toBe("fresh-shm");
    // The old database opens with its own content.
    expect(dbValue(join(f.root, "office.sqlite"))).toBe("old");
  });

  it("writes the state `moved` with the report, move-units.json, and deletes the fresh office's backups and nothing else of their folder", () => {
    const f = fixture(join(scratch(), "o"));
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const state = json(join(f.root, MOVE_IN_STATE_FILE));
    expect(state.phase).toBe("moved");
    // No session or key of the pairing survives in the terminal state.
    expect(Object.keys(state).filter((k) => /session|key/i.test(k))).toEqual(
      [],
    );
    const report = state.report as typeof r.report;
    expect(report).toEqual(r.report);
    expect(report.oldOrigin).toBe("https://old.example.com");
    expect(report.secretCount).toBe(2);
    expect(report.excluded).toEqual([{ unit: "ssh", entries: 3, bytes: 300 }]);
    expect(report.swappedAt).toBe(NOW.getTime());
    expect(report.ownerRenamedTo).toBeNull();
    expect(report.units).toBeNull();
    expect(report.audited).toBe(false);
    expect([...report.aside.entries].sort()).toEqual(
      readdirSync(f.aside).sort(),
    );
    expect(report.aside.entries).toContain("notes.txt");
    expect(report.aside.bytes).toBeGreaterThan(0);
    expect(JSON.parse(text(join(f.root, MOVE_UNITS_FILE)))).toEqual(UNITS);
    expect(readdirSync(f.backups)).toEqual(["owner-notes.txt"]);
  });

  it("D6: users.json is the old office's plus the fresh owner, kept with its id, record and role", () => {
    const f = fixture(join(scratch(), "o"));
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const users = json(join(f.root, "users.json"));
    expect(Object.keys(users).sort()).toEqual(["u-fresh", "u-old1", "u-old2"]);
    expect(users["u-fresh"]).toEqual(FRESH_OWNER);
    expect((users["u-old1"] as { name: string }).name).toBe("Riley");
    expect(r.report.ownerRenamedTo).toBeNull();
  });

  it("D6: a name clash (in any case) renames the fresh owner, once", () => {
    const f = fixture(join(scratch(), "o"), { oldOwnerName: "morgan" });
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const users = json(join(f.root, "users.json"));
    const kept = users["u-fresh"] as { name: string; role: string };
    expect(kept.name).not.toBe("Morgan");
    expect(kept.name.startsWith("Morgan")).toBe(true);
    expect(kept.role).toBe("owner");
    expect(r.report.ownerRenamedTo).toBe(kept.name);
    // The new name clashes with no one, and is a name a member may have.
    const names = Object.values(users).map((u) =>
      (u as { name: string }).name.toLowerCase(),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(isValidMemberName(kept.name)).toBe(true);
  });

  /** The fresh owner's name after a swap of this fixture, and the report's. */
  function ownerNameAfter(opts: FixtureOpts) {
    // One scratch dir per test: fixture() empties the dir it builds in.
    const f = fixture(join(base || scratch(), "o"), opts);
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const users = json(join(f.root, "users.json"));
    return {
      name: (users["u-fresh"] as { name: string }).name,
      renamedTo: r.report.ownerRenamedTo,
      liveNames: Object.entries(users)
        .filter(([id]) => id !== "u-fresh")
        .map(([, u]) => (u as { name: string }).name.toLowerCase()),
    };
  }

  it("D6: when the first new name is taken too, the next one is free and valid", () => {
    const first = ownerNameAfter({ oldOwnerName: "Morgan" }).name;
    const second = ownerNameAfter({
      oldOwnerName: "Morgan",
      oldExtraNames: [first.toUpperCase()],
    });
    expect(second.renamedTo).toBe(second.name);
    expect(second.liveNames).not.toContain(second.name.toLowerCase());
    expect(second.name.toLowerCase()).not.toBe(first.toLowerCase());
    expect(second.name.startsWith("Morgan")).toBe(true);
    expect(isValidMemberName(second.name)).toBe(true);
  });

  it("D6: a removed member's name is reserved: the fresh owner does not take it, nor a new name it holds", () => {
    // No live clash: Morgan is taken only by a removed member.
    const reserved = ownerNameAfter({ removedNames: ["MORGAN"] });
    expect(reserved.name.toLowerCase()).not.toBe("morgan");
    expect(reserved.name.startsWith("Morgan")).toBe(true);
    expect(reserved.renamedTo).toBe(reserved.name);
    expect(isValidMemberName(reserved.name)).toBe(true);

    // The first new name is held by a removed member: the owner skips it.
    const first = ownerNameAfter({ oldOwnerName: "Morgan" }).name;
    const next = ownerNameAfter({
      oldOwnerName: "Morgan",
      removedNames: [first.toLowerCase()],
    });
    expect(next.name.toLowerCase()).not.toBe(first.toLowerCase());
    expect(next.name.toLowerCase()).not.toBe("morgan");
    expect(isValidMemberName(next.name)).toBe(true);

    // Without removed members the name stays (the enabling condition).
    expect(ownerNameAfter({}).renamedTo).toBeNull();
  });

  it("D6: an unreadable removed-members index reserves no name and does not stop the swap", () => {
    const f = fixture(join(scratch(), "o"), { removedNames: ["Morgan"] });
    const index = join(f.stage, ".isomux/removed-members.json");
    expect(existsSync(index)).toBe(true);
    writeFileSync(index, "{ not json");
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    expect(r.report.ownerRenamedTo).toBeNull();
    const users = json(join(f.root, "users.json"));
    expect((users["u-fresh"] as { name: string }).name).toBe("Morgan");
  });

  it("D7: office-config.json is the old office's with the box's values of the fresh one (absent there: deleted)", () => {
    const f = fixture(join(scratch(), "o"));
    expect(swap(f).kind).toBe("swapped");
    const cfg = json(join(f.root, "office-config.json"));
    expect(cfg.name).toBe("Old office");
    expect(cfg.prompt).toBe("old prompt");
    expect(cfg.publicOrigin).toBe("https://new.example.com");
    expect(cfg.networkBind).toBe("0.0.0.0");
    expect(cfg.backupDir).toBe(f.backups);
    expect("trustedProxy" in cfg).toBe(false);
  });
});

describe("B2: the old office's own unit", () => {
  it("goes to .from-stage with its drop-in folder and enable link when the new box runs a system unit", () => {
    const f = fixture(join(scratch(), "o"), {
      newUnit: null,
      oldUnit: "isomux.service",
    });
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const fromStage = join(f.aside, MOVE_IN_FROM_STAGE, UNIT_DIR);
    expect(existsSync(join(f.home, UNIT_DIR, "isomux.service"))).toBe(false);
    expect(existsSync(join(f.home, UNIT_DIR, "isomux.service.d"))).toBe(false);
    expect(
      existsSync(join(f.home, UNIT_DIR, "default.target.wants/isomux.service")),
    ).toBe(false);
    expect(text(join(fromStage, "isomux.service"))).toBe("old-unit");
    expect(text(join(fromStage, "isomux.service.d/override.conf"))).toBe(
      "old-override",
    );
    expect(
      lstatSync(
        join(fromStage, "default.target.wants/isomux.service"),
      ).isSymbolicLink(),
    ).toBe(true);
    // The agent-made unit and its link come in; a file of that name outside a
    // unit folder too.
    expect(text(join(f.home, UNIT_DIR, "tunnel.service"))).toBe("old-tunnel");
    expect(
      lstatSync(
        join(f.home, UNIT_DIR, "default.target.wants/tunnel.service"),
      ).isSymbolicLink(),
    ).toBe(true);
    expect(existsSync(join(f.home, "docs/isomux.service"))).toBe(true);
    expect(r.report.oldOfficeUnitSetAside).toBe("isomux.service");
    expect(stageLeft(f)).toEqual([]);
  });

  it("goes to .from-stage when the new box's user unit has another name, and the new one stays", () => {
    const f = fixture(join(scratch(), "o"), {
      newUnit: "isomux.service",
      oldUnit: "isomux-office.service",
    });
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    const wants = join(f.home, UNIT_DIR, "default.target.wants");
    expect(readdirSync(wants).sort()).toEqual([
      "isomux.service",
      "tunnel.service",
    ]);
    expect(existsSync(join(f.home, UNIT_DIR, "isomux-office.service"))).toBe(
      false,
    );
    expect(existsSync(join(f.home, UNIT_DIR, "isomux-office.service.d"))).toBe(
      false,
    );
    expect(text(join(f.home, UNIT_DIR, "isomux.service"))).toBe("fresh-unit");
    expect(
      text(
        join(f.aside, MOVE_IN_FROM_STAGE, UNIT_DIR, "isomux-office.service"),
      ),
    ).toBe("old-unit");
    expect(r.report.oldOfficeUnitSetAside).toBe("isomux-office.service");
  });

  it("is null in the report when the old office ran a system unit", () => {
    const f = fixture(join(scratch(), "o"), { oldUnit: null });
    const r = swap(f);
    if (r.kind !== "swapped") throw new Error(JSON.stringify(r));
    expect(r.report.oldOfficeUnitSetAside).toBeNull();
  });
});

describe("B1: the ops come from the home at the swap boot", () => {
  it("a fresh entry made after finish, with a stage entry's name, at the top and in a hole folder: the old one comes in, the fresh one goes aside", () => {
    const f = fixture(join(scratch(), "o"));
    // After finish wrote swap.json, the fresh office writes on until it stops.
    put(f.home, "docs/late.txt", "fresh-late");
    put(f.home, ".isomux/apps-stopped-by-lock.json", "fresh-apps");
    expect(swap(f).kind).toBe("swapped");
    expect(text(join(f.home, "docs/a.txt"))).toBe("old-docs");
    expect(existsSync(join(f.home, "docs/late.txt"))).toBe(false);
    expect(text(join(f.aside, "docs/late.txt"))).toBe("fresh-late");
    expect(text(join(f.home, ".isomux/apps-stopped-by-lock.json"))).toBe(
      "old-apps",
    );
    expect(text(join(f.aside, ".isomux/apps-stopped-by-lock.json"))).toBe(
      "fresh-apps",
    );
    expect(stageLeft(f)).toEqual([]);
  });

  it("the first swap boot writes the ops before the first rename; a resumed boot uses them", () => {
    const f = fixture(join(scratch(), "o"));
    const before = snap(f.home);
    let renamesSeen = 0;
    const CRASH = new Error("crash");
    expect(() =>
      swap(f, () => {
        // The first step after the plan is written: crash there.
        const stored = JSON.parse(
          text(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE)),
        ) as MoveInSwapFile;
        if (stored.ops !== null) {
          renamesSeen++;
          throw CRASH;
        }
      }),
    ).toThrow(CRASH);
    expect(renamesSeen).toBe(1);
    // No rename ran before the ops were on disk: the home is as it was, but
    // swap.json now holds the ops.
    const stored = JSON.parse(
      text(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE)),
    ) as MoveInSwapFile;
    expect(stored.ops).toEqual(planMoveInSwap(f.inputs));
    const after = snap(f.home);
    delete after[`${MOVE_IN_DIR}/${MOVE_IN_SWAP_FILE}`];
    delete before[`${MOVE_IN_DIR}/${MOVE_IN_SWAP_FILE}`];
    expect(after).toEqual(before);
    // A fresh entry made now is not in the stored ops: the resumed boot keeps
    // to them, so the entry stays where it is (nothing runs between a crash
    // and the next boot to make one; this pins that the ops are not
    // recomputed).
    put(f.home, "made-after-plan.txt", "x");
    expect(swap(f).kind).toBe("swapped");
    expect(text(join(f.home, "made-after-plan.txt"))).toBe("x");
  });

  it("a stored op `in` that finds both stage/p and home/p fails the swap, moves nothing over home/p, and keeps swap.json", () => {
    const f = fixture(join(scratch(), "o"));
    const CRASH = new Error("crash");
    // Crash at the first op, after the ops are stored.
    expect(() =>
      swap(f, () => {
        const stored = JSON.parse(
          text(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE)),
        ) as MoveInSwapFile;
        if (stored.ops !== null) throw CRASH;
      }),
    ).toThrow(CRASH);
    // "docs" is stage-only: its op is a bare `in`. A home entry appears there.
    const stored = JSON.parse(
      text(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE)),
    ) as MoveInSwapFile;
    expect(stored.ops).toContainEqual({ op: "in", path: "docs" });
    expect(stored.ops).not.toContainEqual({ op: "aside", path: "docs" });
    put(f.home, "docs/other.txt", "in the way");
    const r = swap(f);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.step).toContain("docs");
    expect(text(join(f.home, "docs/other.txt"))).toBe("in the way");
    expect(text(join(f.stage, "docs/a.txt"))).toBe("old-docs");
    // It fails before any rename: the fresh office is untouched.
    expect(text(join(f.root, "users.json"))).toContain("u-fresh");
    expect(existsSync(join(f.aside, ".isomux"))).toBe(false);
    expect(existsSync(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(true);
    // The state is not `moved`.
    expect(json(join(f.root, MOVE_IN_STATE_FILE)).phase).not.toBe("moved");
  });

  it("a failed swap names where its page listens: as swap.json says, loopback when swap.json does not read", () => {
    const f = fixture(join(scratch(), "o"));
    const swapPath = join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE);
    const CRASH = new Error("crash");
    // The office listened on all interfaces when the owner finished.
    writeMoveInSwapFile(f.home, {
      inputs: { ...f.inputs, loopbackOnly: false },
      ops: null,
    });
    expect(() =>
      swap(f, () => {
        const stored = JSON.parse(text(swapPath)) as MoveInSwapFile;
        if (stored.ops !== null) throw CRASH;
      }),
    ).toThrow(CRASH);
    put(f.home, "docs/other.txt", "in the way");
    const r = swap(f);
    expect(r.kind === "failed" && r.loopbackOnly).toBe(false);
    expect(r.kind).toBe("failed");
    writeFileSync(swapPath, "not json");
    const unreadable = swap(f);
    expect(unreadable.kind === "failed" && unreadable.loopbackOnly).toBe(true);
  });

  it("a stage entry left after the ops fails the swap", () => {
    const f = fixture(join(scratch(), "o"));
    const CRASH = new Error("crash");
    expect(() =>
      swap(f, () => {
        const stored = JSON.parse(
          text(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE)),
        ) as MoveInSwapFile;
        if (stored.ops !== null) throw CRASH;
      }),
    ).toThrow(CRASH);
    put(f.stage, "not-in-the-ops.txt", "left");
    const r = swap(f);
    expect(r.kind).toBe("failed");
    expect(existsSync(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(true);
    expect(json(join(f.root, MOVE_IN_STATE_FILE)).phase).not.toBe("moved");
  });
});

// Slice 5b: each folder outside the home gets its stage's entries by rename,
// then its own mode and mtime; its stage folder goes. A folder that holds
// anything else fails the swap before any rename, and finish's dry run
// refuses it first.
describe("slice 5b: folders outside the home", () => {
  it("renames each folder's stage into it, sets the folder's mode and mtime, and removes its stage folder and the record", () => {
    const f = fixture(join(scratch(), "o"), { outside: true });
    const o = outsideOf(f.dir);
    const r = swap(f);
    expect(r.kind).toBe("swapped");
    expect(snap(o.p)).toEqual({
      "a.txt": "old-outside-a",
      ln: "link:a.txt",
      sub: "dir",
      "sub/b.txt": "old-outside-b",
    });
    expect(snap(o.q)).toEqual({ "c.txt": "old-outside-c" });
    expect(statSync(o.p).mode & 0o7777).toBe(0o750);
    expect(statSync(o.q).mode & 0o7777).toBe(0o711);
    expect(Math.round(statSync(o.p).mtimeMs)).toBe(OUTSIDE_MTIME);
    expect(Math.round(statSync(o.q).mtimeMs)).toBe(OUTSIDE_MTIME + 1000);
    expect(existsSync(join(f.home, MOVE_IN_DIR, MOVE_IN_OUTSIDE_FILE))).toBe(
      false,
    );
    // The home's swap ran as without outside folders.
    expect(text(join(f.home, "docs/a.txt"))).toBe("old-docs");
  });

  it("a folder that holds an entry besides its stage fails the swap before any rename, naming the folder; nothing moved, in the home or outside", () => {
    const f = fixture(join(scratch(), "o"), { outside: true });
    const o = outsideOf(f.dir);
    put(o.q, "someone.txt", "not the move's");
    const r = swap(f);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(`${r.step} ${r.message}`).toContain(o.q);
    expect(text(join(o.stageP, "a.txt"))).toBe("old-outside-a");
    expect(existsSync(join(o.p, "a.txt"))).toBe(false);
    expect(text(join(o.q, "someone.txt"))).toBe("not the move's");
    expect(text(join(f.stage, "docs/a.txt"))).toBe("old-docs");
    expect(text(join(f.root, "users.json"))).toContain("u-fresh");
    expect(existsSync(join(f.aside, ".isomux"))).toBe(false);
    expect(existsSync(join(f.home, MOVE_IN_DIR, MOVE_IN_SWAP_FILE))).toBe(true);
    // Moved away, the swap goes on.
    rmSync(join(o.q, "someone.txt"));
    expect(swap(f).kind).toBe("swapped");
    expect(text(join(o.q, "c.txt"))).toBe("old-outside-c");
  });

  it("finish's dry run refuses a folder that holds an entry besides its stage, with its path, and passes the clean fixture", async () => {
    const f = fixture(join(scratch(), "o"), { outside: true });
    const o = outsideOf(f.dir);
    expect(await checkMoveInSwap(f.inputs)).toEqual([]);
    put(o.p, "stray.txt", "x");
    const before = snap(f.dir);
    expect(await checkMoveInSwap(f.inputs)).toContainEqual({
      code: "outside_folder_not_empty",
      path: o.p,
    });
    expect(snap(f.dir)).toEqual(before);
  });
});

describe("D5: a crash at any point, then a resume", () => {
  for (const opts of [
    { label: "with a name clash", o: { oldOwnerName: "MORGAN" } },
    { label: "B2 with a system unit on the new box", o: { newUnit: null } },
    { label: "slice 5b with folders outside the home", o: { outside: true } },
  ] as { label: string; o: FixtureOpts }[]) {
    it(`gives the same home as a run without a crash, before each op and each step (${opts.label})`, () => {
      const dir = join(scratch(), "o");
      // The run without a crash, and its steps.
      const steps: string[] = [];
      let f = fixture(dir, opts.o);
      const opCount = planMoveInSwap(f.inputs).length;
      const ref = swap(f, (s) => steps.push(s));
      expect(ref.kind).toBe("swapped");
      const want = snap(dir);
      // Each op, plus at least: the plan's write, users.json, the config,
      // the backups, move-units.json, the state and swap.json's delete.
      expect(steps.length).toBeGreaterThanOrEqual(opCount + 7);
      expect(new Set(steps).size).toBe(steps.length);
      const CRASH = new Error("crash");
      for (let k = 0; k < steps.length; k++) {
        f = fixture(dir, opts.o);
        let i = 0;
        expect(() =>
          swap(f, () => {
            if (i++ === k) throw CRASH;
          }),
        ).toThrow(CRASH);
        const r = swap(f);
        if (r.kind !== "swapped")
          throw new Error(
            `resume after a crash before ${steps[k]}: ${JSON.stringify(r)}`,
          );
        const got = snap(dir);
        if (JSON.stringify(got) !== JSON.stringify(want))
          expect({ crashBefore: steps[k], home: got }).toEqual({
            crashBefore: steps[k],
            home: want,
          });
      }
    }, 60_000);
  }
});

describe("finish's dry run", () => {
  it("passes the fixture", async () => {
    const f = fixture(join(scratch(), "o"));
    expect(await checkMoveInSwap(f.inputs)).toEqual([]);
  });

  it("refuses an id of the old office's users.json that is the fresh owner's", async () => {
    const f = fixture(join(scratch(), "o"));
    put(
      f.stage,
      ".isomux/users.json",
      JSON.stringify({
        [FRESH_OWNER.id]: {
          id: FRESH_OWNER.id,
          name: "Riley",
          role: "owner",
          createdAt: 1,
        },
      }),
    );
    const refusals = await checkMoveInSwap(f.inputs);
    expect(refusals).toContainEqual({
      code: "account_clash",
      id: FRESH_OWNER.id,
    });
    // A dry run changes nothing.
    expect(text(join(f.home, ".isomux/users.json"))).toContain("Morgan");
    expect(existsSync(join(f.stage, ".isomux/users.json"))).toBe(true);
  });

  it("refuses a home with more entries than the walk reads", async () => {
    const f = fixture(join(scratch(), "o"));
    expect(await checkMoveInSwap({ ...f.inputs, walkMax: 5 })).toEqual([
      { code: "home_too_big", entries: 5 },
    ]);
    // The fixture's own count passes a cap just above it.
    expect(await checkMoveInSwap({ ...f.inputs, walkMax: 10_000 })).toEqual([]);
  });

  it("changes nothing on the disk", async () => {
    const f = fixture(join(scratch(), "o"));
    const before = snap(f.dir);
    await checkMoveInSwap(f.inputs);
    expect(snap(f.dir)).toEqual(before);
  });
});

describe("D7: every office-config.json key is classed", () => {
  // The keys persistence.ts reads or writes, found in its source: a key a
  // later change adds must go in one of the two lists, or a move silently
  // carries a machine's value to another machine (or drops an office's).
  it("each key persistence.ts reads or writes is in exactly one list", () => {
    const src = readFileSync(join(import.meta.dir, "persistence.ts"), "utf8");
    const keys = new Set<string>();
    for (const m of src.matchAll(/\braw\.(\w+)\b(?!\s*\()/g)) keys.add(m[1]);
    for (const m of src.matchAll(/readOfficeConfigRaw\(\)\.(\w+)/g))
      keys.add(m[1]);
    for (const m of src.matchAll(/saveOfficeConfigField\("(\w+)"/g))
      keys.add(m[1]);
    for (const m of src.matchAll(
      /\.\.\.readOfficeConfigRaw\(\),\n((?:\s+\w+:[^\n]*\n)+)/g,
    ))
      for (const k of m[1].matchAll(/^\s+(\w+):/gm)) keys.add(k[1]);
    // The scan finds what it must (a broken pattern finds nothing).
    for (const k of [
      "publicOrigin",
      "backupDir",
      "memberUsageCap",
      "logsDeleteAfterDays",
    ])
      expect(keys.has(k)).toBe(true);
    const box = new Set(OFFICE_CONFIG_BOX_KEYS);
    const office = new Set(OFFICE_CONFIG_OFFICE_KEYS);
    expect([...box].filter((k) => office.has(k))).toEqual([]);
    expect(
      [...keys].filter((k) => !box.has(k) && !office.has(k)).sort(),
    ).toEqual([]);
  });
});
