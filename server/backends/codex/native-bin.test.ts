import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../../config.ts";
import { getAgentHost } from "../../agent-host.ts";
import {
  ISOMUX_CODEX_HOME,
  ensureCodexWrapperScript,
  getCodexLoginCommands,
  withIsomuxCodexHome,
} from "./native-bin.ts";

// Regression net for the config-root codex split: once the backend's default
// CODEX_HOME moved to STATE_ROOT, the generated wrapper's command path and its
// embedded CODEX_HOME default must follow the active root too, or login writes
// auth to the wrong place / cards point at an absent wrapper. The test preload
// makes STATE_ROOT an override root; the default root keeps the friendly
// ~/.isomux/bin/codex command (server/split/roots.test.ts).
describe("codex wrapper follows the active state root", () => {
  it("targets the override root under ISOMUX_HOME (cards + wrapper CODEX_HOME)", () => {
    const commands = getCodexLoginCommands();
    const wantBin = join(STATE_ROOT, "bin", "codex");
    // Login cards point at the wrapper actually written, under the override
    // root - not a stale/absent ~/.isomux/bin/codex.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(wantBin);
    expect(commands[0]).toContain("login");
    expect(commands[0]).toContain("--device-auth");

    // The generated wrapper's CODEX_HOME default is the override codex-home,
    // not $HOME/.isomux/codex-home, and an explicit CODEX_HOME still wins.
    const wrapper = readFileSync(wantBin, "utf8");
    expect(wrapper).toContain(join(STATE_ROOT, "codex-home"));
    expect(wrapper).not.toContain("$HOME/.isomux/codex-home");
    expect(wrapper).toContain('[ -n "${CODEX_HOME}" ]');
  });
});

// The ensure helpers memoize per process. Something else (a test harness
// that wipes the state dir, or a member) can delete the file or dir after
// the first ensure; the next ensure must create it again, not trust the
// flag (task 20269c2c).
describe("ensure helpers re-create what was deleted after the first ensure", () => {
  it("writes the Codex wrapper again when the file is gone", () => {
    const wrapperPath = join(STATE_ROOT, "bin", "codex");
    ensureCodexWrapperScript();
    const written = readFileSync(wrapperPath, "utf8");

    rmSync(wrapperPath);
    expect(existsSync(wrapperPath)).toBe(false);

    ensureCodexWrapperScript();
    expect(existsSync(wrapperPath)).toBe(true);
    expect(readFileSync(wrapperPath, "utf8")).toBe(written);
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o700);
  });

  it("creates the default CODEX_HOME again when the dir is gone", () => {
    // Only a local host creates the dir in process (client.ts start()
    // does it on the runner host).
    expect(getAgentHost().kind).toBe("local");
    // An explicit empty env, so a CODEX_HOME in the host env cannot skip
    // the default branch.
    expect(withIsomuxCodexHome({}).CODEX_HOME).toBe(ISOMUX_CODEX_HOME);
    expect(existsSync(ISOMUX_CODEX_HOME)).toBe(true);

    rmSync(ISOMUX_CODEX_HOME, { recursive: true, force: true });
    expect(existsSync(ISOMUX_CODEX_HOME)).toBe(false);

    expect(withIsomuxCodexHome({}).CODEX_HOME).toBe(ISOMUX_CODEX_HOME);
    expect(existsSync(ISOMUX_CODEX_HOME)).toBe(true);
    expect(statSync(ISOMUX_CODEX_HOME).isDirectory()).toBe(true);
  });
});
