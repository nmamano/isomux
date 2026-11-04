// The command of a sudo request (task 43a28eed): the card shows it whole, so
// a character that hides or reorders what runs is refused.

import { describe, expect, it } from "bun:test";

import { checkSudoCommand, SUDO_COMMAND_MAX } from "./sudo-command.ts";

describe("checkSudoCommand", () => {
  it("takes one shell line, any script, up to SUDO_COMMAND_MAX characters", () => {
    for (const command of [
      "apt-get install -y jq",
      "systemctl restart nginx && journalctl -u nginx -n 20",
      "echo sudo is a word here",
      "sudoedit /etc/hosts",
      "printf '%s' 'café 日本'",
      "x".repeat(SUDO_COMMAND_MAX),
    ])
      expect({ command, error: checkSudoCommand(command) }).toEqual({
        command,
        error: null,
      });
  });

  it("refuses a missing or empty command, and one too long", () => {
    for (const command of [undefined, null, 7, "", "   "])
      expect({ command, error: checkSudoCommand(command) }).toEqual({
        command,
        error: "missing",
      });
    expect(checkSudoCommand("x".repeat(SUDO_COMMAND_MAX + 1))).toBe("too_long");
  });

  it("refuses a leading sudo: the server adds it", () => {
    for (const command of ["sudo apt-get update", "  sudo ls", "sudo"])
      expect({ command, error: checkSudoCommand(command) }).toEqual({
        command,
        error: "leading_sudo",
      });
  });

  it("refuses every character that can hide what runs", () => {
    for (const [label, ch] of [
      ["newline", "\n"],
      ["carriage return", "\r"],
      ["tab", "\t"],
      ["NUL", "\0"],
      ["escape", "\u001b"],
      ["DEL", "\u007f"],
      ["C1 control", "\u0085"],
      ["right-to-left override", "\u202e"],
      ["right-to-left isolate", "\u2067"],
      ["zero-width space", "\u200b"],
      ["zero-width joiner", "\u200d"],
      ["byte order mark", "\ufeff"],
      ["line separator", "\u2028"],
      ["paragraph separator", "\u2029"],
      ["no-break space", "\u00a0"],
      ["ideographic space", "\u3000"],
      ["vertical tab", "\u000b"],
    ] as const)
      expect({ label, error: checkSudoCommand(`echo a${ch}b`) }).toEqual({
        label,
        error: "forbidden_character",
      });
  });
});
