import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  backupStatusForTest,
  isBackupPartialForTest,
  prepareBackupDirectoryForTest,
  runBackupOnceForTest,
} from "./backup.ts";

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
  writeArchive?: boolean;
}

function deps(steps: Step[], availableBytes = 10_000) {
  const calls: string[][] = [];
  const partialModesBeforeWrite: number[] = [];
  return {
    calls,
    partialModesBeforeWrite,
    impl: {
      now: () => Date.UTC(2026, 7, 13, 12),
      availableBytes: () => availableBytes,
      spawn(argv: string[]) {
        calls.push(argv);
        const step = steps.shift();
        if (!step) throw new Error(`unexpected spawn: ${argv.join(" ")}`);
        if (step.writeArchive) {
          const dest = argv[argv.indexOf("-czf") + 1];
          partialModesBeforeWrite.push(fs.statSync(dest).mode & 0o777);
          fs.writeFileSync(dest, "complete archive bytes");
        }
        return {
          exited: Promise.resolve(step.exitCode),
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

  test("round-trips a private OpenCode profile through a private archive", async () => {
    const f = fixture();
    const authPath = path.join(
      f.state,
      "opencode",
      "profiles",
      "shared",
      "data",
      "opencode",
      "auth.json",
    );
    fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(authPath, "PROFILE_AUTH_CANARY\n", { mode: 0o600 });
    const file = await runBackupOnceForTest(config(f), {
      now: () => Date.UTC(2026, 7, 13, 12),
      availableBytes: () => 10_000,
      spawn: (argv) => Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" }),
    });
    const archive = path.join(f.backupDir, file);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);

    const restored = path.join(f.root, "restored");
    fs.mkdirSync(restored);
    const extracted = Bun.spawnSync(["tar", "-xzf", archive, "-C", restored]);
    expect(extracted.exitCode).toBe(0);
    const restoredAuth = path.join(
      restored,
      path.basename(f.state),
      "opencode",
      "profiles",
      "shared",
      "data",
      "opencode",
      "auth.json",
    );
    expect(fs.readFileSync(restoredAuth, "utf8")).toBe("PROFILE_AUTH_CANARY\n");
    expect(fs.statSync(restoredAuth).mode & 0o777).toBe(0o600);
  });

  test("health is rebuilt from disk and a stale archive is not success", async () => {
    const f = fixture();
    await runBackupOnceForTest(
      config(f),
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    const writtenAt = fs.statSync(
      path.join(f.backupDir, "isomux-2026-08-13.tar.gz"),
    ).mtimeMs;
    const fresh = backupStatusForTest(config(f), writtenAt + 1);
    expect(fresh.lastBackupOk).toBe(true);
    expect(fresh.lastBackupFile).toBe("isomux-2026-08-13.tar.gz");

    const stillHealthy = backupStatusForTest(
      config(f),
      writtenAt + 24 * 60 * 60 * 1000 + 60_000,
    );
    expect(stillHealthy.lastBackupOk).toBe(true);

    const stale = backupStatusForTest(
      config(f),
      writtenAt + 26 * 60 * 60 * 1000,
    );
    expect(stale.lastBackupOk).toBe(false);
    expect(stale.lastBackupError).toMatch(/more than 26 hours old/);
  });

  test("scheduler startup removes a partial orphaned by a dead process", () => {
    const f = fixture();
    fs.mkdirSync(f.backupDir);
    const orphan = path.join(
      f.backupDir,
      ".isomux-backup-123-456-dead.partial",
    );
    const unrelated = path.join(f.backupDir, "operator-note.txt");
    fs.writeFileSync(orphan, "truncated archive");
    fs.writeFileSync(unrelated, "keep me");

    prepareBackupDirectoryForTest(f.backupDir);

    expect(fs.existsSync(orphan)).toBe(false);
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

    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(
      /tar exit 2.*No space/,
    );
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
    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(
      /archive verification exit 2.*unexpected end of file/,
    );
    expect(finals(f.backupDir)).toEqual([]);
    expect(fs.readdirSync(f.backupDir).some(isBackupPartialForTest)).toBe(
      false,
    );
  });

  test("low space refuses before tar and deletes no verified backup", async () => {
    const f = fixture();
    const d = deps([], 99);
    expect(runBackupOnceForTest(config(f), d.impl)).rejects.toThrow(
      /99 bytes available, 100 required/,
    );
    expect(d.calls).toEqual([]);
    expect(finals(f.backupDir)).toEqual([]);
  });

  test("first run has a minimum floor instead of refusing forever", async () => {
    const f = fixture();
    const d = deps([], 499);
    expect(
      runBackupOnceForTest(
        { ...config(f), firstBackupMinFreeBytes: 500 },
        d.impl,
      ),
    ).rejects.toThrow(/500 required/);
    expect(d.calls).toEqual([]);
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
    await runBackupOnceForTest(
      cfg,
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runBackupOnceForTest(
      cfg,
      deps([{ exitCode: 0, writeArchive: true }, { exitCode: 0 }]).impl,
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
});
