import { describe, it, expect } from "bun:test";
import { commands, unsupportedMessage } from "./commands.ts";

describe("unsupportedMessage", () => {
  it("returns the Nil-dictated copy for /loop", () => {
    // Exact copy decided in task c4717359, reworded for the Schedules rename
    // by Nil's ruling of 2026-09-05 - /loop is deliberately not supported
    // natively; the message redirects to isomux's own recurring-work
    // primitives. Do not reword without boss sign-off.
    expect(unsupportedMessage("loop")).toBe(
      "not supported natively; see if the Schedules page or scheduled messages satisfy your use case",
    );
  });

  it("keeps the generic bundled-skill message for other unsupported bundled skills", () => {
    // /loop's custom message is loop-specific; a sibling bundled skill
    // without a `message` override still gets the type-aware default.
    expect(commands["lorem-ipsum"].message).toBeUndefined();
    expect(unsupportedMessage("lorem-ipsum")).toBe(
      "`/lorem-ipsum` (generate placeholder text) is a Claude Code bundled skill, but it's not supported in Isomux. You can override it by creating your own skill file.",
    );
  });

  it("still reports /loop as an overridable bundled skill", () => {
    // Pins the registry fields that resolution step 2 relies on (see
    // command-handlers.ts handleSlashCommand): while overridable stays true,
    // a user skill named `loop` can still shadow this entry. Registry-level
    // guard only - does not exercise the resolution flow end to end.
    expect(commands.loop.type).toBe("bundled-skill");
    expect(commands.loop.supported).toBe(false);
    expect(commands.loop.overridable).toBe(true);
  });
});
