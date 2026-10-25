// closeAndReap against a real process group: the live suites remove a scratch
// CODEX_HOME (with its auth.json copy) right after it resolves, so it must not
// resolve while any process of the App Server's group can still write there.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CODEX_KILL_GRACE_MS, JsonRpcLiteClient } from "./client.ts";
import { closeAndReap } from "./live-client-reap.ts";
import {
  fakeCodexGroupEnv,
  groupAlive,
  killGroup,
  waitForFakeGroup,
  writeFakeCodexGroup,
} from "../../test-support/fake-codex-group.ts";

const dirs: string[] = [];
const groups: number[] = [];

afterEach(() => {
  for (const pgid of groups.splice(0)) killGroup(pgid);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function startFakeGroup(term: "default" | "ignore") {
  const dir = mkdtempSync(join(tmpdir(), "isomux-live-reap-test-"));
  dirs.push(dir);
  const pidFile = join(dir, "group.pid");
  const writeDir = join(dir, "codex-home");
  const client = new JsonRpcLiteClient({
    cwd: dir,
    env: {
      ...process.env,
      CODEX_HOME: writeDir,
      ...fakeCodexGroupEnv(pidFile, writeDir, term),
    },
    codexBin: writeFakeCodexGroup(dir),
    args: [],
    skipSafetyPreflightForTestProbe: true,
  });
  await client.start();
  const pgid = await waitForFakeGroup(pidFile, writeDir);
  groups.push(pgid);
  expect(pgid).toBe(client.pid()!);
  expect(groupAlive(pgid)).toBe(true);
  return { client, pgid, writeDir };
}

describe("closeAndReap", () => {
  it("resolves only after the group's last writer exits, so a removed home stays removed", async () => {
    const { client, pgid, writeDir } = await startFakeGroup("default");

    expect(await closeAndReap(client)).toBe(true);

    // The launcher dies at SIGTERM; the writer goes on for ~400 ms.
    expect(groupAlive(pgid)).toBe(false);
    rmSync(writeDir, { recursive: true, force: true });
    await Bun.sleep(300);
    expect(existsSync(writeDir)).toBe(false);
  }, 10_000);

  it("SIGKILLs a group that ignores SIGTERM at its own deadline", async () => {
    const { client, pgid } = await startFakeGroup("ignore");

    const started = Date.now();
    expect(await closeAndReap(client, 300)).toBe(true);

    // Before the client's own escalation: closeAndReap's SIGKILL did it.
    expect(Date.now() - started).toBeLessThan(CODEX_KILL_GRACE_MS);
    expect(groupAlive(pgid)).toBe(false);
  }, 10_000);

  it("resolves true for a client that never started", async () => {
    const client = new JsonRpcLiteClient({
      codexBin: "/bin/true",
      skipSafetyPreflightForTestProbe: true,
    });
    expect(await closeAndReap(client)).toBe(true);
  });
});
