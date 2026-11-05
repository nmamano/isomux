// OpenCode's free usage limit, office-wide. OpenCode keeps that limit per
// network, so one refusal on any agent, a topic one-shot or the boot check
// stands for the whole office. The Model providers tab reads it
// (GET /api/me/opencode). In memory only, like each agent's own mark.

import { OPENCODE_FALLBACK_RETRY_MS } from "./provider-fallback.ts";

export interface OpenCodeFreeLimit {
  // A free-limit refusal now.
  record(): void;
  // The latest refusal while it is younger than OPENCODE_FALLBACK_RETRY_MS,
  // else null.
  since(): number | null;
}

export function createOpenCodeFreeLimit(clock: {
  now(): number;
}): OpenCodeFreeLimit {
  let latest: number | null = null;
  return {
    record() {
      const now = clock.now();
      if (latest === null || now > latest) latest = now;
    },
    since() {
      if (latest === null) return null;
      return clock.now() - latest < OPENCODE_FALLBACK_RETRY_MS ? latest : null;
    },
  };
}
