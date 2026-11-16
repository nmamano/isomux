// What an office move copies (task 78733adf, slice 2a): the scope
// predicate the manifest walk and each batch path share. Pure over paths
// relative to the office user's home; the walk and batch tests
// (server/office-move-pull.test.ts) own what needs the disk (symlinks,
// SQLite side files).

import { describe, expect, it } from "bun:test";
import { BACKUP_EXCLUSIONS } from "./backup-exclusions.ts";
import { BACKEND_CREDENTIAL_PATHS } from "./backend-credential-paths.ts";
import {
  MOVE_STATE_FILE,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
} from "./office-move.ts";
import { MOVE_UNITS_FILE } from "./office-move-units.ts";
import { LOCKDOWN_APPS_FILE, LOCKDOWN_WAITING_APPS_FILE } from "./lockdown.ts";
import { MOVE_IN_STATE_FILE } from "./office-move-in.ts";
import { MOVE_IN_DIR } from "./office-move-stage.ts";
import {
  createMoveScope,
  moveScope,
  MOVE_BOUND_UNITS,
  MOVE_CARRIED_UNITS,
  type MoveScope,
  type MoveScopeVerdict,
} from "./office-move-scope.ts";

const HOME = "/home/isomux";

function scope(
  over: Partial<{ codeDir: string | null; backupDir: string | null }> = {},
): MoveScope {
  return createMoveScope({
    home: HOME,
    stateRoot: `${HOME}/.isomux`,
    codeDir: over.codeDir === undefined ? "/opt/isomux" : over.codeDir,
    backupDir:
      over.backupDir === undefined ? "/var/backups/isomux" : over.backupDir,
  });
}

const file = (s: MoveScope, p: string) => moveScope(s, p, "file");
const IN: MoveScopeVerdict = { in: true };
const OUT: MoveScopeVerdict = { in: false, why: "out" };

// A verdict as plain data: slice 3 renames the left-out-and-counted reason
// to "bound".
const verdict = (s: MoveScope, p: string) =>
  moveScope(s, p, "file") as unknown as Record<string, unknown>;
const boundAs = (unit: string) => ({ in: false, why: "bound", unit });

// A path a tar glob matches: each "*" becomes one plain segment.
const sample = (pattern: string) => pattern.replaceAll("*", "x");

