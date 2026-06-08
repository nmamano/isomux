import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexWrapperCommandForShell } from "./native-bin.ts";
import { removeStateDir } from "../../test-support/temp-state.ts";

// Regression net for the config-root codex split: once the backend's default
// CODEX_HOME moved to STATE_ROOT, the generated wrapper's command path and its
// embedded CODEX_HOME default must follow the active root too, or login writes
// auth to the wrong place / cards point at an absent wrapper.
describe("codex wrapper follows the active state root", () => {
  it("keeps the friendly ~/.isomux/bin/codex command at the default root", () => {
    // Only meaningful when no override is active (STATE_ROOT is import-scoped).
    if (process.env.ISOMUX_HOME) return;
    expect(codexWrapperCommandForShell()).toBe("~/.isomux/bin/codex");
  });

  it("targets the override root under ISOMUX_HOME (cards + wrapper CODEX_HOME)", async () => {
    // STATE_ROOT resolves once at import, so exercise the override in a child
    // process with ISOMUX_HOME preset (the model the 0.3 harness will use).
    const home = mkdtempSync(join(tmpdir(), "isomux-nb-override-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const nb = await import(process.env.__NB_PATH);
           console.log(JSON.stringify(nb.getCodexLoginCommands()));`,
        ],
        {
          env: {
            ...process.env,
            ISOMUX_HOME: home,
            __NB_PATH: join(import.meta.dir, "native-bin.ts"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = (await new Response(child.stdout).text()).trim();
      const exitCode = await child.exited;
      expect(exitCode).toBe(0);

      const wantBin = join(home, "bin", "codex");
      const commands = JSON.parse(out.split("\n").pop()!);
      // Finding 2: login cards point at the wrapper actually written, under the
      // override root — not a stale/absent ~/.isomux/bin/codex.
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain(wantBin);
      expect(commands[0]).toContain("login");
      expect(commands[1]).toContain("--device-auth");

      // Finding 1: the generated wrapper's CODEX_HOME default is the override
      // codex-home, not $HOME/.isomux/codex-home, and an explicit CODEX_HOME
      // still wins.
      const wrapper = readFileSync(wantBin, "utf8");
      expect(wrapper).toContain(join(home, "codex-home"));
      expect(wrapper).not.toContain("$HOME/.isomux/codex-home");
      expect(wrapper).toContain('[ -n "${CODEX_HOME}" ]');
    } finally {
      removeStateDir(home); // dogfood the cleanup guard
    }
  });
});
