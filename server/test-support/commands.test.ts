// The "Sk" popover executes no-arg commands on click (autoRun) instead of
// copying `/name ` into the composer. autoRun is a property of the command
// (does a bare `/name` do something useful?), owned by the registry and
// surfaced on the slash_commands wire via autocompleteCommands(). This pins the
// classification and the wire shape so the UI's run-vs-insert decision stays a
// pure function of registry data.

import { describe, it, expect } from "bun:test";
import { commands, autocompleteCommands } from "../commands.ts";

// Commands whose bare `/name` invocation is complete/useful — a direct action
// (/clear, /context) or an interactive picker that takes no argument text
// (/model, /effort, /resume). /diff diffs the cwd with no arg.
const EXPECTED_AUTORUN = new Set([
  "clear",
  "context",
  "help",
  "login",
  "usage",
  "isomux-usage",
  "isomux-all-hands",
  "isomux-system-prompt",
  "resume",
  "model",
  "effort",
  "diff",
  "isomux-diff",
]);

// Commands that need (or primarily want) an argument, so they must stay
// copy-into-composer: a required path, or a name/id whose no-arg output is just
// a usage/listing en route to the real selection.
const EXPECTED_COPY = new Set(["isomux-edit", "isomux-cronjob-system-prompt"]);

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
  const wire = autocompleteCommands();

  it("emits autoRun: true only for the no-arg commands, and omits it otherwise", () => {
    for (const c of wire) {
      if (EXPECTED_AUTORUN.has(c.name)) {
        // Present and strictly true (the UI treats only a literal true as run).
        expect(c.autoRun).toBe(true);
      } else {
        // Absent entirely — never false — so mixed-version/replay data can't be
        // misread and skills (which never carry it) stay insert-only.
        expect("autoRun" in c).toBe(false);
      }
    }
  });

  it("only surfaces autocomplete commands", () => {
    for (const c of wire) {
      expect(commands[c.name]?.autocomplete).toBe(true);
    }
  });
});
