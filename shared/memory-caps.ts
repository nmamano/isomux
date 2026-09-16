import type { MemoryScope } from "./types.ts";

// Max injected size per scope, in characters. The four caps sum to ~22.5k
// chars (~5.6k tokens) fully maxed; typical loads sit far lower.
export const MEMORY_CAPS: Record<MemoryScope, number> = {
  office: 2500,
  room: 10_000,
  agent: 5000,
  boss: 5000,
};
