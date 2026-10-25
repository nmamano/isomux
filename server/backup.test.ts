import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
} from "./backup.ts";
import { STATE_ROOT } from "./config.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-backup-test-"));
  roots.push(root);
  const state = path.join(root, ".isomux");
  const backupDir = path.join(root, "backups");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "state.txt"), "state");
  return { root, state, backupDir };
}

interface Step {
  exitCode: number;
  stderr?: string;
  // Defaults to a listing that starts with the fixture's state root.
  stdout?: string;
  writeArchive?: boolean;
  // The archive's mtime, so a test can order archives without sleeping
  // through the filesystem's timestamp granularity.
  archiveMtimeMs?: number;
}

function deps(
  steps: Step[],
  availableBytes = 10_000,
  flavor: "gnu" | "bsd" = "gnu",
) {
  const calls: string[][] = [];
  const partialModesBeforeWrite: number[] = [];
  return {
    calls,
    partialModesBeforeWrite,
    impl: {
      now: () => Date.UTC(2026, 7, 13, 12),
      availableBytes: () => availableBytes,
      tarFlavor: async () => flavor,
      spawn(argv: string[]) {
        calls.push(argv);
        const step = steps.shift();
        if (!step) throw new Error(`unexpected spawn: ${argv.join(" ")}`);
        if (step.writeArchive) {
          const dest = argv[argv.indexOf("-czf") + 1];
          partialModesBeforeWrite.push(fs.statSync(dest).mode & 0o777);
          fs.writeFileSync(dest, "complete archive bytes");
          if (step.archiveMtimeMs !== undefined) {
            const at = new Date(step.archiveMtimeMs);
            fs.utimesSync(dest, at, at);
          }
        }
        return {
          exited: Promise.resolve(step.exitCode),
          stdout: new Blob([step.stdout ?? ".isomux/\nstate.txt\n"]).stream(),
          stderr: new Blob([step.stderr ?? ""]).stream(),
        };
      },
    },
  };
}

function config(f: ReturnType<typeof fixture>) {
  return {
    backupDir: f.backupDir,
    stateRootParent: f.root,
    stateRootName: path.basename(f.state),
    retention: 7,
    firstBackupMinFreeBytes: 100,
    minHeadroomBytes: 10,
  };
}

function finals(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".tar.gz"))
    .sort();
}

const realDeps = {
  now: () => Date.UTC(2026, 7, 13, 12),
  availableBytes: () => 10_000_000,
  spawn: (argv: string[]) =>
    Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }),
};

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

