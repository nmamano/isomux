// What an office move copies (task 78733adf, slice 2a): the scope
// predicate the manifest walk and each batch path share. Pure over paths
// relative to the office user's home; the walk and batch tests
// (server/office-move-pull.test.ts) own what needs the disk (symlinks,
// SQLite side files).

import { describe, expect, it } from "bun:test";
import { BACKUP_EXCLUSIONS } from "./backup-exclusions.ts";
import {
  MOVE_STATE_FILE,
  MOVE_CANCELLED_FILE,
  MOVE_LOCK_MARKER,
} from "./office-move.ts";
import { MOVE_UNITS_FILE } from "./office-move-units.ts";
import {
  createMoveScope,
  moveScope,
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

  it("leaves out each backup exclusion as a sign-in unit named by its id", () => {
    const s = scope();
    let checked = 0;
    for (const entry of BACKUP_EXCLUSIONS) {
      // The move's own files are left out uncounted (the test above).
      if (entry.id === "office-move") continue;
      for (const pattern of entry.archivePatterns(".isomux")) {
        const p = sample(pattern);
        expect([p, file(s, p)]).toEqual([
          p,
          { in: false, why: "signin", unit: entry.id },
        ]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("matches a backup exclusion as tar does: rooted at the state root, and its * crosses folders", () => {
    const s = scope();
    // "*" matches "/" in a tar exclusion.
    expect(file(s, ".isomux/a/b/.codex/shell_snapshots/s.sh")).toMatchObject({
      why: "signin",
      unit: "codex-shell-snapshots",
    });
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

  it("picks up a new backup exclusion with no second list", () => {
    const list = BACKUP_EXCLUSIONS as unknown as {
      id: string;
      archivePatterns: (root: string) => string[];
    }[];
    list.push({
      id: "test-new-store",
      archivePatterns: (root) => [`${root}/new-store`, `${root}/new-store/*`],
    });
    try {
      const s = scope();
      expect(file(s, ".isomux/new-store/token.json")).toEqual({
        in: false,
        why: "signin",
        unit: "test-new-store",
      });
    } finally {
      list.pop();
    }
    expect(file(scope(), ".isomux/new-store/token.json")).toEqual(IN);
  });

  it("leaves out backend logins at any depth, ssh and gh keys, and the files bound to this office's origin, each as a sign-in unit", () => {
    const s = scope();
    const signin = (p: string) => {
      const v = file(s, p);
      expect([p, v.in, v.in ? null : v.why]).toEqual([p, false, "signin"]);
      return v.in ? "" : v.why === "signin" ? v.unit : "";
    };
    expect(signin(".claude/.credentials.json")).toBe("claude-login");
    expect(signin("work/agent-home/.claude/.credentials.json")).toBe(
      "claude-login",
    );
    expect(signin("work/agent-home/.codex/auth.json")).toBe("codex-login");
    const ssh = signin(".ssh/id_ed25519");
    expect(signin(".ssh")).toBe(ssh);
    const gh = signin(".config/gh/hosts.yml");
    expect(new Set([ssh, gh]).size).toBe(2);
    for (const name of [
      "sessions.json",
      "invites.json",
      "api-tokens.json",
      "browser-connections.json",
      "app-sessions.json",
      "web-push.json",
    ])
      expect(signin(`.isomux/${name}`)).not.toBe("");
    // Same names elsewhere are a member's own files.
    expect(file(s, "work/sessions.json")).toEqual(IN);
    expect(file(s, ".config/ghostty/config")).toEqual(IN);
  });
});