describe("the move scope", () => {
  it("keeps the home's own content: files, folders and links, at any depth", () => {
    const s = scope();
    expect(file(s, "notes.txt")).toEqual(IN);
    expect(moveScope(s, "work", "dir")).toEqual(IN);
    expect(file(s, "work/proj/src/main.ts")).toEqual(IN);
    expect(moveScope(s, "work/link", "symlink")).toEqual(IN);
    // The office's own data moves.
    expect(file(s, ".isomux/office.sqlite")).toEqual(IN);
    expect(file(s, ".isomux/agents.json")).toEqual(IN);
  });

  // The backup leaves these out because Isomux makes them again (task
  // 1426371a), but they are not sign-ins: the move still copies them.
  it("copies the state the backup leaves out as remade", () => {
    const s = scope();
    for (const p of [
      ".isomux/opencode/profiles/p1/cache/bun/x.tgz",
      ".isomux/opencode/profiles/p1/tmp/x",
      ".isomux/opencode/profiles/p1/home/.npm/_cacache/a",
      ".isomux/opencode/profiles/p1/config/opencode/node_modules/x/package.json",
      ".isomux/codex-home/cache/catalog.json",
      ".isomux/codex-home/.tmp/x",
      ".isomux/provider-homes/u-alice/codex/tmp/x",
      ".isomux/bin/isomux-codex-safety-hook",
      ".isomux/bin/.isomux-codex-safety-hook.golden",
    ])
      expect([p, file(s, p)]).toEqual([p, IN]);
  });

  it("leaves out the home's caches, and only at the home's top: a project folder of the same name moves", () => {
    const s = scope();
    for (const p of [
      ".cache",
      ".cache/pip/x.whl",
      ".bun",
      ".bun/bin/bun",
      ".npm/_cacache/index-v5/a",
      "go/pkg/mod/github.com/x/y.go",
      ".cargo/registry/cache/z.crate",
    ])
      expect([p, file(s, p)]).toEqual([p, OUT]);
    for (const p of [
      "work/proj/.cache/data.json",
      ".npm/config.json",
      "go/src/app/main.go",
      ".cargo/config.toml",
      ".cachedir/x",
    ])
      expect([p, file(s, p)]).toEqual([p, IN]);
  });

  it("leaves out the code folder and the backup folder when they are in the home, and nothing that only shares their name's start", () => {
    const s = scope({
      codeDir: `${HOME}/isomux`,
      backupDir: `${HOME}/isomux-backups`,
    });
    for (const p of [
      "isomux",
      "isomux/server/isomux-office.ts",
      "isomux-backups",
      "isomux-backups/2026-11-14.tar.gz",
    ])
      expect([p, file(s, p)]).toEqual([p, OUT]);
    for (const p of ["isomux-notes/a.md", "isomuxx/b", "isomux-backups2/c"])
      expect([p, file(s, p)]).toEqual([p, IN]);
    // Outside the home, they leave out nothing.
    const outside = scope();
    expect(file(outside, "isomux/server/isomux-office.ts")).toEqual(IN);
  });

  it("leaves out the move's own files and sockets, fifos and devices, uncounted", () => {
    const s = scope();
    for (const name of [
      MOVE_STATE_FILE,
      `${MOVE_STATE_FILE}.tmp`,
      MOVE_UNITS_FILE,
      MOVE_CANCELLED_FILE,
      MOVE_LOCK_MARKER,
      "move-pull",
      "move-pull/abc.ndjson",
    ])
      expect([name, file(s, `.isomux/${name}`)]).toEqual([name, OUT]);
    expect(moveScope(s, "work/agent.sock", "other")).toEqual(OUT);
  });

  // Slice 3: sign-ins and secrets move. Only what is bound to the old box or
  // its origin stays, counted per unit for the after-move report.
  it("carries each backup exclusion and backend login, except the bound units, which stay as named", () => {
    const s = scope();
    const bound = new Set<string>(MOVE_BOUND_UNITS);
    let carried = 0;
    let kept = 0;
    for (const entry of BACKUP_EXCLUSIONS) {
      // The move's own files are left out uncounted (the test above).
      if (entry.id === "office-move") continue;
      for (const pattern of entry.archivePatterns(".isomux")) {
        const p = sample(pattern);
        if (bound.has(entry.id)) {
          expect([p, verdict(s, p)]).toEqual([p, boundAs(entry.id)]);
          kept++;
        } else {
          expect([p, verdict(s, p)]).toEqual([p, { in: true }]);
          carried++;
        }
      }
    }
    expect(carried).toBeGreaterThan(20);
    expect(kept).toBeGreaterThan(0);
    // Backend logins at any depth move.
    for (const p of [
      ".claude/.credentials.json",
      "work/agent-home/.claude/.credentials.json",
      "work/agent-home/.codex/auth.json",
    ])
      expect([p, verdict(s, p)]).toEqual([p, { in: true }]);
  });

  it("matches a backup exclusion as tar does: rooted at the state root, and its * crosses folders", () => {
    const s = scope();
    // "*" matches "/" in a tar exclusion (web-push.json.corrupt-* is bound).
    expect(verdict(s, ".isomux/web-push.json.corrupt-a/b")).toEqual(
      boundAs("web-push"),
    );
    // Rooted: an app's own folder named like a credential store moves.
    for (const p of [
      ".isomux/apps/board/data/secrets/notes.md",
      ".isomux/apps/board/data/user-env",
      "work/secrets/plan.md",
      "work/web-push.json",
      "work/old-copy/.isomux/secrets/notes.md",
    ])
      expect([p, file(s, p)]).toEqual([p, IN]);
  });

  it("every backup exclusion and backend credential id is in exactly one of the bound and carried lists", () => {
    const bound = new Set<string>(MOVE_BOUND_UNITS);
    const carried = new Set<string>(MOVE_CARRIED_UNITS);
    const ids = [
      ...BACKUP_EXCLUSIONS.map((e) => e.id).filter(
        (id) => id !== "office-move",
      ),
      ...BACKEND_CREDENTIAL_PATHS.map((e) => e.id),
    ];
    const wrong = ids.filter((id) => bound.has(id) === carried.has(id));
    expect(wrong).toEqual([]);
    // The carried list names only real ids: an entry no rule reads would
    // seem to decide what moves.
    expect([...carried].filter((id) => !ids.includes(id))).toEqual([]);
    expect([...bound].filter((id) => carried.has(id))).toEqual([]);
    expect(bound.has("office-move") || carried.has("office-move")).toBe(false);
  });

  it("a new backup exclusion in neither list stays on the old box, counted under its id", () => {
    const list = BACKUP_EXCLUSIONS as unknown as {
      id: string;
      archivePatterns: (root: string) => string[];
    }[];
    list.push({
      id: "test-new-store",
      archivePatterns: (root) => [`${root}/new-store`, `${root}/new-store/*`],
    });
    try {
      expect(verdict(scope(), ".isomux/new-store/token.json")).toEqual(
        boundAs("test-new-store"),
      );
    } finally {
      list.pop();
    }
    expect(verdict(scope(), ".isomux/new-store/token.json")).toEqual({
      in: true,
    });
  });

  it("a new backend sign-in file in neither list stays on the old box, at any depth of the home", () => {
    const list = BACKEND_CREDENTIAL_PATHS as unknown as {
      id: string;
      pattern: RegExp;
      backup: "keep";
    }[];
    list.push({
      id: "test-new-login",
      pattern: /(^|\/)\.newtool\/token\.json$/,
      backup: "keep",
    });
    const paths = [".newtool/token.json", "work/.newtool/token.json"];
    try {
      const s = scope();
      for (const p of paths)
        expect([p, verdict(s, p)]).toEqual([p, boundAs("test-new-login")]);
    } finally {
      list.pop();
    }
    const s = scope();
    for (const p of paths) expect([p, verdict(s, p)]).toEqual([p, IN]);
  });

  it("keeps the files bound to the old origin, with their .tmp and .corrupt-* siblings, each under its unit; the bound rule wins over a carried one", () => {
    const s = scope();
    const units: Record<string, string> = {
      "sessions.json": "browser-sessions",
      "app-sessions.json": "app-sessions",
      "invites.json": "invites",
      "browser-connections.json": "extension-pairings",
      // web-push is a backup exclusion too: the bound unit names it.
      "web-push.json": "web-push",
    };
    for (const [name, unit] of Object.entries(units))
      for (const p of [
        `.isomux/${name}`,
        `.isomux/${name}.tmp`,
        `.isomux/${name}.corrupt-1763300000000`,
      ])
        expect([p, verdict(s, p)]).toEqual([p, boundAs(unit)]);
    // Same names elsewhere are a member's own files.
    for (const p of ["work/sessions.json", "work/web-push.json"])
      expect([p, verdict(s, p)]).toEqual([p, { in: true }]);
  });

  it("keeps the old box's SSH login keys and moves the rest of .ssh, gh, the API tokens and the secret store", () => {
    const s = scope();
    for (const p of [".ssh/authorized_keys", ".ssh/authorized_keys2"])
      expect([p, verdict(s, p)]).toEqual([p, boundAs("ssh-authorized-keys")]);
    for (const p of [
      ".ssh",
      ".ssh/id_ed25519",
      ".ssh/id_ed25519.pub",
      ".ssh/known_hosts",
      ".ssh/config",
      ".config/gh/hosts.yml",
      ".isomux/api-tokens.json",
      ".isomux/secrets/office.json",
      ".isomux/secrets/users/u1.json",
      // Only the home's own .ssh: a project's copy moves.
      "work/deploy/.ssh/authorized_keys",
    ])
      expect([p, verdict(s, p)]).toEqual([p, { in: true }]);
    expect(moveScope(s, ".ssh", "dir")).toEqual(IN);
  });
});

