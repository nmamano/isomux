// Reasoning effort as a person reads it. The level is an id (EFFORT_LEVELS in
// shared/types.ts); the words live in the catalog under common.effort.*, so the
// agent dialog and the schedule dialog read the same level the same way.
//
// EFFORT_LEVELS keeps its own English label because the server's /effort
// command still renders from it; catalog.test.ts holds the two copies to the
// same English text so they cannot drift (internal-docs/i18n-loop.md, S4).
//
// Pure module: the translator arrives as the first argument (ruling 18).

import type { EffortLevel } from "../shared/types.ts";
import type { MessageKey, Translator } from "../shared/i18n/translate.ts";

export const EFFORT_KEYS: Record<
  EffortLevel,
  Extract<MessageKey, `common.effort.${string}`>
> = {
  minimal: "common.effort.minimal",
  low: "common.effort.low",
  medium: "common.effort.medium",
  high: "common.effort.high",
  xhigh: "common.effort.xhigh",
  max: "common.effort.max",
  ultra: "common.effort.ultra",
};

/**
 * The catalog's words for `level`. A backend may report a level the table does
 * not carry ("none"): its own id is then the honest rendering, rather than a
 * title-cased guess at English.
 */
export function effortLabel(i18n: Translator, level: string): string {
  const key = EFFORT_KEYS[level as EffortLevel];
  return key ? i18n.t(key) : level;
}
