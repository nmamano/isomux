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

/**
 * Everything working, including a machine that has completed a pass.
 *
 * `provider_configured` is true here because this fixture is the shape of a
 * FULLY equipped machine; it is not a gating key, so a caller proving the
 * credential-free state passes it as false rather than editing this.
 */
export const GREEN_HEALTH: Record<HealthKey, boolean> = {
  ok: true,
  bounds_governed: true,
  branch_pinned: true,
  database_reachable: true,
  tick_recent: true,
  cadence_healthy: true,
  state_persisted: true,
  provider_configured: true,
};
export const GREEN_RELEASE = {
  sourceCommit: "a".repeat(40),
  deployStartedAt: "2026-08-20T12:34:56.789Z",
  payloadSha256: "b".repeat(64),
  deploymentId: "01K34DEPLOY",
} as const;

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
    `  release_source_commit: ${GREEN_RELEASE.sourceCommit}`,
    `  release_deploy_started_at: ${GREEN_RELEASE.deployStartedAt}`,
    `  release_payload_sha256: ${GREEN_RELEASE.payloadSha256}`,
    `  release_deployment_id: ${GREEN_RELEASE.deploymentId}`,
    "health_shape_ok: true",
    "health_missing_fields: 0",
    "health_unexpected_fields: 0",
    "health_non_boolean_fields: 0",
    "health_release_shape_ok: true",
    "health_release_source_known: true",
    "health_release_payload_known: true",
    "health_release_deployment_known: true",
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
