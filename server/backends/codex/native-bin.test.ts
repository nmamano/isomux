import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { STATE_ROOT } from "../../config.ts";
import { getCodexLoginCommands } from "./native-bin.ts";

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
