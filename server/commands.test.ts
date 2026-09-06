import { describe, it, expect } from "bun:test";
import { commands, unsupportedMessage } from "./commands.ts";
import { english } from "./i18n.ts";
import { COMMAND_MESSAGE_KEYS } from "../shared/i18n/command-keys.ts";

// The copy assertions below are the signed-off ENGLISH, so they run on the
// English translator; the catalog test covers the other languages.
const t = english.t;

describe("unsupportedMessage", () => {
  it("returns the Nil-dictated copy for /loop", () => {
    // Exact copy decided in task c4717359, reworded for the Schedules rename
    // by Nil's ruling of 2026-09-05 - /loop is deliberately not supported
    // natively; the message redirects to isomux's own recurring-work
    // primitives. Do not reword without boss sign-off.
    expect(unsupportedMessage(t, "loop")).toBe(
      "not supported natively; see if the Schedules page or scheduled messages satisfy your use case",
    );
  });

  it("keeps the generic bundled-skill message for other unsupported bundled skills", () => {
    // /loop's custom message is loop-specific; a sibling bundled skill
    // without a `message` override still gets the type-aware default.
    // The custom-message SELECTION is registry metadata and now lives in the
    // key table; only the prose moved to the catalog.
    expect("lorem-ipsum" in COMMAND_MESSAGE_KEYS).toBe(false);
    expect("loop" in COMMAND_MESSAGE_KEYS).toBe(true);
    expect(unsupportedMessage(t, "lorem-ipsum")).toBe(
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

// A command name is whatever the user typed after the slash, so it reaches the
// key tables as an arbitrary string. Before S7 the registry lookup fell through
// to the generic refusal for these; the catalog tables must do the same rather
// than answer with something inherited from Object.prototype, which t() would
// try to interpolate as if it were a message.
describe("a command name that names an inherited property", () => {
  for (const name of ["constructor", "__proto__", "toString", "valueOf"]) {
    it(`refuses /${name} instead of throwing`, () => {
      expect(unsupportedMessage(t, name)).toBe(
        `\`/${name}\` is not available in Isomux.`,
      );
    });
  }
});
