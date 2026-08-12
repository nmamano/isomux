// A probe transcript the real probe could have printed.
//
// Shared by the parser's own tests and the move coordinator's, because the two
// must agree about what an honest transcript looks like - a fixture copied into
// each file would let one drift and go on passing.
//
// THE DERIVED LINES ARE DERIVED HERE TOO. Callers vary the DEPLOYMENT's state
// (the health booleans) and the verdict lines follow, exactly as they follow in
// `probe.ts`. A caller that wants a dishonest transcript edits one line of the
// result, which makes what it is testing visible in the test rather than hidden
// in a fixture argument.

import { GATING_KEYS, HEALTH_KEYS } from "../deploy/probe.ts";

export type HealthKey = (typeof HEALTH_KEYS)[number];

/** Everything working, including a machine that has completed a pass. */
export const GREEN_HEALTH: Record<HealthKey, boolean> = {
  ok: true,
  bounds_governed: true,
  branch_pinned: true,
  database_reachable: true,
  tick_recent: true,
  state_persisted: true,
};

/** The transcript's lines, in the order the probe prints them. */
export function probeTranscriptLines(
  health: Partial<Record<HealthKey, boolean>> = {},
): string[] {
  const h = { ...GREEN_HEALTH, ...health };
  const gating = GATING_KEYS.every((k) => h[k]);
  return [
    "mint_file_present: true",
    "mint_file_regular: true",
    "mint_file_mode_600: true",
    "mint_file_shape_ok: true",
    "invite_without_credential: 401",
    "invite_with_wrong_credential_same_length: 401",
    "invite_with_credential: 404",
    "invite_answer_forbidden: true",
    "health_without_credential: 401",
    "health_with_credential: 200",
    ...HEALTH_KEYS.map((k) => `  ${k}: ${h[k]}`),
    "health_shape_ok: true",
    "health_missing_fields: 0",
    "health_unexpected_fields: 0",
    "health_non_boolean_fields: 0",
    `health_gating_all_true: ${gating}`,
    "bearer_enforced: true",
    "surface_answering: true",
    `accepted: ${gating}`,
  ];
}

/** The same, as the child's stdout and the exit code it would carry. */
export function probeTranscript(
  health: Partial<Record<HealthKey, boolean>> = {},
): { code: number; stdout: string } {
  const lines = probeTranscriptLines(health);
  const accepted = lines.includes("accepted: true");
  return { code: accepted ? 0 : 1, stdout: `${lines.join("\n")}\n` };
}

/** A machine that is up and has not completed its first pass - the state a
 * freshly replaced machine is legitimately in for a few seconds. */
export function notTickingYet(): { code: number; stdout: string } {
  return probeTranscript({ tick_recent: false, ok: false });
}
