import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  backupDueForTest,
  backupStatusForTest,
  DEFAULT_BACKUP_SETTINGS,
  defaultBackupDir,
  dfAvailableBytes,
  getBackupStatus,
  isBackupPartialForTest,
  loadBackupSettings,
  prepareBackupDirectoryForTest,
  resolveBackupDir,
  runBackupOnceForTest,
  saveBackupSettings,
  setBackupMemberSources,
  setBackupPreTick,
  tickOnceForTest,
  type BackupDeps,
} from "./backup.ts";
import { STATE_ROOT } from "./config.ts";
import { measureStorage } from "./storage-usage.ts";

// Task 1426371a, part 2: each backup is a folder in the backup folder. A file
// that did not change since the previous copy is a hard link to that copy's
// file; every other file is copied. A restore copies one folder back
// (internal-docs/backup-restore.md), so these tests restore with `cp -a`.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    // A copy keeps read-only folders read-only.
    Bun.spawnSync(["chmod", "-R", "u+rwX", root]);
    fs.rmSync(root, { recursive: true });
  }
});

function fixture(stateName = ".isomux") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-backup-test-"));
  roots.push(root);
  const state = path.join(root, stateName);
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "state.txt"), "state");
  return { root, state, backupDir };
}
type Fixture = ReturnType<typeof fixture>;

const BASE = Date.UTC(2026, 7, 13, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

// A clock that moves one second per call, so a run's finish is after its
// start and each run finishes after the one before.
function clock(start = BASE) {
  let t = start - 1000;
  return () => (t += 1000);
}

function deps(extra: Partial<BackupDeps> = {}): BackupDeps {
  return { now: clock(), availableBytes: () => 1e12, ...extra };
}

function config(f: Fixture) {
  return {
    backupDir: f.backupDir,
    stateRootParent: f.root,
    stateRootName: path.basename(f.state),
    retention: 7,
    minHeadroomBytes: 10,
  };
}

// The backups in a folder, of both kinds: folder copies and tar.gz files.
function copies(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) =>
      /^isomux-\d{4}-\d{2}-\d{2}(-\d+)?(\.tar\.gz)?$/.test(name),
    )
    .sort();
}

function hasPartial(dir: string): boolean {
  return fs.readdirSync(dir).some(isBackupPartialForTest);
}

// The state root inside a copy.
function copyRoot(f: Fixture, name: string): string {
  return path.join(f.backupDir, name, path.basename(f.state));
}

function inCopy(f: Fixture, name: string, rel: string): string {
  return path.join(copyRoot(f, name), rel);
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function ino(file: string): number {
  return fs.lstatSync(file).ino;
}

function marker(f: Fixture, name: string) {
  return JSON.parse(read(path.join(f.backupDir, name, "backup.json"))) as {
    startedAt: number;
    finishedAt: number;
  };
}

// The runbook's restore: copy the state root out of one copy folder.
function extract(f: Fixture, name: string, as = "restored") {
  const restored = path.join(f.root, as);
  fs.mkdirSync(restored);
  const result = Bun.spawnSync(["cp", "-a", copyRoot(f, name), restored], {
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return path.join(restored, path.basename(f.state));
}

function write(
  root: string,
  relativePath: string,
  contents: string,
  mode = 0o600,
) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  return target;
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: test`), { code });
}

// The folder a written path is in, directly under the backup folder.
function topFolder(f: Fixture, file: string): string {
  return path.join(
    f.backupDir,
    path.relative(f.backupDir, file).split(path.sep)[0],
  );
}

// A tar.gz copy as an older release wrote it, with its marker.
function legacyArchive(
  f: Fixture,
  name: string,
  mtimeMs: number,
  marker: { startedAt?: number; office?: string } | null = {
    startedAt: mtimeMs - 60_000,
    office: f.state,
  },
): string {
  fs.mkdirSync(f.backupDir, { recursive: true });
  const file = path.join(f.backupDir, name);
  const made = Bun.spawnSync([
    "tar",
    "-czf",
    file,
    "-C",
    f.root,
    path.basename(f.state),
  ]);
  expect(made.exitCode).toBe(0);
  const at = new Date(mtimeMs);
  fs.utimesSync(file, at, at);
  if (marker) {
    const stat = fs.statSync(file);
    fs.writeFileSync(
      `${file}.verified.json`,
      `${JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, ...marker })}\n`,
    );
  }
  return file;
}

// The bytes the backup folder really takes: each inode once.
function uniqueBytes(dir: string): number {
  const seen = new Set<number>();
  let bytes = 0;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const st = fs.lstatSync(full);
      if (seen.has(st.ino)) continue;
      seen.add(st.ino);
      bytes += st.size;
    }
  };
  walk(dir);
  return bytes;
}

describe("default backup folder", () => {
  test("the standard and container state roots keep their folder", () => {
    expect(defaultBackupDir("/home/u/.isomux")).toBe("/home/u/isomux-backups");
    expect(defaultBackupDir("/var/data/home/.isomux")).toBe(
      "/var/data/home/isomux-backups",
    );
  });

  test("another state root gets a folder of its own", () => {
    const live = defaultBackupDir("/home/u/.isomux");
    for (const root of ["/home/u/.isomux-scratch", "/home/u/scratch"]) {
      expect(defaultBackupDir(root)).not.toBe(live);
      expect(path.dirname(defaultBackupDir(root))).toBe("/home/u");
    }
    expect(defaultBackupDir("/tmp/a/.isomux")).not.toBe(
      defaultBackupDir("/tmp/b/.isomux"),
    );
    expect(defaultBackupDir("/srv/office")).toBe("/srv/office-backups");
  });

  test("an office started with only ISOMUX_HOME backs up next to it", () => {
    const f = fixture();
    const env: Record<string, string | undefined> = {
      ...process.env,
      // A trailing slash, as a hand-typed ISOMUX_HOME may carry.
      ISOMUX_HOME: `${f.state}/`,
    };
    delete env.ISOMUX_BACKUP_DIR;
    const run = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { getBackupStatus } = await import(${JSON.stringify(path.join(import.meta.dir, "backup.ts"))}); console.log(getBackupStatus().backupDir);`,
      ],
      { env, stderr: "pipe" },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe(defaultBackupDir(f.state));
    expect(path.dirname(run.stdout.toString().trim())).toBe(f.root);
  });
});

