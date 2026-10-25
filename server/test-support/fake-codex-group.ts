// A fake Codex App Server process group for the live-test cleanup tests. The
// launcher (group leader) appends its pid to FAKE_PID_FILE.all, then forks a
// writer that rewrites FAKE_WRITE_DIR (default: CODEX_HOME) every 50 ms, as a
// running App Server rewrites its CODEX_HOME. On SIGTERM the launcher dies at once and the writer keeps writing for about 400 ms more,
// as a stopping App Server does. FAKE_TERM=ignore makes the whole group
// ignore SIGTERM, so only a SIGKILL stops it.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function writeFakeCodexGroup(dir: string): string {
  const script = join(dir, "fake-codex-group.sh");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      '[ "$FAKE_TERM" = ignore ] && trap "" TERM',
      'W="${FAKE_WRITE_DIR:-$CODEX_HOME}"',
      'echo "$$" >> "$FAKE_PID_FILE.all"',
      'echo "$$" > "$FAKE_PID_FILE.tmp" && mv "$FAKE_PID_FILE.tmp" "$FAKE_PID_FILE"',
      "(",
      '  if [ "$FAKE_TERM" != ignore ]; then',
      '    trap \'for i in $(seq 20); do mkdir -p "$W"; : > "$W/late"; sleep 0.02; done; exit 0\' TERM',
      "  fi",
      '  while :; do mkdir -p "$W"; : > "$W/heartbeat"; sleep 0.05; done',
      ") &",
      "wait",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

export function fakeCodexGroupEnv(
  pidFile: string,
  writeDir?: string,
  term: "default" | "ignore" = "default",
): Record<string, string> {
  return {
    FAKE_PID_FILE: pidFile,
    ...(writeDir ? { FAKE_WRITE_DIR: writeDir } : {}),
    FAKE_TERM: term,
  };
}

// Every group the fake started, in start order.
export function fakeCodexGroups(pidFile: string): number[] {
  if (!existsSync(`${pidFile}.all`)) return [];
  return readFileSync(`${pidFile}.all`, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

// True while any process of the group exists, zombies included.
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function killGroup(pgid: number | undefined): void {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {}
}

export async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

// The writer has started (its SIGTERM trap is set) once the first heartbeat
// exists; the pid file names the group.
export async function waitForFakeGroup(
  pidFile: string,
  writeDir: string,
): Promise<number> {
  const ready = await waitFor(
    () => existsSync(pidFile) && existsSync(join(writeDir, "heartbeat")),
    5000,
  );
  if (!ready) throw new Error("fake Codex group never started writing");
  return Number(readFileSync(pidFile, "utf8").trim());
}
