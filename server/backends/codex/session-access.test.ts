// Task d32356f2: the Codex app-server that reads or forks a stored thread must
// run with the agent's cwd and environment, so it opens the CODEX_HOME that
// holds the thread (a personal or managed CODEX_HOME, not the office one).
// Real code and the bundled Codex; the thread id is made up, so both calls
// fail after the start - what matters is where the app-server ran.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  localAgentHost,
  setAgentHost,
  type SpawnChildOptions,
} from "../../agent-host.ts";
import { ISOMUX_CODEX_HOME } from "./native-bin.ts";
import { codexBackend } from "./adapter.ts";
import { prepareCodexSafetyHookArtifact } from "./safety-hook-install.ts";

const THREAD = "019a0000-0000-7000-8000-000000000000";

// Build the hook and measure its trust hash first: the measurement starts a
// codex of its own.
await prepareCodexSafetyHookArtifact();

afterEach(() => setAgentHost(localAgentHost));

describe("Codex session access", () => {
  for (const call of ["getSessionMessages", "forkSessionBeforeMessage"])
    it(`${call} starts the app-server in the agent's cwd and CODEX_HOME`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-access-")));
      const userHome = join(root, "user-codex-home");
      const cwd = join(root, "work");
      mkdirSync(userHome);
      mkdirSync(cwd);
      const spawns: SpawnChildOptions[] = [];
      setAgentHost({
        ...localAgentHost,
        spawnChild: (argv, options = {}) => {
          spawns.push(options);
          return localAgentHost.spawnChild(argv, options);
        },
      });
      const access = {
        cwd,
        env: { ...process.env, CODEX_HOME: userHome },
        modelFamily: "gpt-5",
        permissionMode: "default",
      };
      const run =
        call === "getSessionMessages"
          ? codexBackend.getSessionMessages(THREAD, cwd, access)
          : codexBackend.forkSessionBeforeMessage(THREAD, null, access);
      await run.catch(() => {});

      expect(spawns.map((s) => [s.cwd, s.env?.CODEX_HOME])).toEqual([
        [cwd, userHome],
      ]);
      // The safety preflight ran against the same CODEX_HOME.
      expect(existsSync(join(userHome, "hooks.json"))).toBe(true);
      expect(ISOMUX_CODEX_HOME).not.toBe(userHome);
    }, 30_000);
});