describe("a folder copy", () => {
  test("is published whole, and only the owner can open it, also while it is written", async () => {
    const f = fixture();
    // A state root others may enter, and a umask that opens new folders to
    // the group: neither may reach the copy.
    fs.chmodSync(f.state, 0o755);
    write(f.state, "shared/notes.md", "notes\n", 0o644);
    const umask = process.umask(0o002);
    const seen: { partial: boolean; mode: number }[] = [];
    try {
      const name = await runBackupOnceForTest(
        config(f),
        deps({
          copyFile: async (src, dst) => {
            const top = topFolder(f, dst);
            seen.push({
              partial: isBackupPartialForTest(path.basename(top)),
              mode: fs.statSync(top).mode & 0o777,
            });
            await fs.promises.copyFile(src, dst);
          },
        }),
      );
      expect(name).toBe("isomux-2026-08-13");
      expect(copies(f.backupDir)).toEqual([name]);
      expect(hasPartial(f.backupDir)).toBe(false);
      // Each file was written into a partial folder that was already 0700.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => !s.partial || s.mode !== 0o700)).toEqual([]);
      expect(fs.statSync(path.join(f.backupDir, name)).mode & 0o777).toBe(
        0o700,
      );
      expect(read(inCopy(f, name, "shared/notes.md"))).toBe("notes\n");
      expect(read(inCopy(f, name, "state.txt"))).toBe("state");
    } finally {
      process.umask(umask);
    }
  });

  test("restores with cp -a to the same tree: contents, modes, links and times; sockets and FIFOs stay out", async () => {
    const f = fixture();
    const old = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
    const files: [string, string, number][] = [
      ["private.json", "{}\n", 0o600],
      ["shared/readable.txt", "read me\n", 0o640],
      ["bin/tool.sh", "#!/bin/sh\necho hi\n", 0o755],
      ["empty.txt", "", 0o600],
      ["deep/a/b/c/leaf.txt", "leaf\n", 0o600],
    ];
    for (const [rel, body, mode] of files) {
      fs.chmodSync(write(f.state, rel, body, mode), mode);
      fs.utimesSync(path.join(f.state, rel), old, old);
    }
    fs.mkdirSync(path.join(f.state, "empty-folder"));
    fs.symlinkSync("shared/readable.txt", path.join(f.state, "link"));
    fs.symlinkSync("../nowhere", path.join(f.state, "dangling"));
    fs.chmodSync(path.join(f.state, "deep/a"), 0o750);
    for (const dir of ["deep/a/b/c", "deep/a/b", "deep/a", "deep"])
      fs.utimesSync(path.join(f.state, dir), old, old);
    // A FIFO would block a copy that opens it.
    expect(Bun.spawnSync(["mkfifo", path.join(f.state, "pipe")]).exitCode).toBe(
      0,
    );
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(path.join(f.state, "agent.sock"), resolve),
    );
    let name: string;
    try {
      name = await runBackupOnceForTest(config(f), deps());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const restored = extract(f, name);

    for (const [rel, body, mode] of files) {
      const st = fs.lstatSync(path.join(restored, rel));
      expect([rel, read(path.join(restored, rel)), st.mode & 0o7777]).toEqual([
        rel,
        body,
        mode,
      ]);
      expect([rel, Math.abs(st.mtimeMs - old.getTime()) < 1]).toEqual([
        rel,
        true,
      ]);
    }
    expect(fs.statSync(path.join(restored, "empty-folder")).isDirectory()).toBe(
      true,
    );
    expect(fs.readlinkSync(path.join(restored, "link"))).toBe(
      "shared/readable.txt",
    );
    expect(fs.readlinkSync(path.join(restored, "dangling"))).toBe("../nowhere");
    const deep = fs.statSync(path.join(restored, "deep/a"));
    expect(deep.mode & 0o7777).toBe(0o750);
    expect(Math.abs(deep.mtimeMs - old.getTime()) < 1).toBe(true);
    expect(fs.existsSync(path.join(restored, "pipe"))).toBe(false);
    expect(fs.existsSync(path.join(restored, "agent.sock"))).toBe(false);
  });

  test("omits credential stores while preserving adjacent and customer state", async () => {
    const f = fixture();
    const excluded = [
      "apps/units/hello.env",
      "container-runtime/hello.token.json",
      "container-runtime/hello.token.tmp",
      "user-env/u-alice.env",
      "office-env/office.env",
      // The variables' usage notes (integrations A4) share the env dirs.
      "user-env/u-alice.notes.json",
      "office-env/office.notes.json",
      "office-env/.office.4242.0b1e5c1d-7d55-4d2a-9a43-1f2b3c4d5e6f.tmp",
      "secrets/office.json",
      "secrets/users/u-alice.json",
      "secrets/users/.secrets.4242.0b1e5c1d-7d55-4d2a-9a43-1f2b3c4d5e6f.tmp",
      "mcp-servers/office.json",
      "mcp-servers/users/u-alice.json",
      "mcp-servers/users/.mcp-servers.4242.0b1e5c1d-7d55-4d2a-9a43-1f2b3c4d5e6f.tmp",
      // A removed member's kept variables and connection shapes (task
      // 321e7b8e).
      "removed-members/u-alice/u-alice.env",
      "removed-members/u-alice/secrets.json",
      "removed-members/u-alice/mcp-servers.json",
      "opencode/profiles/shared/opencode.json",
      // The server record holds the OpenCode server password.
      "opencode/profiles/shared/server.lock",
      // The secret proxy's files (internal-docs/secrets-design.md, 2.3).
      "secrets/placeholder.key",
      "secrets/ca.pem",
      "secrets/ca-key.pem",
      "secrets/proxy.json",
      "secrets/ca-bundle.pem",
      "codex-home/auth.json",
      "codex-home/shell_snapshots/one.sh",
      "provider-homes/u-alice/claude/.credentials.json",
      "provider-homes/u-alice/codex/auth.json",
      "provider-homes/u-alice/codex/shell_snapshots/two.sh",
      // "*" in a credential glob matches "/" too: a sign-in at any depth.
      "agent-homes/a1/deep/er/.credentials.json",
      "agent-homes/a1/project/.codex/auth.json",
      ".local/share/opencode/auth.json",
      ".local/share/opencode/mcp-auth.json",
      "opencode/profiles/shared/data/opencode/auth.json",
      "opencode/profiles/shared/data/opencode/mcp-auth.json",
      "browser-profiles/u-alice/storage-state.json",
      "browser-profiles/u-alice/storage-state.json.corrupt-1789000000000",
      "tls/cert.key",
      "webhooks/secrets.json",
      "webhooks/secrets.json.tmp",
      "pager-settings.json",
      "pager-settings.json.tmp",
      "pager-settings.json.corrupt-1789000000000",
      "web-push.json",
      "web-push.json.tmp",
      "web-push.json.corrupt-1789000000000",
      // A member's WhatsApp session (full access to their WhatsApp) and the
      // downloaded bridge package (task d03a61d8). A restore means a relink.
      "whatsapp/u-alice/auth/creds.json",
      "whatsapp/u-alice/link.json",
      "whatsapp/runtime/.lock-sha256",
      "whatsapp/runtime/node_modules/baileys/package.json",
      // A member's Discord bot tokens, routes and cursors (task 7fd44c30). A
      // restore means each member connects their bot again.
      "discord/u-alice/bots.json",
      "discord/u-alice/routes.json",
      "discord/u-alice/cursors.json",
      // The units an office move stopped: a transient unit's environment
      // can hold a secret. Slice 5c-1: the members' units too.
      "move-units.json",
      "move-member-units.json",
      "move-member-units.json.tmp",
    ];
    const kept = [
      "pager.json",
      "pager-resolved.jsonl",
      "apps/apps.json",
      "apps/app-tokens.json",
      "container-runtime/hello.exit.json",
      "container-runtime/hello.log",
      "apps/data/hello/state.json",
      "apps/data/hello/user-env/keep.txt",
      "apps/data/hello/whatsapp/link.json",
      "api-tokens.json",
      "codex-home/sessions/thread.jsonl",
      "codex-home/memories/memory.md",
      "provider-homes/u-alice/claude/.claude.json",
      "provider-homes/u-alice/codex/state.db",
      // The OpenCode databases hold credentials, and agents may not read
      // them, but they also hold every OpenCode session (task 75904a56).
      "opencode/profiles/shared/data/opencode/opencode.db",
      "opencode/profiles/shared/data/opencode/opencode.db-wal",
      "opencode/profiles/shared/data/opencode/opencode-v2.db",
      "opencode/profiles/shared/data/opencode/opencode-v2.db-wal",
      "tls/cert.crt",
      "nil-codex-noauth.env",
      "webhooks/webhooks.json",
      "webhooks/wh_0123456789abcdef/deliveries.json",
      // A pre-SQLite office's board: today's boot imports it after a restore.
      "tasks.json",
      // Beside an excluded name, not under it.
      "user-env.md",
      "secrets-notes/readme.txt",
    ];
    for (const relativePath of excluded)
      write(f.state, relativePath, `EXCLUDED:${relativePath}\n`);
    for (const relativePath of kept)
      write(f.state, relativePath, `KEPT:${relativePath}\n`);
    write(f.state, "apps/units/hello.sh", "DERIVED_LAUNCHER\n");
    for (const relativePath of excluded)
      expect(fs.existsSync(path.join(f.state, relativePath))).toBe(true);

    const name = await runBackupOnceForTest(config(f), deps());
    const restored = extract(f, name);

    expect(
      excluded.filter((p) => fs.existsSync(path.join(restored, p))),
    ).toEqual([]);
    // A left-out folder is not entered: not even the folder is in the copy.
    for (const folder of ["apps/units", "secrets", "whatsapp", "user-env"])
      expect([folder, fs.existsSync(path.join(restored, folder))]).toEqual([
        folder,
        false,
      ]);
    for (const relativePath of kept)
      expect([relativePath, read(path.join(restored, relativePath))]).toEqual([
        relativePath,
        `KEPT:${relativePath}\n`,
      ]);
    // Private state stays private after a restore.
    expect(
      fs.statSync(
        path.join(
          restored,
          "opencode/profiles/shared/data/opencode/opencode.db",
        ),
      ).mode & 0o777,
    ).toBe(0o600);
  });

  // Slice 5c-2 (task 78733adf, E5): a moved-in member's home waits in the
  // state until the enable command places it. The copy holds what her
  // member backup holds (her agent space, less its own locations and her
  // sign-ins), and nothing else of her home.
  test("keeps only the agent space of a moved-in member's home, as her member backup does", async () => {
    const f = fixture();
    const home = "move-members/u-mia/home";
    const excluded = [
      `${home}/.bashrc`,
      `${home}/.ssh/id_ed25519`,
      `${home}/projects/app/src/main.ts`,
      `${home}/.claude/.credentials.json`,
      // Her agent space's own locations and sign-ins (memberSpaceExcluded).
      `${home}/.isomux-agent/apps/units/hello.sh`,
      `${home}/.isomux-agent/apps/secrets/hello.env`,
      `${home}/.isomux-agent/.move-in/x`,
      `${home}/.isomux-agent/skill-folders/a/SKILL.md`,
      `${home}/.isomux-agent/a1/.claude/.credentials.json`,
      `${home}/.isomux-agent/a1/.codex/auth.json`,
      // A name that only starts like her agent space.
      `${home}/.isomux-agent-old/notes.md`,
    ];
    const kept = [
      `${home}/.isomux-agent/a1/.claude/projects/p/s.jsonl`,
      `${home}/.isomux-agent/apps/notes.json`,
      `${home}/.isomux-agent/settings.json`,
    ];
    for (const relativePath of excluded)
      write(f.state, relativePath, `EXCLUDED:${relativePath}\n`);
    for (const relativePath of kept)
      write(f.state, relativePath, `KEPT:${relativePath}\n`);
    const name = await runBackupOnceForTest(config(f), deps());
    const restored = extract(f, name);
    expect(
      excluded.filter((p) => fs.existsSync(path.join(restored, p))),
    ).toEqual([]);
    for (const relativePath of kept)
      expect([relativePath, read(path.join(restored, relativePath))]).toEqual([
        relativePath,
        `KEPT:${relativePath}\n`,
      ]);
    // Her home's folder itself stays, so a restore keeps the move-in's shape.
    expect(fs.statSync(path.join(restored, home)).isDirectory()).toBe(true);
  });

  test("no file in the copy holds a secret or variable value", async () => {
    // Secrets read-path audit (internal-docs/secrets-design.md): a known fake
    // value in the store, a store temp file and an office-env temp file.
    const f = fixture();
    const fake = "fake-secret-value-backup-0000";
    const store = JSON.stringify({
      version: 1,
      secrets: [{ name: "GH_TOKEN", value: fake }],
    });
    write(f.state, "secrets/office.json", store);
    write(f.state, "secrets/users/u-alice.json", store);
    write(f.state, "secrets/users/.secrets.1.a.tmp", store);
    write(f.state, "office-env/.office.1.a.tmp", `GH_TOKEN='${fake}'\n`);
    // A remote MCP server's credential (integrations A2): the header in the
    // OpenCode profile's config, and a token in a registered URL's path.
    write(
      f.state,
      "opencode/profiles/0123456789abcdef/opencode.json",
      JSON.stringify({
        mcp: {
          "isomux-docs": {
            type: "remote",
            url: "https://docs.example.com/mcp",
            headers: { Authorization: `Bearer ${fake}` },
          },
        },
      }),
    );
    write(
      f.state,
      "mcp-servers/users/u-alice.json",
      JSON.stringify({
        version: 1,
        servers: [
          { name: "docs", url: `https://docs.example.com/${fake}/mcp` },
        ],
      }),
    );
    write(f.state, "pager.json", "KEPT\n");

    const name = await runBackupOnceForTest(config(f), deps());

    // The whole copy folder, not only its state root: the manifest and the
    // marker must not carry a value either.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(path.join(f.backupDir, name));
    expect(files.some((p) => p.endsWith("pager.json"))).toBe(true);
    for (const p of files)
      expect([p, fs.readFileSync(p).includes(Buffer.from(fake))]).toEqual([
        p,
        false,
      ]);
    // The manifest is gzip: its text holds no secret paths' values either.
    const manifest = Bun.gunzipSync(
      fs.readFileSync(path.join(f.backupDir, name, "manifest.jsonl.gz")),
    );
    expect(Buffer.from(manifest).includes(Buffer.from(fake))).toBe(false);
  });

  test("a state root named like a glob still omits its credentials", async () => {
    const f = fixture("office[1]");
    write(f.state, "tls/cert.key", "SECRET\n");
    write(
      f.state,
      "provider-homes/u-alice/claude/.credentials.json",
      "SECRET\n",
    );

    const name = await runBackupOnceForTest(config(f), deps());
    const restored = extract(f, name);

    expect(read(path.join(restored, "state.txt"))).toBe("state");
    expect(fs.existsSync(path.join(restored, "tls/cert.key"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(restored, "provider-homes/u-alice/claude/.credentials.json"),
      ),
    ).toBe(false);
  });

  // Task 1426371a: the backup leaves out what Isomux or a backend makes
  // again (internal-docs/backup-restore.md). Each left-out folder is named
  // exactly, so a folder of the same name deeper in a home or in other state
  // stays.
  describe("what Isomux makes again", () => {
    const remade = (profile: string) => [
      `opencode/profiles/${profile}/cache/bin/bun/install/cache/pkg.tgz`,
      `opencode/profiles/${profile}/tmp/run-1/out.txt`,
      `opencode/profiles/${profile}/home/.npm/_cacache/index-v5/a`,
      `opencode/profiles/${profile}/config/opencode/node_modules/@opencode-ai/plugin/package.json`,
    ];

    test("is left out, and the folders of the same name elsewhere stay", async () => {
      const f = fixture();
      const excluded = [
        ...remade("p1"),
        ...remade("default"),
        "codex-home/cache/plugins/catalog.json",
        "codex-home/.tmp/plugin-sync/repo/README.md",
        "codex-home/tmp/git-1/HEAD",
        "provider-homes/u-alice/codex/cache/plugins/catalog.json",
        "provider-homes/u-alice/codex/.tmp/plugin-sync/repo/README.md",
        "provider-homes/u-alice/codex/tmp/git-1/HEAD",
        "bin/isomux-codex-safety-hook",
        "bin/.isomux-codex-safety-hook.golden",
      ];
      const kept = [
        // Each one matches a left-out path if "*" stands for a profile or a
        // home, or if the name is not anchored to its parent.
        "opencode/profiles/p1/home/project/cache/keep.txt",
        "opencode/profiles/p1/home/project/tmp/keep.txt",
        "opencode/profiles/p1/home/work/home/.npm/keep.txt",
        "opencode/profiles/p1/data/opencode/cache/keep.txt",
        "provider-homes/u-alice/claude/projects/codex/cache/keep.txt",
        "provider-homes/u-alice/claude/projects/codex/tmp/keep.txt",
        "apps/data/hello/cache/keep.txt",
        "apps/data/hello/codex-home/cache/keep.txt",
        // History and set-up beside the left-out folders.
        "opencode/profiles/p1/data/opencode/opencode.db",
        "opencode/profiles/p1/config/opencode/package.json",
        "opencode/profiles/p1/home/.npmrc",
        "codex-home/sessions/2026/11/14/rollout.jsonl",
        "codex-home/config.toml",
        "provider-homes/u-alice/codex/sessions/2026/11/14/rollout.jsonl",
        "provider-homes/u-alice/claude/projects/proj/session.jsonl",
        "bin/codex",
        "bin/opencode-login-runner.ts",
        "bin/isomux-codex-safety-hook.bak",
      ];
      for (const relativePath of excluded)
        write(f.state, relativePath, `REMADE:${relativePath}\n`);
      for (const relativePath of kept)
        write(f.state, relativePath, `KEPT:${relativePath}\n`);

      const name = await runBackupOnceForTest(config(f), deps());
      const restored = extract(f, name);

      expect(
        excluded.filter((p) => fs.existsSync(path.join(restored, p))),
      ).toEqual([]);
      // The left-out folder itself, not only the files in it.
      for (const folder of [
        "opencode/profiles/p1/cache",
        "opencode/profiles/p1/config/opencode/node_modules",
        "codex-home/.tmp",
        "provider-homes/u-alice/codex/tmp",
      ])
        expect([folder, fs.existsSync(path.join(restored, folder))]).toEqual([
          folder,
          false,
        ]);
      for (const relativePath of kept)
        expect([relativePath, read(path.join(restored, relativePath))]).toEqual(
          [relativePath, `KEPT:${relativePath}\n`],
        );
    });

    test("names with glob characters match only themselves", async () => {
      const f = fixture("office[1]");
      // Unescaped, "p*" would match "p1/home/project" and "u-*" would
      // match "u-alice/claude/projects".
      for (const relativePath of [
        ...remade("p*"),
        "provider-homes/u-*/codex/cache/catalog.json",
      ])
        write(f.state, relativePath, `REMADE:${relativePath}\n`);
      const kept = [
        "opencode/profiles/p1/home/project/cache/keep.txt",
        "provider-homes/u-alice/claude/projects/codex/cache/keep.txt",
      ];
      for (const relativePath of kept)
        write(f.state, relativePath, `KEPT:${relativePath}\n`);

      const name = await runBackupOnceForTest(config(f), deps());
      const restored = extract(f, name);

      for (const folder of [
        "opencode/profiles/p*/cache",
        "opencode/profiles/p*/tmp",
        "opencode/profiles/p*/home/.npm",
        "opencode/profiles/p*/config/opencode/node_modules",
        "provider-homes/u-*/codex/cache",
      ])
        expect([folder, fs.existsSync(path.join(restored, folder))]).toEqual([
          folder,
          false,
        ]);
      for (const relativePath of kept)
        expect([relativePath, read(path.join(restored, relativePath))]).toEqual(
          [relativePath, `KEPT:${relativePath}\n`],
        );
    });

    test("a profiles folder that cannot be listed still gets a backup", async () => {
      const f = fixture();
      // A file where the folder should be: listing it fails (ENOTDIR).
      write(f.state, "opencode/profiles", "not a folder\n");

      const name = await runBackupOnceForTest(config(f), deps());
      const restored = extract(f, name);

      expect(read(path.join(restored, "opencode/profiles"))).toBe(
        "not a folder\n",
      );
      expect(read(path.join(restored, "state.txt"))).toBe("state");
    });
  });

  test("holds a consistent SQLite snapshot without live WAL or SHM files, copied again each run", async () => {
    const { openOfficeDatabase, createAuditStore } =
      await import("./audit-store.ts");
    const f = fixture();
    const db = openOfficeDatabase(path.join(f.state, "office.sqlite"));
    try {
      db.exec("PRAGMA wal_autocheckpoint=0");
      db.query("INSERT INTO tasks(id,record) VALUES (?,?)").run(
        "one",
        JSON.stringify({ id: "one", title: "task" }),
      );
      createAuditStore(db).append({
        actor: { kind: "member", id: "u", name: "Member" },
        operation: "tasks.create",
        targets: ["one"],
        fields: ["title"],
      });
      // Enabling: the live database has a WAL to leave out.
      expect(fs.existsSync(path.join(f.state, "office.sqlite-wal"))).toBe(true);
      const now = clock();
      const first = await runBackupOnceForTest(config(f), deps({ now }));
      const restored = extract(f, first);
      expect(fs.existsSync(path.join(restored, "office.sqlite-wal"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(restored, "office.sqlite-shm"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(restored, ".office-snapshot"))).toBe(
        false,
      );
      const copy = openOfficeDatabase(path.join(restored, "office.sqlite"));
      try {
        expect(copy.query("SELECT * FROM tasks").all()).toHaveLength(1);
        expect(copy.query("SELECT * FROM audit").all()).toHaveLength(1);
        expect(copy.query("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        copy.close();
      }
      // Only the copy folder is in the backup folder.
      expect(
        fs.readdirSync(f.backupDir).filter((n) => !n.startsWith("isomux-")),
      ).toEqual([]);

      // The snapshot is new each run, so it is never a link to the last one.
      const second = await runBackupOnceForTest(config(f), deps({ now }));
      expect(ino(inCopy(f, second, "office.sqlite"))).not.toBe(
        ino(inCopy(f, first, "office.sqlite")),
      );
      // Enabling: an unchanged file in the same run is a link.
      expect(ino(inCopy(f, second, "state.txt"))).toBe(
        ino(inCopy(f, first, "state.txt")),
      );
    } finally {
      db.close();
    }
  });
});

describe("a later copy", () => {
  test("links what did not change, copies what did, and an edit in the office never reaches a copy", async () => {
    const f = fixture();
    const at = new Date(Date.UTC(2026, 7, 1)); // whole seconds: utimes is exact
    write(f.state, "same.txt", "same");
    write(f.state, "grow.txt", "v1");
    write(f.state, "sameSize.txt", "AAAA");
    write(f.state, "gone.txt", "gone");
    fs.utimesSync(path.join(f.state, "sameSize.txt"), at, at);
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));

    fs.appendFileSync(path.join(f.state, "grow.txt"), "+v2");
    // Same size and the same mtime as before: only the ctime shows it.
    const sameSize = path.join(f.state, "sameSize.txt");
    const before = fs.lstatSync(sameSize, { bigint: true });
    fs.writeFileSync(sameSize, "BBBB");
    fs.utimesSync(sameSize, at, at);
    // Kernels before 6.13 stamp ctime at the clock tick, so a rewrite in the
    // tick of the first backup keeps it: touch again until the tick moves.
    let after = fs.lstatSync(sameSize, { bigint: true });
    for (let i = 0; i < 1000 && after.ctimeNs === before.ctimeNs; i++) {
      await Bun.sleep(1);
      fs.utimesSync(sameSize, at, at);
      after = fs.lstatSync(sameSize, { bigint: true });
    }
    expect([
      after.size,
      after.mtimeNs,
      after.ctimeNs === before.ctimeNs,
    ]).toEqual([before.size, before.mtimeNs, false]);
    fs.rmSync(path.join(f.state, "gone.txt"));
    write(f.state, "new.txt", "new");
    const b = await runBackupOnceForTest(config(f), deps({ now }));

    expect(b).not.toBe(a);
    expect(ino(inCopy(f, b, "same.txt"))).toBe(ino(inCopy(f, a, "same.txt")));
    expect(ino(inCopy(f, b, "grow.txt"))).not.toBe(
      ino(inCopy(f, a, "grow.txt")),
    );
    expect(read(inCopy(f, b, "grow.txt"))).toBe("v1+v2");
    expect(read(inCopy(f, a, "grow.txt"))).toBe("v1");
    expect(read(inCopy(f, b, "sameSize.txt"))).toBe("BBBB");
    expect(read(inCopy(f, a, "sameSize.txt"))).toBe("AAAA");
    expect(fs.existsSync(inCopy(f, b, "gone.txt"))).toBe(false);
    expect(read(inCopy(f, a, "gone.txt"))).toBe("gone");
    expect(read(inCopy(f, b, "new.txt"))).toBe("new");

    // No copy shares a file with the office: an edit in place there leaves
    // both copies as they were.
    fs.appendFileSync(path.join(f.state, "same.txt"), "EDIT");
    expect(read(inCopy(f, a, "same.txt"))).toBe("same");
    expect(read(inCopy(f, b, "same.txt"))).toBe("same");

    // The next run links from the newest copy: what changed before b and
    // not since is a link to b's file.
    const c = await runBackupOnceForTest(config(f), deps({ now }));
    expect(ino(inCopy(f, c, "grow.txt"))).toBe(ino(inCopy(f, b, "grow.txt")));
  });

  test("a file edited or removed inside the newest copy is copied again from the office", async () => {
    const f = fixture();
    const at = new Date(Date.UTC(2026, 7, 1));
    for (const [rel, body] of [
      ["edited.txt", "aaaa"],
      ["removed.txt", "bbbb"],
      ["kept.txt", "cccc"],
    ]) {
      write(f.state, rel, body);
      fs.utimesSync(path.join(f.state, rel), at, at);
    }
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    // Same size, so only its time tells it changed.
    fs.writeFileSync(inCopy(f, a, "edited.txt"), "XXXX");
    fs.rmSync(inCopy(f, a, "removed.txt"));

    const b = await runBackupOnceForTest(config(f), deps({ now }));

    expect(read(inCopy(f, b, "edited.txt"))).toBe("aaaa");
    expect(ino(inCopy(f, b, "edited.txt"))).not.toBe(
      ino(inCopy(f, a, "edited.txt")),
    );
    expect(read(inCopy(f, b, "removed.txt"))).toBe("bbbb");
    // Enabling: the untouched file is still a link.
    expect(ino(inCopy(f, b, "kept.txt"))).toBe(ino(inCopy(f, a, "kept.txt")));
  });

  test("with the newest copy's manifest unreadable, everything is copied", async () => {
    const f = fixture();
    write(f.state, "one.txt", "one");
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    fs.writeFileSync(
      path.join(f.backupDir, a, "manifest.jsonl.gz"),
      "not gzip",
    );

    const b = await runBackupOnceForTest(config(f), deps({ now }));

    for (const rel of ["one.txt", "state.txt"]) {
      expect(read(inCopy(f, b, rel))).toBe(read(inCopy(f, a, rel)));
      expect(ino(inCopy(f, b, rel))).not.toBe(ino(inCopy(f, a, rel)));
    }
  });

  test("a link refused with EPERM copies that file and every later one", async () => {
    const f = fixture();
    const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
    for (const n of names) write(f.state, n, `body ${n}`);
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    let links = 0;
    const b = await runBackupOnceForTest(
      config(f),
      deps({
        now,
        link: () => {
          links++;
          throw errno("EPERM");
        },
      }),
    );
    expect(links).toBe(1);
    for (const n of [...names, "state.txt"]) {
      expect([n, read(inCopy(f, b, n))]).toEqual([n, read(inCopy(f, a, n))]);
      expect([n, ino(inCopy(f, b, n)) === ino(inCopy(f, a, n))]).toEqual([
        n,
        false,
      ]);
    }
  });

  test("a link refused with EMLINK copies that file only", async () => {
    const f = fixture();
    for (const n of ["full.txt", "b.txt", "c.txt"]) write(f.state, n, n);
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    let refused = 0;
    const b = await runBackupOnceForTest(
      config(f),
      deps({
        now,
        link: (existing, newPath) => {
          if (path.basename(existing) === "full.txt") {
            refused++;
            throw errno("EMLINK");
          }
          fs.linkSync(existing, newPath);
        },
      }),
    );
    expect(refused).toBe(1);
    expect(read(inCopy(f, b, "full.txt"))).toBe("full.txt");
    expect(ino(inCopy(f, b, "full.txt"))).not.toBe(
      ino(inCopy(f, a, "full.txt")),
    );
    for (const n of ["b.txt", "c.txt", "state.txt"])
      expect([n, ino(inCopy(f, b, n)) === ino(inCopy(f, a, n))]).toEqual([
        n,
        true,
      ]);
  });

  test("a file that changes during its copy is copied again by the next run", async () => {
    const f = fixture();
    const log = write(f.state, "log.jsonl", "one\n");
    const now = clock();
    await runBackupOnceForTest(config(f), deps({ now }));
    fs.appendFileSync(log, "two\n");
    let appended = 0;
    const b = await runBackupOnceForTest(
      config(f),
      deps({
        now,
        copyFile: async (src, dst) => {
          await fs.promises.copyFile(src, dst);
          if (path.basename(src) === "log.jsonl") {
            fs.appendFileSync(log, "three\n");
            appended++;
          }
        },
      }),
    );
    expect(appended).toBe(1);
    expect(read(inCopy(f, b, "log.jsonl"))).toBe("one\ntwo\n");

    // Nothing changed since, but the copy in b is not what the office holds.
    const c = await runBackupOnceForTest(config(f), deps({ now }));
    expect(read(inCopy(f, c, "log.jsonl"))).toBe("one\ntwo\nthree\n");
    expect(ino(inCopy(f, c, "log.jsonl"))).not.toBe(
      ino(inCopy(f, b, "log.jsonl")),
    );
    expect(ino(inCopy(f, c, "state.txt"))).toBe(ino(inCopy(f, b, "state.txt")));
  });

  test("files that change or go between the plan and the write: the run publishes, the next run copies them", async () => {
    const f = fixture();
    const grow = write(f.state, "grow.txt", "1");
    const still = write(f.state, "still.txt", "s");
    const goes = write(f.state, "goes.txt", "g");
    const now = clock();
    await runBackupOnceForTest(config(f), deps({ now }));
    fs.appendFileSync(grow, "2");
    let planned = 0;
    const b = await runBackupOnceForTest(
      config(f),
      deps({
        now,
        afterPlan: () => {
          planned++;
          fs.appendFileSync(grow, "3"); // planned as a copy, now longer
          fs.appendFileSync(still, "S"); // planned as a link
          fs.rmSync(goes);
        },
      }),
    );
    expect(planned).toBe(1);
    expect(copies(f.backupDir)).toContain(b);
    expect(fs.existsSync(inCopy(f, b, "goes.txt"))).toBe(false);

    const c = await runBackupOnceForTest(config(f), deps({ now }));
    expect(read(inCopy(f, c, "grow.txt"))).toBe("123");
    expect(ino(inCopy(f, c, "grow.txt"))).not.toBe(
      ino(inCopy(f, b, "grow.txt")),
    );
    expect(read(inCopy(f, c, "still.txt"))).toBe("sS");
    expect(ino(inCopy(f, c, "still.txt"))).not.toBe(
      ino(inCopy(f, b, "still.txt")),
    );
  });

  test("a file the office cannot read fails the run and keeps the copies before it", async () => {
    const f = fixture();
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    const locked = write(f.state, "locked.bin", "x", 0o000);
    fs.chmodSync(locked, 0o000);
    try {
      // Enabling: this process cannot read it (not root).
      expect(() => fs.readFileSync(locked)).toThrow();
      await expect(
        runBackupOnceForTest(config(f), deps({ now })),
      ).rejects.toThrow(/locked\.bin/);
    } finally {
      fs.chmodSync(locked, 0o600);
    }
    expect(copies(f.backupDir)).toEqual([a]);
    expect(hasPartial(f.backupDir)).toBe(false);
  });
});

describe("free space", () => {
  test("a refusal writes nothing, and a later run asks only for what it copies", async () => {
    const f = fixture();
    write(f.state, "big.bin", "x".repeat(1_000_000));
    const small = write(f.state, "small.txt", "s");
    fs.mkdirSync(f.backupDir);
    let writes = 0;
    const counting = {
      copyFile: async (src: string, dst: string) => {
        writes++;
        await fs.promises.copyFile(src, dst);
      },
      link: (existing: string, newPath: string) => {
        writes++;
        fs.linkSync(existing, newPath);
      },
    };
    const now = clock();
    // The first run copies the big file: 900 kB is not enough.
    await expect(
      runBackupOnceForTest(
        config(f),
        deps({ now, availableBytes: () => 900_000, ...counting }),
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
    expect(fs.readdirSync(f.backupDir)).toEqual([]);

    const a = await runBackupOnceForTest(config(f), deps({ now }));
    fs.appendFileSync(small, "+");
    // The big file is a link now. The rule of older releases (the newest
    // backup's size plus a quarter) would refuse this run.
    const b = await runBackupOnceForTest(
      config(f),
      deps({ now, availableBytes: () => 900_000 }),
    );
    expect(copies(f.backupDir)).toEqual([a, b]);
  });

  test("space that runs out during the copy stops the run and removes its partial", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) write(f.state, `f${i}.bin`, "x".repeat(2000));
    let checks = 0;
    let copied = 0;
    await expect(
      runBackupOnceForTest(
        { ...config(f), minHeadroomBytes: 1000 },
        deps({
          // Enough at the start, then less than the headroom.
          availableBytes: () => (++checks === 1 ? 1e12 : 999),
          copyFile: async (src, dst) => {
            copied++;
            await fs.promises.copyFile(src, dst);
          },
        }),
      ),
    ).rejects.toThrow();
    // Checked again during the copy, and stopped before the end.
    expect(checks).toBeGreaterThan(1);
    expect(copied).toBeLessThan(11);
    expect(copies(f.backupDir)).toEqual([]);
    expect(hasPartial(f.backupDir)).toBe(false);
  });
});

describe("verification", () => {
  // The copy is checked against the manifest before the rename: an entry
  // missing, a file of another size, or an entry the manifest does not name.
  // A read-only folder in the copy must not keep the partial on disk.
  test.each([
    ["a missing file", (file: string) => fs.rmSync(file)],
    ["a file of another size", (file: string) => fs.truncateSync(file, 1)],
    [
      "an extra entry",
      (file: string) =>
        fs.writeFileSync(path.join(path.dirname(file), "extra.txt"), "x"),
    ],
  ])("%s is never published", async (_name, tamper) => {
    const f = fixture();
    for (const n of ["a.txt", "b.txt", "c.txt"]) write(f.state, n, `${n}!`);
    write(f.state, "ro/inside.txt", "ro");
    fs.chmodSync(path.join(f.state, "ro"), 0o555);
    let target: string | null = null;
    let tampered = 0;
    await expect(
      runBackupOnceForTest(
        config(f),
        deps({
          copyFile: async (src, dst) => {
            await fs.promises.copyFile(src, dst);
            if (dst.includes(`${path.sep}ro${path.sep}`)) return;
            if (target === null) target = dst;
            else if (tampered++ === 0) tamper(target);
          },
        }),
      ),
    ).rejects.toThrow();
    expect(tampered).toBeGreaterThan(0);
    expect(copies(f.backupDir)).toEqual([]);
    expect(hasPartial(f.backupDir)).toBe(false);
  });
});

describe("retention and names", () => {
  test("folder copies and older tar.gz copies count together, oldest first", async () => {
    const f = fixture();
    legacyArchive(f, "isomux-2026-08-10.tar.gz", BASE - 3 * DAY_MS);
    legacyArchive(f, "isomux-2026-08-11.tar.gz", BASE - 2 * DAY_MS);
    const cfg = { ...config(f), retention: 2 };
    const now = clock();
    const a = await runBackupOnceForTest(cfg, deps({ now }));
    expect(copies(f.backupDir)).toEqual(["isomux-2026-08-11.tar.gz", a]);
    expect(
      fs.existsSync(
        path.join(f.backupDir, "isomux-2026-08-10.tar.gz.verified.json"),
      ),
    ).toBe(false);
    const b = await runBackupOnceForTest(cfg, deps({ now }));
    expect(copies(f.backupDir)).toEqual([a, b].sort());
  });

  test("a same-day run gets a new name, also next to a tar.gz of that day", async () => {
    const f = fixture();
    legacyArchive(f, "isomux-2026-08-13.tar.gz", BASE - 60_000);
    const now = clock();
    const a = await runBackupOnceForTest(config(f), deps({ now }));
    const b = await runBackupOnceForTest(config(f), deps({ now }));
    expect([a, b]).toEqual(["isomux-2026-08-13-2", "isomux-2026-08-13-3"]);
  });

  test("retention orders same-day copies by when they finished, not by name", async () => {
    const f = fixture();
    const cfg = { ...config(f), retention: 1 };
    const now = clock();
    const names: string[] = [];
    for (let i = 0; i < 10; i++)
      names.push(await runBackupOnceForTest(cfg, deps({ now })));
    // "-10" sorts before "-9" by name.
    expect(names.at(-1)).toBe("isomux-2026-08-13-10");
    expect(copies(f.backupDir)).toEqual(["isomux-2026-08-13-10"]);
  });

  test("a copy with read-only folders is pruned, and so is a stale partial with one", async () => {
    const f = fixture();
    write(f.state, "go/pkg/mod/m@v1/go.mod", "module m\n", 0o444);
    for (const dir of ["go/pkg/mod/m@v1", "go/pkg/mod"])
      fs.chmodSync(path.join(f.state, dir), 0o555);
    const cfg = { ...config(f), retention: 1 };
    const now = clock();
    const a = await runBackupOnceForTest(cfg, deps({ now }));
    expect(fs.statSync(inCopy(f, a, "go/pkg/mod")).mode & 0o777).toBe(0o555);
    const b = await runBackupOnceForTest(cfg, deps({ now }));
    expect(copies(f.backupDir)).toEqual([b]);

    // A partial left by a process that stopped mid-run, and one in the old
    // form (a file).
    const stale = path.join(f.backupDir, ".isomux-backup-1-2-dead.partial");
    const roDir = path.join(stale, ".isomux/go/pkg/mod");
    write(roDir, "x.txt", "x");
    fs.chmodSync(roDir, 0o555);
    const oldForm = path.join(f.backupDir, ".isomux-backup-3-4-old.partial");
    fs.writeFileSync(oldForm, "truncated archive");
    const snapshot = path.join(f.backupDir, ".sqlite-snapshot-dead");
    write(snapshot, "office.sqlite", "private state");
    const unrelated = path.join(f.backupDir, "operator-note.txt");
    fs.writeFileSync(unrelated, "keep me");

    await prepareBackupDirectoryForTest(f.backupDir);

    expect(hasPartial(f.backupDir)).toBe(false);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(read(unrelated)).toBe("keep me");
    expect(copies(f.backupDir)).toEqual([b]);
  });

  test("a folder without a readable marker is not a backup: not counted, not pruned", async () => {
    const f = fixture();
    const stray = path.join(f.backupDir, "isomux-2026-08-01");
    write(stray, ".isomux/state.txt", "hand-made");
    const cfg = { ...config(f), retention: 1 };
    const now = clock();
    const a = await runBackupOnceForTest(cfg, deps({ now }));
    const b = await runBackupOnceForTest(cfg, deps({ now }));
    expect(a).not.toBe("isomux-2026-08-01");
    expect(copies(f.backupDir)).toEqual(["isomux-2026-08-01", b]);
    expect(backupStatusForTest(cfg, BASE + 60_000).lastBackupFile).toBe(b);
  });

  test("deleting any copy by hand leaves the others whole, and later runs stay right", async () => {
    const f = fixture();
    write(f.state, "keep.txt", "unchanged");
    const day = write(f.state, "day.txt", "");
    const now = clock();
    const made = new Map<string, string>();
    const run = async (n: number) => {
      fs.writeFileSync(day, `day ${n}`);
      // Same size each run: give each its own mtime, or a rewrite in the
      // kernel clock tick of the last backup reads as unchanged.
      const at = new Date(Date.UTC(2026, 7, n));
      fs.utimesSync(day, at, at);
      expect(fs.statSync(day).mtimeMs).toBe(at.getTime());
      const name = await runBackupOnceForTest(config(f), deps({ now }));
      made.set(name, `day ${n}`);
      return name;
    };
    const checkAll = () => {
      for (const name of copies(f.backupDir)) {
        expect([name, read(inCopy(f, name, "day.txt"))]).toEqual([
          name,
          made.get(name)!,
        ]);
        expect([name, read(inCopy(f, name, "keep.txt"))]).toEqual([
          name,
          "unchanged",
        ]);
      }
    };
    const removeByHand = (name: string) => {
      fs.rmSync(path.join(f.backupDir, name), { recursive: true });
      made.delete(name);
    };
    const c1 = await run(1);
    const c2 = await run(2);
    const c3 = await run(3);
    removeByHand(c2); // the middle one
    checkAll();
    const c4 = await run(4);
    removeByHand(c4); // the newest one
    const c5 = await run(5);
    // The next run links from the newest copy that is left.
    expect(ino(inCopy(f, c5, "keep.txt"))).toBe(ino(inCopy(f, c3, "keep.txt")));
    removeByHand(c1); // the oldest one
    checkAll();
    expect(copies(f.backupDir)).toEqual([c3, c5]);
  });

  test("the disk space shown for the backup folder counts each byte once, and never too few", async () => {
    const f = fixture();
    write(f.state, "big.bin", "x".repeat(200_000));
    fs.symlinkSync("big.bin", path.join(f.state, "big.link"));
    const day = write(f.state, "day.txt", "");
    const now = clock();
    const names: string[] = [];
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(day, `day ${i} `.repeat(1000));
      const at = new Date(Date.UTC(2026, 7, i)); // same size: a new mtime
      fs.utimesSync(day, at, at);
      names.push(await runBackupOnceForTest(config(f), deps({ now })));
    }
    const shown = () =>
      measureStorage({
        stateRoot: f.state,
        backupDir: f.backupDir,
        snapshotDir: null,
      }).categories.find((c) => c.id === "backups")!.bytes;
    const slack = 3 * 4096;

    const chain = uniqueBytes(f.backupDir);
    // Enabling: the three copies share the big file.
    expect(chain).toBeLessThan(2 * 200_000);
    expect(shown()).toBeGreaterThanOrEqual(chain);
    expect(shown()).toBeLessThan(chain + slack);

    // A middle copy deleted by hand: the newest no longer has the copy it
    // linked from, so it counts whole. Too many, never too few.
    fs.rmSync(path.join(f.backupDir, names[1]), { recursive: true });
    const gap = uniqueBytes(f.backupDir);
    expect(shown()).toBeGreaterThanOrEqual(gap);
    expect(shown()).toBeLessThan(gap + 200_000 + slack);

    // The oldest gone too: exact again. A tar.gz and other files count as
    // they are.
    fs.rmSync(path.join(f.backupDir, names[0]), { recursive: true });
    fs.writeFileSync(
      path.join(f.backupDir, "isomux-2026-08-01.tar.gz"),
      "t".repeat(300),
    );
    write(f.backupDir, "exports/office.zip", "e".repeat(50));
    const last = uniqueBytes(f.backupDir);
    expect(shown()).toBeGreaterThanOrEqual(last);
    expect(shown()).toBeLessThan(last + 4096);
  });

  test("the plan walk gives the event loop turns on a large tree", async () => {
    // Plan walks of a small and a large tree, each stopped at afterPlan: the
    // difference in turns is what the walk itself yields.
    const turnsDuringPlan = async (files: number) => {
      const f = fixture();
      for (let d = 0; d < files / 100; d++) {
        fs.mkdirSync(path.join(f.state, `d${d}`));
        for (let i = 0; i < 100; i++)
          fs.writeFileSync(path.join(f.state, `d${d}`, `f${i}`), "x");
      }
      let turns = 0;
      let alive = true;
      const spin = () => {
        if (!alive) return;
        turns++;
        setImmediate(spin);
      };
      setImmediate(spin);
      let atPlan = -1;
      try {
        await runBackupOnceForTest(
          config(f),
          deps({
            afterPlan: () => {
              atPlan = turns;
              throw new Error("stop after the plan");
            },
          }),
        );
      } catch {}
      // The probe still runs after the work.
      const seen = turns;
      await new Promise((resolve) => setImmediate(resolve));
      alive = false;
      expect(turns).toBeGreaterThan(seen);
      expect(atPlan).toBeGreaterThanOrEqual(0);
      return atPlan;
    };
    const small = await turnsDuringPlan(100);
    const large = await turnsDuringPlan(4000);
    expect(large - small).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("older tar.gz copies", () => {
  test("an unmarked archive that fails its check is not a retention slot, and is not checked again", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    fs.writeFileSync(
      path.join(f.backupDir, "isomux-2026-08-12.tar.gz"),
      "truncated",
    );
    const calls: string[][] = [];
    const spawn = (argv: string[]) => {
      calls.push(argv);
      return {
        exited: Promise.resolve(2),
        stdout: new Blob([""]).stream(),
        stderr: new Blob(["invalid legacy archive"]).stream(),
      };
    };
    const now = clock();
    const cfg = { ...config(f), retention: 1 };
    const a = await runBackupOnceForTest(cfg, deps({ now, spawn }));
    expect(calls.map((c) => c.slice(0, 2))).toEqual([["tar", "-tzf"]]);
    expect(copies(f.backupDir)).toEqual(["isomux-2026-08-12.tar.gz", a]);
    expect(
      fs.existsSync(
        path.join(f.backupDir, "isomux-2026-08-12.tar.gz.invalid.json"),
      ),
    ).toBe(true);

    calls.length = 0;
    const b = await runBackupOnceForTest(cfg, deps({ now, spawn }));
    expect(calls).toEqual([]);
    expect(copies(f.backupDir)).toEqual(["isomux-2026-08-12.tar.gz", b]);
  });

  test("an unmarked archive that does not list the state root never verifies", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    fs.writeFileSync(path.join(f.backupDir, "isomux-2026-08-12.tar.gz"), "x");
    const spawn = () => ({
      exited: Promise.resolve(0),
      stdout: new Blob(["other/\n"]).stream(),
      stderr: new Blob([""]).stream(),
    });
    await runBackupOnceForTest(config(f), deps({ spawn }));
    expect(
      fs.existsSync(
        path.join(f.backupDir, "isomux-2026-08-12.tar.gz.invalid.json"),
      ),
    ).toBe(true);
  });

  test("a real unmarked archive is checked with tar and then counts", async () => {
    const f = fixture();
    const file = legacyArchive(
      f,
      "isomux-2026-08-12.tar.gz",
      BASE - DAY_MS,
      null,
    );
    const a = await runBackupOnceForTest(
      { ...config(f), retention: 1 },
      deps(),
    );
    // Verified, it was the oldest of two and was pruned.
    expect(fs.existsSync(file)).toBe(false);
    expect(copies(f.backupDir)).toEqual([a]);
  });

  test("a 0-byte archive with a marker is not a backup", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    const empty = path.join(f.backupDir, "isomux-2026-08-13.tar.gz");
    fs.writeFileSync(empty, "");
    const stat = fs.statSync(empty);
    fs.writeFileSync(
      `${empty}.verified.json`,
      `${JSON.stringify({ size: 0, mtimeMs: stat.mtimeMs })}\n`,
    );
    expect(backupStatusForTest(config(f), BASE).lastBackupFile).toBeNull();

    const name = await runBackupOnceForTest(config(f), deps());
    expect(name).toBe("isomux-2026-08-13-2");
    expect(fs.existsSync(`${empty}.invalid.json`)).toBe(true);
    expect(read(inCopy(f, name, "state.txt"))).toBe("state");
  });

  test("df reads free space for the statfs fallback", () => {
    const available = dfAvailableBytes(os.tmpdir());
    const statfs = fs.statfsSync(os.tmpdir());
    const expected = Number(statfs.bavail) * Number(statfs.bsize);
    expect(available).toBeGreaterThan(0);
    if (expected > 0)
      expect(Math.abs(available - expected)).toBeLessThan(expected / 10 + 1e8);
  });
});

// Backup settings (task e9776386): how often, how many copies, which folder.
// Kept in office-config.json and read on every scheduler check, so a change
// needs no restart. ISOMUX_BACKUP_DIR wins over the folder setting: a scratch
// office relies on it to keep its retention away from real backups.
describe("backup settings", () => {
  let savedEnv: string | undefined;

  function resetSettings() {
    saveBackupSettings({ ...DEFAULT_BACKUP_SETTINGS }, { envDir: undefined });
  }

  beforeEach(() => {
    savedEnv = process.env.ISOMUX_BACKUP_DIR;
    delete process.env.ISOMUX_BACKUP_DIR;
    resetSettings();
  });
  afterEach(() => {
    resetSettings();
    if (savedEnv === undefined) delete process.env.ISOMUX_BACKUP_DIR;
    else process.env.ISOMUX_BACKUP_DIR = savedEnv;
  });

  test("the environment folder wins, then the setting, then the default", () => {
    expect(resolveBackupDir("/env/b", "/set/b", "/home/u/.isomux")).toEqual({
      dir: "/env/b",
      source: "env",
    });
    expect(resolveBackupDir(undefined, "/set/b", "/home/u/.isomux")).toEqual({
      dir: "/set/b",
      source: "setting",
    });
    // An empty variable is unset, as it always was.
    expect(resolveBackupDir("", null, "/home/u/.isomux")).toEqual({
      dir: "/home/u/isomux-backups",
      source: "default",
    });
  });

  test("a save round-trips, shows in the status, and names the folder it left", () => {
    const f = fixture();
    const first = saveBackupSettings({
      intervalHours: 6,
      retention: 3,
      dir: f.backupDir,
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.oldBackupsDir).toBe(defaultBackupDir(STATE_ROOT));
    expect(first.status).toMatchObject({
      intervalHours: 6,
      retention: 3,
      backupDir: f.backupDir,
      backupDirFromEnv: false,
    });
    expect(loadBackupSettings()).toEqual({
      intervalHours: 6,
      retention: 3,
      dir: f.backupDir,
    });
    expect(getBackupStatus()).toMatchObject({
      intervalHours: 6,
      retention: 3,
      backupDir: f.backupDir,
    });

    // An omitted field keeps its value, and the folder did not move.
    const second = saveBackupSettings({ retention: 5 });
    if (!second.ok) throw new Error(second.error);
    expect(second.oldBackupsDir).toBeNull();
    expect(loadBackupSettings()).toEqual({
      intervalHours: 6,
      retention: 5,
      dir: f.backupDir,
    });

    // null goes back to the default folder.
    const third = saveBackupSettings({ dir: null });
    if (!third.ok) throw new Error(third.error);
    expect(third.oldBackupsDir).toBe(f.backupDir);
    expect(getBackupStatus().backupDir).toBe(defaultBackupDir(STATE_ROOT));
  });

  test("refuses a bad value and then saves no field of the input", () => {
    const f = fixture();
    fs.symlinkSync(f.state, path.join(f.root, "state-link"));
    const readOnly = path.join(f.root, "read-only");
    fs.mkdirSync(readOnly, { mode: 0o500 });
    const bad: Record<string, unknown>[] = [
      { intervalHours: 0 },
      { intervalHours: 721 },
      { intervalHours: 1.5 },
      { intervalHours: "6" },
      { retention: 0 },
      { retention: 101 },
      { retention: null },
      { dir: "relative/backups" },
      { dir: "" },
      { dir: f.state },
      { dir: path.join(f.state, "backups") },
      { dir: path.join(f.root, "state-link", "backups") },
      { dir: readOnly },
      { dir: path.join(readOnly, "backups") },
      // One good field beside a bad one: the good one is not saved either.
      { intervalHours: 6, retention: 0 },
      { intervalHours: 6, dir: "relative/backups" },
    ];
    try {
      for (const input of bad) {
        const result = saveBackupSettings(input, {
          stateRoot: f.state,
          envDir: undefined,
        });
        expect({ input, ok: result.ok }).toEqual({ input, ok: false });
        expect(loadBackupSettings()).toEqual(DEFAULT_BACKUP_SETTINGS);
      }
    } finally {
      fs.chmodSync(readOnly, 0o700);
    }
    // The fixture itself is acceptable, so the refusals above are about the
    // values, not the fixture.
    const good = saveBackupSettings(
      { intervalHours: 6, dir: f.backupDir },
      { stateRoot: f.state, envDir: undefined },
    );
    expect(good.ok).toBe(true);
  });

  test("while ISOMUX_BACKUP_DIR is set the folder is fixed, the rest is not", () => {
    const f = fixture();
    const envDir = path.join(f.root, "env-backups");
    const moved = saveBackupSettings({ dir: f.backupDir }, { envDir });
    expect(moved.ok).toBe(false);
    expect(loadBackupSettings().dir).toBeNull();

    const interval = saveBackupSettings({ intervalHours: 12 }, { envDir });
    if (!interval.ok) throw new Error(interval.error);
    expect(interval.status).toMatchObject({
      intervalHours: 12,
      backupDir: envDir,
      backupDirFromEnv: true,
    });
  });
});

// How often (task e9776386): the interval drives both when the scheduler runs
// a backup and when the status calls the newest one stale.
describe("backup schedule", () => {
  const HOUR_MS = 60 * 60 * 1000;

  // Health is rebuilt from disk: the newest copy is healthy until two hours
  // past one interval after it finished, then stale.
  test.each([
    ["the default interval", {}, 26 * HOUR_MS],
    ["a six-hour interval", { intervalMs: 6 * HOUR_MS }, 8 * HOUR_MS],
  ])("the health threshold follows %s", async (_name, interval, staleAfter) => {
    const f = fixture();
    const cfg = { ...config(f), ...interval };
    const name = await runBackupOnceForTest(cfg, deps());
    const { finishedAt } = marker(f, name);
    const fresh = backupStatusForTest(cfg, finishedAt + 1);
    expect(fresh.lastBackupOk).toBe(true);
    expect(fresh.lastBackupFile).toBe(name);
    expect(fresh.lastBackupAt).toBe(finishedAt);
    expect(fresh.intervalHours).toBe(staleAfter / HOUR_MS - 2);
    expect(
      backupStatusForTest(cfg, finishedAt + staleAfter - 60_000).lastBackupOk,
    ).toBe(true);
    const stale = backupStatusForTest(cfg, finishedAt + staleAfter);
    expect(stale.lastBackupOk).toBe(false);
    expect(stale.lastBackupError).not.toBeNull();
  });

  test("a backup is due one interval after the last run STARTED", async () => {
    const f = fixture();
    expect(backupDueForTest(config(f), BASE)).toBe(true);

    const name = await runBackupOnceForTest(config(f), deps());
    const { startedAt, finishedAt } = marker(f, name);
    // Enabling: the run took time, so start and finish differ.
    expect(finishedAt).toBeGreaterThan(startedAt);
    // Counted from the finish, the hourly check at start + 24 h would skip,
    // and "every 24 hours" would really be every 25.
    expect(backupDueForTest(config(f), startedAt + DAY_MS - 1)).toBe(false);
    expect(backupDueForTest(config(f), startedAt + DAY_MS)).toBe(true);
    const sixHours = { ...config(f), intervalMs: 6 * HOUR_MS };
    expect(backupDueForTest(sixHours, startedAt + 6 * HOUR_MS - 1)).toBe(false);
    expect(backupDueForTest(sixHours, startedAt + 6 * HOUR_MS)).toBe(true);
  });

  test("a tar.gz marker from before start times counts from the archive's mtime", () => {
    const f = fixture();
    const finishedAt = Date.UTC(2026, 7, 13, 12, 30);
    legacyArchive(f, "isomux-2026-08-13.tar.gz", finishedAt, {});
    expect(backupDueForTest(config(f), finishedAt + DAY_MS - 1)).toBe(false);
    expect(backupDueForTest(config(f), finishedAt + DAY_MS)).toBe(true);
    expect(backupStatusForTest(config(f), finishedAt + 1).lastBackupAt).toBe(
      finishedAt,
    );
  });

  test("the scheduler writes to the set folder, on the set interval, and keeps the set count", async () => {
    const f = fixture();
    // An older verified copy in the folder the settings will name.
    const old = await runBackupOnceForTest(
      config(f),
      deps({ now: clock(Date.now() - 2 * DAY_MS) }),
    );

    const env: Record<string, string | undefined> = {
      ...process.env,
      ISOMUX_HOME: f.state,
    };
    delete env.ISOMUX_BACKUP_DIR;
    const script = `
      const b = await import(${JSON.stringify(path.join(import.meta.dir, "backup.ts"))});
      const saved = b.saveBackupSettings({ intervalHours: 1, retention: 1, dir: ${JSON.stringify(f.backupDir)} });
      if (!saved.ok) { console.error(saved.error); process.exit(2); }
      b.startBackupScheduler();
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const s = b.getBackupStatus();
        if (!s.running && s.lastBackupFile && s.lastBackupFile !== ${JSON.stringify(old)}) {
          console.log(JSON.stringify(s));
          process.exit(0);
        }
        await Bun.sleep(50);
      }
      console.error("no backup", JSON.stringify(b.getBackupStatus()));
      process.exit(3);
    `;
    const run = Bun.spawn([process.execPath, "-e", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
    const status = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(status.backupDir).toBe(f.backupDir);
    expect(status.lastBackupOk).toBe(true);
    // Retention 1: the new copy displaced the older one.
    expect(copies(f.backupDir)).toEqual([status.lastBackupFile]);
    expect(fs.existsSync(defaultBackupDir(f.state))).toBe(false);
  }, 20_000);
});

// A folder from the settings can be shared: two offices on one box pointed at
// one mounted disk. Retention and status count only this office's copies, or
// one office's retention deletes the other's backups.
describe("a backup folder two offices share", () => {
  test("each office keeps its own copies and reports its own newest", async () => {
    const a = fixture();
    const b = fixture();
    const shared = path.join(a.root, "shared");
    const cfgA = { ...config(a), backupDir: shared, retention: 1 };
    const cfgB = { ...config(b), backupDir: shared, retention: 1 };
    const now = clock();

    await runBackupOnceForTest(cfgA, deps({ now }));
    const fromB = await runBackupOnceForTest(cfgB, deps({ now }));
    const fromA = await runBackupOnceForTest(cfgA, deps({ now }));

    // A's second run displaced A's first, not B's.
    expect(copies(shared)).toEqual([fromB, fromA].sort());
    expect(backupStatusForTest(cfgA, BASE + 60_000).lastBackupFile).toBe(fromA);
    expect(backupStatusForTest(cfgB, BASE + 60_000).lastBackupFile).toBe(fromB);
  });
});

// The automatic log cleanup runs as the first step of each scheduler tick
// (task 3f8db20b): before the backup folder is prepared, so a folder problem
// does not stop it, and before the copy, so the copy holds the compressed
// transcripts. Its failure does not stop the backup.
describe("the step before each backup tick", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.ISOMUX_BACKUP_DIR;
    delete process.env.ISOMUX_BACKUP_DIR;
  });
  afterEach(() => {
    setBackupPreTick(null);
    setBackupMemberSources(null);
    saveBackupSettings({ ...DEFAULT_BACKUP_SETTINGS }, { envDir: undefined });
    if (savedEnv === undefined) delete process.env.ISOMUX_BACKUP_DIR;
    else process.env.ISOMUX_BACKUP_DIR = savedEnv;
  });

  test("runs before the folder is prepared and before the copy, and a throw does not stop the backup", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    // A leftover partial: preparing the folder removes it.
    const partial = path.join(f.backupDir, ".isomux-backup-left.partial");
    expect(isBackupPartialForTest(path.basename(partial))).toBe(true);
    write(partial, ".isomux/state.txt", "left");
    const saved = saveBackupSettings(
      { intervalHours: 24, retention: 1, dir: f.backupDir },
      { envDir: undefined },
    );
    expect(saved.ok).toBe(true);

    const seen: { partial: boolean; copies: number }[] = [];
    setBackupPreTick(async () => {
      seen.push({
        partial: fs.existsSync(partial),
        copies: copies(f.backupDir).length,
      });
      throw new Error("cleanup failed");
    });
    await tickOnceForTest();

    expect(seen).toEqual([{ partial: true, copies: 0 }]);
    expect(fs.existsSync(partial)).toBe(false);
    expect(copies(f.backupDir)).toHaveLength(1);
    const status = getBackupStatus();
    expect(status.lastBackupOk).toBe(true);
    expect(status.lastBackupError).toBeNull();
  }, 20_000);

  // Task 43aef77b: a run that did not copy a member's agent space is
  // logged as partial, as a warning that names the copy and the member.
  test("logs a run that did not copy a member's space as a warning naming the copy and the member", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    const saved = saveBackupSettings(
      { intervalHours: 24, retention: 1, dir: f.backupDir },
      { envDir: undefined },
    );
    expect(saved.ok).toBe(true);
    setBackupMemberSources({
      list: () => [
        {
          userId: "u-alice",
          osUser: { name: "alice", uid: 5001 },
          host: null,
        },
      ],
      name: (userId) => `Name of ${userId}`,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    // Read before the restore: bun's mockRestore empties mock.calls.
    let warned: string[] = [];
    try {
      await tickOnceForTest();
    } finally {
      warned = warn.mock.calls.map((c) => c.map(String).join(" "));
      warn.mockRestore();
      log.mockRestore();
    }
    const [copy] = copies(f.backupDir);
    // Enabling: the copy was published and it did not copy her space.
    expect([copy !== undefined, getBackupStatus().membersSkipped]).toEqual([
      true,
      ["Name of u-alice"],
    ]);
    const lines = warned.filter(
      (line) => line.includes(copy) && line.includes("u-alice"),
    );
    expect(lines).toHaveLength(1);
  }, 20_000);

  test("runs when the backup folder cannot be made", async () => {
    const f = fixture();
    const blocker = path.join(f.root, "a-file");
    fs.writeFileSync(blocker, "x");
    const dir = path.join(blocker, "backups");
    process.env.ISOMUX_BACKUP_DIR = dir;
    let calls = 0;
    setBackupPreTick(async () => {
      calls++;
    });
    await tickOnceForTest();
    expect(calls).toBe(1);
    // Enabling: the folder really could not be made.
    expect(fs.existsSync(dir)).toBe(false);
  });
});
