// Resume after a usage limit (task a254f3f3): the pure parts.
//
// When a usage limit stops an agent's turn and the engine reports when the
// limit resets, agent-manager keeps a pending resume for a minute after the
// reset. At that time it sends the agent one message to continue. The pending
// resume is persisted (agents.json limitResumeAt) and dropped when the agent
// works again, when the switch goes off, on kill, and at a conversation
// boundary. The state machine lives in agent-manager; this module holds the
// timing and the words.
//
// Loop guard: a pending resume is armed only from a reset time in the future.
// The fire comes after that reset, so a stop on the resumed turn can only arm
// from a later reset. A stale reset time, or the same one reported again,
// never arms.

import type { AgentInfo } from "../shared/types.ts";

// The wait after the reported reset time, so the provider has reset the
// window before the resumed turn calls it.
export const LIMIT_RESUME_DELAY_MS = 60_000;
// A resume due during downtime waits this long after boot, so agent restore
// is done before it fires.
export const LIMIT_RESUME_BOOT_DELAY_MS = 30_000;
// One timer waits at most this long and then checks the due time again.
// setTimeout cannot wait longer than about 24.8 days, and a weekly reset is
// 7 days away.
export const LIMIT_RESUME_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/** The agent-facing message. The flush sends it as it is, with no prefix. */
export const LIMIT_RESUME_TEXT =
  "[Isomux: the usage limit reset. Continue where you stopped.]";

/** When the resume fires, or null when this reset time cannot arm one. */
export function limitResumeDueAt(
  resetsAtMs: number,
  now: number,
): number | null {
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= now) return null;
  return resetsAtMs + LIMIT_RESUME_DELAY_MS;
}

/** The switch is on (absent reads as on) and the engine supports it. */
export function limitResumeOn(
  info: Pick<AgentInfo, "limitResume" | "capabilities">,
): boolean {
  return info.limitResume !== false && info.capabilities.limitResume;
}

/** How long the next timer waits for a resume due at `dueAt`. */
export function limitResumeWaitMs(
  dueAt: number,
  now: number,
  minMs = 0,
): number {
  return Math.min(Math.max(dueAt - now, minMs), LIMIT_RESUME_MAX_WAIT_MS);
}
