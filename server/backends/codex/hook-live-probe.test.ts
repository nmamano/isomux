import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runLiveProbe } from "./hook-live-probe.ts";

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
      expect(result.codexVersion).toBe("0.144.6");
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
      { stdout: "ignore", stderr: "pipe" },
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
});
