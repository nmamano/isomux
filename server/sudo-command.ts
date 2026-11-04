// The command of a sudo request (task 43a28eed): one shell line, as the
// member reads it on the ask card. A character that can hide what runs (a
// line break, a tab, a bidi override, a zero-width mark) is refused, so the
// card shows exactly the command that runs.

export const SUDO_COMMAND_MAX = 2000;

export type SudoCommandError =
  | "missing"
  | "too_long"
  | "leading_sudo"
  | "forbidden_character";

// Control and format characters, the line and paragraph separators, and every
// space but U+0020.
const FORBIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]|(?! )\s/u;

export function checkSudoCommand(command: unknown): SudoCommandError | null {
  if (typeof command !== "string" || command.trim() === "") return "missing";
  if (command.length > SUDO_COMMAND_MAX) return "too_long";
  if (FORBIDDEN.test(command)) return "forbidden_character";
  if (/^ *sudo( |$)/.test(command)) return "leading_sudo";
  return null;
}
