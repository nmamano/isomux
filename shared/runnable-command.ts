// Whether the card may Run an ask's command with one tap (task c3b91695):
// only a command that shows as it runs. A control character other than a
// newline or a tab, or a Unicode format character (bidi controls, zero-width
// characters: category Cf), can show one thing and run another; such a
// command keeps only Copy to terminal. The server refuses its run too. Line
// and paragraph separators and lone surrogates go with them.
const HIDDEN = /[^\P{Cc}\n\t]|[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function isRunnableCommand(command: string): boolean {
  return !HIDDEN.test(command);
}
