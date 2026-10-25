import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLiveProbe } from "./hook-live-probe.ts";
import { CODEX_HOOK_TRUST_HASH_PROVEN_VERSION } from "./safety-hook-install.ts";
import {
  fakeCodexGroupEnv,
  fakeCodexGroups,
  groupAlive,
  killGroup,
  waitFor,
  waitForFakeGroup,
  writeFakeCodexGroup,
} from "../../test-support/fake-codex-group.ts";

const enabled = process.env.ISOMUX_TEST_CODEX_HOOK_LIVE === "1";
const authHome = process.env.ISOMUX_TEST_CODEX_AUTH_HOME;
const missing = !enabled
  ? "ISOMUX_TEST_CODEX_HOOK_LIVE=1"
  : !authHome
    ? "ISOMUX_TEST_CODEX_AUTH_HOME=<authenticated CODEX_HOME>"
    : null;

describe("Codex hook live coverage (opt-in)", () => {
  it.skipIf(missing !== null)(
    `runs the measured App Server matrix${missing ? ` (missing ${missing})` : ""}`,
    async () => {
      const result = await runLiveProbe();
      const outputPath = process.env.ISOMUX_TEST_CODEX_HOOK_OUTPUT;
      if (outputPath) {
        await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`);
      }
      // The App Server the probe measured is the version the trust pin names.
      expect(result.codexVersion).toBe(CODEX_HOOK_TRUST_HASH_PROVEN_VERSION);
      expect(result.validationErrors).toEqual([]);
    },
    30 * 60 * 1000,
  );

  it("removes scratch auth state when SIGTERM stops a hanging probe", async () => {
    const parent = mkdtempSync(join(tmpdir(), "isomux-hook-signal-test-"));
    const root = join(parent, "scratch-home");
    const probeModule = new URL("./hook-live-probe.ts", import.meta.url)
      .pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { runSignalCleanupFixture } from ${JSON.stringify(probeModule)}; await runSignalCleanupFixture(${JSON.stringify(root)});`,
      ],
      { env: process.env, stdout: "ignore", stderr: "pipe" },
    );
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(root, "ready")) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(join(root, "ready"))).toBe(true);
      child.kill("SIGTERM");
      await child.exited;
      expect(existsSync(root)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("stops a live App Server group before it removes its scratch home on SIGTERM", async () => {
    const parent = mkdtempSync(join(tmpdir(), "isomux-hook-signal-test-"));
    const root = join(parent, "scratch-home");
    const pidFile = join(parent, "group.pid");
    const probeModule = new URL("./hook-live-probe.ts", import.meta.url)
      .pathname;
    const codexBin = writeFakeCodexGroup(parent);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { runSignalCleanupFixture } from ${JSON.stringify(probeModule)}; await runSignalCleanupFixture(${JSON.stringify(root)}, { codexBin: ${JSON.stringify(codexBin)} });`,
      ],
      {
        // The fixture's client takes CODEX_HOME = root/codex-home.
        env: {
          ...process.env,
          ...fakeCodexGroupEnv(pidFile, join(root, "codex-home")),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let pgid: number | undefined;
    try {
      pgid = await waitForFakeGroup(pidFile, join(root, "codex-home"));
      expect(await waitFor(() => existsSync(join(root, "ready")), 5000)).toBe(
        true,
      );
      child.kill("SIGTERM");
      await child.exited;
      // A group still running rewrites the home within 50 ms.
      await Bun.sleep(300);
      expect(existsSync(root)).toBe(false);
      expect(groupAlive(pgid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      killGroup(pgid);
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("leaves no App Server running when the next reading starts one during the SIGTERM cleanup", async () => {
    const parent = mkdtempSync(join(tmpdir(), "isomux-hook-signal-test-"));
    const root = join(parent, "scratch-home");
    const pidFile = join(parent, "group.pid");
    const probeModule = new URL("./hook-live-probe.ts", import.meta.url)
      .pathname;
    const codexBin = writeFakeCodexGroup(parent);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { runSignalCleanupFixture } from ${JSON.stringify(probeModule)}; await runSignalCleanupFixture(${JSON.stringify(root)}, { codexBin: ${JSON.stringify(codexBin)}, restart: true });`,
      ],
      {
        // Each App Server writes into its own CODEX_HOME.
        env: { ...process.env, ...fakeCodexGroupEnv(pidFile) },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    try {
      await waitForFakeGroup(pidFile, join(root, "codex-home"));
      expect(await waitFor(() => existsSync(join(root, "ready")), 5000)).toBe(
        true,
      );
      child.kill("SIGTERM");
      await child.exited;
      await Bun.sleep(300);
      expect(fakeCodexGroups(pidFile).filter(groupAlive)).toEqual([]);
      expect(
        readdirSync(parent).filter((name) => name.startsWith("scratch-home")),
      ).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      for (const pgid of fakeCodexGroups(pidFile)) killGroup(pgid);
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);
});