// Slice 2b: a later move of an office that once moved in must not carry the
// old stage or the move-in state (it holds the old office's session and key).
describe("the move scope and a move-in on this box", () => {
  it("leaves out the move-in folder (the stage) and the move-in state file", () => {
    const s = scope();
    expect(moveScope(s, MOVE_IN_DIR, "dir").in).toBe(false);
    expect(file(s, `${MOVE_IN_DIR}/stage/.isomux/agents.json`).in).toBe(false);
    expect(file(s, `${MOVE_IN_DIR}/manifest.ndjson`).in).toBe(false);
    expect(file(s, `.isomux/${MOVE_IN_STATE_FILE}`).in).toBe(false);
    // Precision: a sibling with a longer name still moves.
    expect(file(s, `${MOVE_IN_DIR}-notes.txt`)).toEqual(IN);
  });
});

// Slice 2c-1, design round D8: the first boot after the swap wakes the turns
// the lock cut and starts the apps the lock stopped, from the old office's
// records. They must come with the copy.
describe("the records the first boot after a move-in reads", () => {
  it("moves turns-in-flight.json and the lock's apps records", () => {
    const s = scope();
    expect(file(s, ".isomux/turns-in-flight.json")).toEqual(IN);
    expect(file(s, `.isomux/${LOCKDOWN_APPS_FILE}`)).toEqual(IN);
    expect(file(s, `.isomux/${LOCKDOWN_WAITING_APPS_FILE}`)).toEqual(IN);
  });
});
