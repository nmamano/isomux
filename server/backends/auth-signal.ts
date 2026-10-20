import type { NormalizedEvent } from "./types.ts";

// Every backend classifies its own sign-in failures here, with its own
// Backend.detectAuthError, and the orchestrator reacts to auth_needed alone.
// An error or failed turn_completed that matches comes back after an
// auth_needed: the orchestrator reads the turn's sign-in state when that
// terminal event arrives. Matching provider text is replaced by auth_needed,
// or kept ahead of it with keepText. Text Isomux wrote itself never goes
// through this.
export function authSignal(
  ev: NormalizedEvent,
  detect: (text: string) => boolean,
  opts?: { keepText?: boolean },
): NormalizedEvent[] {
  const needed: NormalizedEvent = { kind: "auth_needed" };
  switch (ev.kind) {
    case "system_text":
      if (typeof ev.text !== "string" || !detect(ev.text)) return [ev];
      return opts?.keepText ? [ev, needed] : [needed];
    case "error":
      return typeof ev.message === "string" && detect(ev.message)
        ? [needed, ev]
        : [ev];
    case "turn_completed":
      return ev.status === "failed" &&
        ev.providerRefusal !== true &&
        typeof ev.error === "string" &&
        detect(ev.error)
        ? [needed, ev]
        : [ev];
    default:
      return [ev];
  }
}
