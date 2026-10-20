// Automatic handoff threshold (internal-docs/auto-handoff-design.md), shared
// by the server trigger and the agent dialog.

// Nil, 2026-10-13: hand off at 500k tokens unless the agent sets its own
// value (AgentInfo.autoHandoffTokens).
export const AUTO_HANDOFF_DEFAULT_TOKENS = 500_000;
// Sanity range for the per-agent value. Below the floor a fresh session opens
// above the trigger, so the loop guard pauses every later conversation; the
// ceiling is above any context window.
export const AUTO_HANDOFF_TOKENS_MIN = 50_000;
export const AUTO_HANDOFF_TOKENS_MAX = 10_000_000;
