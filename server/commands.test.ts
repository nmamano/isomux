import { describe, it, expect } from "bun:test";
import { unsupportedMessage } from "./commands.ts";
import { english } from "./i18n.ts";
import { COMMAND_DESCRIPTION_KEYS } from "../shared/i18n/command-keys.ts";
import { renderLogText } from "../shared/i18n/log-message.ts";

// Which refusal each kind of unsupported command gets. The words are the
// catalog's (catalog.test.ts holds every language); this pins the selection.
// A command name is whatever the user typed after the slash, so names that
// Object.prototype carries must take the generic refusal: a plain table lookup
// would answer them with an inherited function, which t() cannot render.
describe("unsupportedMessage", () => {
  it.each([
    // /loop has its own refusal, which points at isomux's own recurring work.
    ["loop", "commands.loop.message", false],
    ["lorem-ipsum", "commands.unsupported.bundledSkill", true],
    ["branch", "commands.unsupported.hardcoded", true],
    ["constructor", "commands.unsupported.notAvailable", false],
    ["__proto__", "commands.unsupported.notAvailable", false],
    ["toString", "commands.unsupported.notAvailable", false],
    ["valueOf", "commands.unsupported.notAvailable", false],
  ] as const)("refuses /%s with %s", (name, key, describesCommand) => {
    const message = unsupportedMessage(name);
    expect(message.key).toBe(key);
    const text = renderLogText(english, message);
    expect(text).not.toContain(key);
    if (key !== "commands.loop.message") expect(text).toContain(`/${name}`);
    if (describesCommand) {
      const description = english.t(
        COMMAND_DESCRIPTION_KEYS[name as keyof typeof COMMAND_DESCRIPTION_KEYS],
      );
      expect(text).toContain(description.toLowerCase());
    }
  });
});
