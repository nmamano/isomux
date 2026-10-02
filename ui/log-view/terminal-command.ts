// Ctrl+U in bash deletes only backward from the cursor. Ctrl+E first moves to
// the end, so this clears the whole current line in bash, zsh, and fish before
// typing the proposed command. There is deliberately no Enter or Ctrl+C: the
// command stays unexecuted, and a visible secondary prompt remains open.
export function commandInputBytes(command: string): string {
  return `\x05\x15${command}`;
}

export const INTERRUPT_INPUT_BYTES = "\x03";

// Ctrl+E Ctrl+U clears only the current line, so at a continuation prompt the
// earlier lines would stay in the shell's parser and join the typed command.
// Only an interrupt abandons them, and bash echoes it as ^C. Default PS2 is
// "> " in bash and "%_> " in zsh ("quote> ", "for> "), so only a line that
// starts like that gets the interrupt. A custom PS2 is not recognized.
export function looksLikeContinuationPrompt(line: string): boolean {
  return /^(?:[a-z]+ )*[a-z]*> /u.test(line);
}

export type CommandDeliveryState = {
  command: string;
  phase: "owner" | "interrupt_ack" | "fresh_owner";
};

export type CommandDeliveryEvent =
  | { type: "output"; data: string }
  | { type: "status"; shell: boolean; process: string; line: string }
  | { type: "exit" }
  | { type: "timeout" };

/**
 * Why a queued command was dropped, as a discriminated result rather than a
 * sentence: the words live in the catalog and the panel renders them in the
 * reader's language (internal-docs/i18n-loop.md, rulings 7 and 17).
 */
export type CommandDeliveryIssue =
  | { kind: "unavailable" }
  | { kind: "busy"; process: string };

export type CommandDeliveryResult = {
  state: CommandDeliveryState | null;
  write?: string;
  requestStatus?: true;
  issue?: CommandDeliveryIssue;
  handled?: true;
};

// A card first asks for a fresh owner, because a pushed status can lag a
// foreground change by up to the 500 ms sidecar poll. Nothing is written yet.
export function queueCommand(
  state: CommandDeliveryState | null,
  command: string,
): { state: CommandDeliveryState; requestStatus?: true } {
  if (state) return { state: { ...state, command } };
  return { state: { command, phase: "owner" }, requestStatus: true };
}

export function advanceCommandDelivery(
  state: CommandDeliveryState | null,
  event: CommandDeliveryEvent,
): CommandDeliveryResult {
  if (!state) {
    return event.type === "timeout"
      ? { state: null, issue: { kind: "unavailable" }, handled: true }
      : { state: null };
  }
  if (event.type === "exit" || event.type === "timeout") {
    return { state: null, issue: { kind: "unavailable" }, handled: true };
  }
  if (state.phase === "interrupt_ack") {
    // zsh prints no ^C, so any output after the interrupt is the
    // acknowledgement. The fresh status after it decides what happens next.
    if (event.type !== "output") return { state };
    return { state: { ...state, phase: "fresh_owner" }, requestStatus: true };
  }
  if (event.type !== "status") return { state };
  if (!event.shell) {
    return {
      state: null,
      issue: { kind: "busy", process: event.process },
      handled: true,
    };
  }
  if (state.phase === "owner" && looksLikeContinuationPrompt(event.line)) {
    return {
      state: { ...state, phase: "interrupt_ack" },
      write: INTERRUPT_INPUT_BYTES,
    };
  }
  return {
    state: null,
    write: commandInputBytes(state.command),
    handled: true,
  };
}
