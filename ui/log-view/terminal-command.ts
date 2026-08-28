// Ctrl+U in bash deletes only backward from the cursor. Ctrl+E first moves to
// the end, so this clears the whole current line in bash, zsh, and fish before
// typing the proposed command. There is deliberately no Enter or Ctrl+C: the
// command stays unexecuted, and a visible secondary prompt remains open.
export function commandInputBytes(command: string): string {
  return `\x05\x15${command}`;
}
