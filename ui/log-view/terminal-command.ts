// Ctrl+U in bash deletes only backward from the cursor. Ctrl+E first moves to
// the end, so this clears the whole current line in bash, zsh, and fish before
// typing the proposed command. There is deliberately no Enter or Ctrl+C: the
// command stays unexecuted, and a visible secondary prompt remains open.
export function commandInputBytes(command: string): string {
  return `\x05\x15${command}`;
}

export const INTERRUPT_INPUT_BYTES = "\x03";

export type CommandDeliveryState = {
  command: string;
  phase: "interrupt_ack" | "fresh_owner";
  interruptOutput: string;
};

export type CommandDeliveryEvent =
  | { type: "output"; data: string }
  | { type: "status"; shell: boolean; process: string }
  | { type: "exit" }
  | { type: "timeout" };

export type CommandDeliveryResult = {
  state: CommandDeliveryState | null;
  write?: string;
  requestStatus?: true;
  issue?: string;
  handled?: true;
};

export function queueCommand(
  state: CommandDeliveryState | null,
  command: string,
): { state: CommandDeliveryState; write?: string } {
  if (state) return { state: { ...state, command } };
  return {
    state: { command, phase: "interrupt_ack", interruptOutput: "" },
    write: INTERRUPT_INPUT_BYTES,
  };
}

export function advanceCommandDelivery(
  state: CommandDeliveryState | null,
  event: CommandDeliveryEvent,
): CommandDeliveryResult {
  if (!state) {
    return event.type === "exit" || event.type === "timeout"
      ? { state: null, issue: "Terminal unavailable", handled: true }
      : { state: null };
  }
  if (event.type === "exit" || event.type === "timeout") {
    return { state: null, issue: "Terminal unavailable", handled: true };
  }
  if (state.phase === "interrupt_ack") {
    if (event.type !== "output") return { state };
    const interruptOutput = `${state.interruptOutput}${event.data}`.slice(-256);
    return {
      state: {
        ...state,
        interruptOutput,
        phase: interruptOutput.includes("^C") ? "fresh_owner" : state.phase,
      },
      requestStatus: interruptOutput.includes("^C") ? true : undefined,
    };
  }
  if (event.type !== "status") return { state };
  if (!event.shell) {
    return {
      state: null,
      issue: `Not sent: ${event.process} is using the terminal`,
      handled: true,
    };
  }
  return {
    state: null,
    write: commandInputBytes(state.command),
    handled: true,
  };
}