function extract(
  f: ReturnType<typeof fixture>,
  file: string,
  name = "restored",
) {
  const restored = path.join(f.root, name);
  fs.mkdirSync(restored);
  const result = Bun.spawnSync([
    "tar",
    "-xzf",
    path.join(f.backupDir, file),
    "-C",
    restored,
  ]);
  expect(result.exitCode).toBe(0);
  return path.join(restored, path.basename(f.state));
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

describe("verified backup publication", () => {
  test("publishes only after tar creation and a full verification pass", async () => {
    const f = fixture();
    const d = deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]);
    const file = await runBackupOnceForTest(config(f), d.impl);

    expect(file).toBe("isomux-2026-08-13.tar.gz");
    expect(finals(f.backupDir)).toEqual([file]);
    expect(d.partialModesBeforeWrite).toEqual([0o600]);
    expect(fs.statSync(path.join(f.backupDir, file)).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(f.backupDir, `${file}.verified.json`))).toBe(
      true,
    );
    expect(d.calls.map((call) => call.slice(0, 2))).toEqual([
      ["tar", "-czf"],
      ["tar", "-tzf"],
    ]);
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
    ];
    for (const relativePath of excluded)
      write(f.state, relativePath, `EXCLUDED:${relativePath}\n`);
    for (const relativePath of kept)
      write(f.state, relativePath, `KEPT:${relativePath}\n`);
    write(f.state, "apps/units/hello.sh", "DERIVED_LAUNCHER\n");
    for (const relativePath of excluded)
      expect(fs.existsSync(path.join(f.state, relativePath))).toBe(true);

    const file = await runBackupOnceForTest(config(f), realDeps);
    expect(fs.statSync(path.join(f.backupDir, file)).mode & 0o777).toBe(0o600);
    const restored = extract(f, file);

    for (const relativePath of excluded)
      expect(fs.existsSync(path.join(restored, relativePath))).toBe(false);
    for (const relativePath of kept)
      expect(fs.readFileSync(path.join(restored, relativePath), "utf8")).toBe(
        `KEPT:${relativePath}\n`,
      );
    // Private state stays private after a restore.
    expect(
      fs.statSync(
        path.join(
          restored,
          "opencode/profiles/shared/data/opencode/opencode.db",
        ),
      ).mode & 0o777,
    ).toBe(0o600);
    expect(fs.existsSync(path.join(restored, "apps/units/hello.sh"))).toBe(
      false,
    );
  });

  test("no file in the archive holds a secret or variable value", async () => {
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

    const file = await runBackupOnceForTest(config(f), realDeps);
    const restored = extract(f, file);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(restored);
    expect(files.some((p) => p.endsWith("pager.json"))).toBe(true);
    for (const p of files)
      expect(fs.readFileSync(p).includes(Buffer.from(fake))).toBe(false);
  });

  test("scheduler startup removes a partial orphaned by a dead process", () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    const orphan = path.join(
      f.backupDir,
      ".isomux-backup-123-456-dead.partial",
    );
    const unrelated = path.join(f.backupDir, "operator-note.txt");
    const snapshot = path.join(f.backupDir, ".sqlite-snapshot-dead");
    fs.mkdirSync(snapshot);
    fs.writeFileSync(path.join(snapshot, "office.sqlite"), "private state");
    fs.writeFileSync(orphan, "truncated archive");
    fs.writeFileSync(unrelated, "keep me");

    prepareBackupDirectoryForTest(f.backupDir);

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep me");
  });

  test("tar failure removes the partial and leaves a prior verified backup", async () => {
    const f = fixture();
    await runBackupOnceForTest(
      config(f),
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    const before = fs.readdirSync(f.backupDir).sort();
    const d = deps([{ exitCode: 2, stderr: "No space", writeArchive: true }]);

    // tar's own error text reaches the error.
    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(/No space/);
    expect(fs.readdirSync(f.backupDir).sort()).toEqual(before);
    expect(fs.readdirSync(f.backupDir).some(isBackupPartialForTest)).toBe(
      false,
    );
  });

  test("verification failure never publishes the partial", async () => {
    const f = fixture();
    const d = deps([
      { exitCode: 0, writeArchive: true },
      { exitCode: 2, stderr: "unexpected end of file" },
    ]);
    // Only the verification step reports this text.
    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(
      /unexpected end of file/,
    );
    expect(finals(f.backupDir)).toEqual([]);
    expect(fs.readdirSync(f.backupDir).some(isBackupPartialForTest)).toBe(
      false,
    );
  });

  // The space a run needs: a floor on the first run, then the newest
  // verified archive's size plus headroom (here 22 bytes + 10). Below it
  // the run refuses before tar starts and keeps every verified backup.
  test.each([
    ["the first run needs the floor", false, 500],
    ["a later run needs the newest size plus headroom", true, 32],
  ])("%s", async (_name, priorBackup, required) => {
    const f = fixture();
    const cfg = { ...config(f), firstBackupMinFreeBytes: 500 };
    if (priorBackup)
      await runBackupOnceForTest(
        cfg,
        deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
      );
    else fs.mkdirSync(f.backupDir);
    const before = finals(f.backupDir);

    const short = deps([], required - 1);
    expect(runBackupOnceForTest(cfg, short.impl)).rejects.toThrow();
    expect(short.calls).toEqual([]);
    expect(finals(f.backupDir)).toEqual(before);

    const enough = deps(
      [{ exitCode: 0, writeArchive: true }, { exitCode: 0 }],
      required,
    );
    await runBackupOnceForTest(cfg, enough.impl);
    expect(finals(f.backupDir)).toHaveLength(before.length + 1);
  });

  test("same-day rerun uses a disambiguated final and keeps both", async () => {
    const f = fixture();
    await runBackupOnceForTest(
      config(f),
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    await runBackupOnceForTest(
      config(f),
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    expect(finals(f.backupDir)).toEqual([
      "isomux-2026-08-13-2.tar.gz",
      "isomux-2026-08-13.tar.gz",
    ]);
  });

  test("retention orders suffixed finals by mtime, not ASCII name", async () => {
    const f = fixture();
    const cfg = { ...config(f), retention: 1 };
    const older = Date.UTC(2026, 7, 13, 11);
    await runBackupOnceForTest(
      cfg,
      deps([
        { exitCode: 0, writeArchive: true, archiveMtimeMs: older },
        { exitCode: 0 },
      ]).impl,
    );
    await runBackupOnceForTest(
      cfg,
      deps([
        { exitCode: 0, writeArchive: true, archiveMtimeMs: older + 60_000 },
        { exitCode: 0 },
      ]).impl,
    );
    expect(finals(f.backupDir)).toEqual(["isomux-2026-08-13-2.tar.gz"]);
  });

  test("an invalid existing final is not a retention slot", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    fs.writeFileSync(
      path.join(f.backupDir, "isomux-2026-08-12.tar.gz"),
      "truncated",
    );
    const d = deps([
      { exitCode: 2, stderr: "invalid legacy archive" },
      { exitCode: 0, writeArchive: true },
      { exitCode: 0 },
    ]);
    await runBackupOnceForTest({ ...config(f), retention: 1 }, d.impl);
    expect(finals(f.backupDir)).toEqual([
      "isomux-2026-08-12.tar.gz",
      "isomux-2026-08-13.tar.gz",
    ]);
    expect(
      fs.existsSync(
        path.join(f.backupDir, "isomux-2026-08-12.tar.gz.verified.json"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(f.backupDir, "isomux-2026-08-12.tar.gz.invalid.json"),
      ),
    ).toBe(true);

    const retry = deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]);
    await runBackupOnceForTest({ ...config(f), retention: 1 }, retry.impl);
    // The known-bad unchanged legacy archive is not walked again. The two calls
    // are only create + verify for the new archive.
    expect(retry.calls).toHaveLength(2);
  });

  test("an archive that does not list the state root never verifies", async () => {
    const f = fixture();
    const d = deps([
      { exitCode: 0, writeArchive: true },
      { exitCode: 0, stdout: "" },
    ]);
    // The error names the root the listing should start with.
    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(
      /\.isomux\//,
    );
    expect(finals(f.backupDir)).toEqual([]);
  });

  test("bsdtar gets no GNU-only options, and any non-zero bsdtar exit fails", async () => {
    const f = fixture();
    const ok = deps(
      [{ exitCode: 0, writeArchive: true }, { exitCode: 0 }],
      10_000,
      "bsd",
    );
    await runBackupOnceForTest(config(f), ok.impl);
    expect(ok.calls[0]).not.toContain("--anchored");
    expect(ok.calls[0]).not.toContain("--wildcards");
    expect(ok.calls[0]).toContain("--exclude=.isomux/tls/cert.key");

    const failed = deps(
      [{ exitCode: 1, stderr: "Couldn't open", writeArchive: true }],
      10_000_000_000,
      "bsd",
    );
    expect(runBackupOnceForTest(config(f), failed.impl)).rejects.toThrow(
      /Couldn't open/,
    );
    expect(finals(f.backupDir)).toHaveLength(1);
  });

  test("a 0-byte archive with a marker is not a backup and gets replaced", async () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    const empty = path.join(f.backupDir, "isomux-2026-08-13.tar.gz");
    fs.writeFileSync(empty, "");
    const stat = fs.statSync(empty);
    fs.writeFileSync(
      `${empty}.verified.json`,
      `${JSON.stringify({ size: 0, mtimeMs: stat.mtimeMs })}\n`,
    );
    expect(
      backupStatusForTest(config(f), Date.UTC(2026, 7, 13, 12)).lastBackupFile,
    ).toBeNull();

    const file = await runBackupOnceForTest(config(f), realDeps);
    expect(file).toBe("isomux-2026-08-13-2.tar.gz");
    expect(fs.existsSync(`${empty}.invalid.json`)).toBe(true);
    expect(
      fs.readFileSync(path.join(extract(f, file), "state.txt"), "utf8"),
    ).toBe("state");
  });

  test("a state root named like a glob still omits its credentials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "isomux-backup-test-"));
    roots.push(root);
    const f = {
      root,
      state: path.join(root, "office[1]"),
      backupDir: path.join(root, "backups"),
    };
    write(f.state, "state.txt", "state");
    write(f.state, "tls/cert.key", "SECRET\n");
    write(
      f.state,
      "provider-homes/u-alice/claude/.credentials.json",
      "SECRET\n",
    );

    const file = await runBackupOnceForTest(config(f), realDeps);
    const restored = extract(f, file);

    expect(fs.readFileSync(path.join(restored, "state.txt"), "utf8")).toBe(
      "state",
    );
    expect(fs.existsSync(path.join(restored, "tls/cert.key"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(restored, "provider-homes/u-alice/claude/.credentials.json"),
      ),
    ).toBe(false);
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

test("archives a consistent SQLite snapshot without live WAL or SHM files", async () => {
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
    const file = await runBackupOnceForTest(config(f), realDeps);
    const restored = extract(f, file);
    expect(fs.existsSync(path.join(restored, "office.sqlite-wal"))).toBe(false);
    expect(fs.existsSync(path.join(restored, "office.sqlite-shm"))).toBe(false);
    expect(fs.existsSync(path.join(restored, ".office-snapshot"))).toBe(false);
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
    expect(
      fs
        .readdirSync(f.backupDir)
        .some((name) => name.startsWith(".sqlite-snapshot-")),
    ).toBe(false);
  } finally {
    db.close();
  }
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

  // Health is rebuilt from disk: the newest archive is healthy until two
  // hours past one interval, then stale.
  test.each([
    ["the default interval", {}, 26 * HOUR_MS],
    ["a six-hour interval", { intervalMs: 6 * HOUR_MS }, 8 * HOUR_MS],
  ])("the health threshold follows %s", async (_name, interval, staleAfter) => {
    const f = fixture();
    const cfg = { ...config(f), ...interval };
    await runBackupOnceForTest(
      cfg,
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    const writtenAt = fs.statSync(
      path.join(f.backupDir, "isomux-2026-08-13.tar.gz"),
    ).mtimeMs;
    const fresh = backupStatusForTest(cfg, writtenAt + 1);
    expect(fresh.lastBackupOk).toBe(true);
    expect(fresh.lastBackupFile).toBe("isomux-2026-08-13.tar.gz");
    expect(fresh.intervalHours).toBe(staleAfter / HOUR_MS - 2);
    expect(
      backupStatusForTest(cfg, writtenAt + staleAfter - 60_000).lastBackupOk,
    ).toBe(true);
    const stale = backupStatusForTest(cfg, writtenAt + staleAfter);
    expect(stale.lastBackupOk).toBe(false);
    expect(stale.lastBackupError).not.toBeNull();
  });

  test("a backup is due one interval after the last run STARTED", async () => {
    const f = fixture();
    expect(backupDueForTest(config(f), Date.UTC(2026, 7, 13, 12))).toBe(true);

    const startedAt = Date.UTC(2026, 7, 13, 12); // deps().now
    const finishedAt = startedAt + 30 * 60_000; // tar took 30 minutes
    await runBackupOnceForTest(
      config(f),
      deps([
        { exitCode: 0, writeArchive: true, archiveMtimeMs: finishedAt },
        { exitCode: 0 },
      ]).impl,
    );
    // Counted from the finish, the hourly check at start + 24 h would skip,
    // and "every 24 hours" would really be every 25.
    const day = 24 * HOUR_MS;
    expect(backupDueForTest(config(f), startedAt + day - 1)).toBe(false);
    expect(backupDueForTest(config(f), startedAt + day)).toBe(true);
    const sixHours = { ...config(f), intervalMs: 6 * HOUR_MS };
    expect(backupDueForTest(sixHours, startedAt + 6 * HOUR_MS - 1)).toBe(false);
    expect(backupDueForTest(sixHours, startedAt + 6 * HOUR_MS)).toBe(true);
  });

  test("a marker from before start times counts from the archive's mtime", async () => {
    const f = fixture();
    const finishedAt = Date.UTC(2026, 7, 13, 12, 30);
    const file = await runBackupOnceForTest(
      config(f),
      deps([
        { exitCode: 0, writeArchive: true, archiveMtimeMs: finishedAt },
        { exitCode: 0 },
      ]).impl,
    );
    const marker = path.join(f.backupDir, `${file}.verified.json`);
    const { size, mtimeMs } = JSON.parse(fs.readFileSync(marker, "utf8"));
    fs.writeFileSync(marker, `${JSON.stringify({ size, mtimeMs })}\n`);

    const day = 24 * 60 * 60 * 1000;
    expect(backupDueForTest(config(f), finishedAt + day - 1)).toBe(false);
    expect(backupDueForTest(config(f), finishedAt + day)).toBe(true);
  });

  test("the scheduler writes to the set folder, on the set interval, and keeps the set count", async () => {
    const f = fixture();
    // An older verified backup in the folder the settings will name.
    const old = await runBackupOnceForTest(config(f), realDeps);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * HOUR_MS);
    fs.utimesSync(path.join(f.backupDir, old), twoDaysAgo, twoDaysAgo);

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
    // Retention 1: the new archive displaced the older one.
    expect(finals(f.backupDir)).toEqual([status.lastBackupFile]);
    expect(fs.existsSync(defaultBackupDir(f.state))).toBe(false);
  }, 20_000);
});

// A folder from the settings can be shared: two offices on one box pointed at
// one mounted disk. Retention and status count only this office's archives,
// or one office's retention deletes the other's backups.
describe("a backup folder two offices share", () => {
  test("each office keeps its own copies and reports its own newest", async () => {
    const a = fixture();
    const b = fixture();
    const shared = path.join(a.root, "shared");
    const cfgA = { ...config(a), backupDir: shared, retention: 1 };
    const cfgB = { ...config(b), backupDir: shared, retention: 1 };
    const at = Date.UTC(2026, 7, 13, 11);
    const run = (cfg: typeof cfgA, mtime: number) =>
      runBackupOnceForTest(
        cfg,
        deps([
          { exitCode: 0, writeArchive: true, archiveMtimeMs: mtime },
          { exitCode: 0 },
        ]).impl,
      );

    await run(cfgA, at);
    const fromB = await run(cfgB, at + 60_000);
    const fromA = await run(cfgA, at + 120_000);

    // A's second run displaced A's first, not B's.
    expect(finals(shared)).toEqual([fromB, fromA].sort());
    expect(backupStatusForTest(cfgA, at + 180_000).lastBackupFile).toBe(fromA);
    expect(backupStatusForTest(cfgB, at + 180_000).lastBackupFile).toBe(fromB);
  });
});
