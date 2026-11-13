import type { AskCommandRun } from "./types.ts";

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

// A run that succeeded: it ended with exit code 0. Its command has no Run on
// the card (task 3b648009), and the ask is answered when every command has
// one.
export function runSucceeded(run: AskCommandRun | undefined): boolean {
  return run?.state === "done" && run.exitCode === 0;
}
