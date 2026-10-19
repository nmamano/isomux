// The "Sk" popover executes no-arg commands on click (autoRun) instead of
// copying `/name ` into the composer. autoRun is a property of the command
// (does a bare `/name` do something useful?), owned by the registry and
// surfaced on the slash_commands wire via autocompleteCommands(). This pins the
// classification and the wire shape so the UI's run-vs-insert decision stays a
// pure function of registry data.

import { describe, it, expect } from "bun:test";
import { commands, autocompleteCommands } from "../commands.ts";

// Commands whose bare `/name` invocation is complete/useful - a direct action
// (/clear, /context) or an interactive picker that takes no argument text
// (/model, /effort, /resume, /isomux-cronjob-system-prompt). /diff diffs the
// cwd with no arg.
const EXPECTED_AUTORUN = new Set([
  "clear",
  "context",
  "help",
  "login",
  "logout",
  "usage",
  "isomux-usage",
  "isomux-storage",
  "isomux-all-hands",
  "isomux-system-prompt",
  "isomux-cronjob-system-prompt",
  "resume",
  "model",
  "effort",
  "plan",
  "diff",
  "isomux-diff",
  "reload-plugins",
]);

// Commands that need (or primarily want) an argument, so they must stay
// copy-into-composer: a required path, or a name/id whose no-arg output is just
// a usage/listing en route to the real selection.
// The Claude Code built-ins take options a member types after the name.
const EXPECTED_COPY = new Set(["isomux-edit", "code-review", "simplify"]);

describe("command registry autoRun classification", () => {
  it("marks exactly the no-arg commands autoRun in the registry", () => {
    const actualAutoRun = new Set(
      Object.entries(commands)
        .filter(([, cfg]) => cfg.autoRun === true)
        .map(([name]) => name),
    );
    expect(actualAutoRun).toEqual(EXPECTED_AUTORUN);
  });

  it("leaves argument-taking commands copy-only (autoRun unset)", () => {
    for (const name of EXPECTED_COPY) {
      expect(commands[name]?.autoRun).toBeUndefined();
    }
  });

  it("carries autoRun on both diff names (alias propagation is explicit)", () => {
    expect(commands["diff"]?.autoRun).toBe(true);
    expect(commands["isomux-diff"]?.autoRun).toBe(true);
    // The alias points at the canonical, and both carry the flag independently.
    expect(commands["diff"]?.aliasFor).toBe("isomux-diff");
  });
});

describe("autocompleteCommands() wire shape", () => {
  const wire = autocompleteCommands("claude");

  it("emits autoRun: true only for the no-arg commands, and omits it otherwise", () => {
    for (const c of wire) {
      if (EXPECTED_AUTORUN.has(c.name)) {
        // Present and strictly true (the UI treats only a literal true as run).
        expect(c.autoRun).toBe(true);
      } else {
        // Absent entirely - never false - so mixed-version/replay data can't be
        // misread and skills (which never carry it) stay insert-only.
        expect("autoRun" in c).toBe(false);
      }
    }
  });

  it("only surfaces autocomplete commands", () => {
    for (const alias of ["reset", "new"]) {
      expect(commands[alias]?.aliasFor).toBe("clear");
      expect(commands[alias]?.handler).toBe("clear");
      expect(wire.some((command) => command.name === alias)).toBe(false);
    }
    for (const c of wire) {
      expect(commands[c.name]?.autocomplete).toBe(true);
    }
  });
});

describe("autocompleteCommands() per engine", () => {
  it("lists a command only for the engines that run it", () => {
    const restricted = Object.entries(commands).filter(
      ([, cfg]) => cfg.autocomplete && cfg.engines,
    );
    // Enabling condition: the registry has engine-restricted commands.
    expect(restricted.length).toBeGreaterThan(0);
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const names = autocompleteCommands(engine).map((c) => c.name);
      for (const [name, cfg] of restricted) {
        expect(names.includes(name)).toBe(cfg.engines!.includes(engine));
      }
      expect(names).toContain("clear");
    }
  });
});
