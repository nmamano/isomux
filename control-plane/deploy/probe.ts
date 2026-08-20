// Does the deployed surface refuse everyone except the credential holder, and
// is the machine behind it actually working?
//
//   bun control-plane/deploy/probe.ts
//
// THE ORIGIN IS A CONSTANT, and that is a security property rather than a
// convenience. This program sends the real bearer, so an origin taken from the
// command line is a way to hand that credential to whatever host somebody typed
// - a mistake that leaves every check in the output passing. There is exactly
// one deployed provisioner, so there is nothing an override could be for.
//
// Five questions, in the order that makes the last ones meaningful:
//
//   1. no credential          -> 401
//   2. a WRONG credential of the SAME LENGTH -> 401. A length check would pass
//      this, which is why the wrong one is built to match.
//   3. the real credential, naming an operation that does not exist -> 404, the
//      verb's own "no such request". It proves the route works without any real
//      invite existing.
//   4. health without a credential -> 401.
//   5. health with one -> 200, the EXACT expected nested shape, all seven
//      readiness values boolean, and the five that gate acceptance all true.
//
// A 200 IS NOT ACCEPTANCE. An earlier version of this file checked the status
// and printed whatever fields came back, which would have passed a machine
// answering {ok: false} and would have printed a field name the surface is not
// supposed to have. The keys below are fixed, they are printed in this order,
// and anything else in the answer is counted rather than named.
//
// The credential is read inside this process, through the same validation the
// import uses, and never printed. The wrong one is generated here and dropped.

import { HEALTH_PATH, MINT_SEAM_PATH } from "../mint-seam.ts";
import { inspectMintFile, mintFileUsable } from "./fly-cli.ts";

/**
 * The one host this program will ever send a credential to.
 *
 * https, and no path: the two request URLs are built from it plus the seam's
 * own constants, so there is no string a caller can influence anywhere in them.
 */
export const PROVISIONER_ORIGIN = "https://isomux-provisioner.fly.dev";

/** Every key the surface may answer with, in the order they are printed. */
export const HEALTH_KEYS = [
  "ok",
  "bounds_governed",
  "branch_pinned",
  "database_reachable",
  "tick_recent",
  "state_persisted",
  "provider_configured",
] as const;
export const RELEASE_KEYS = [
  "release_source",
  "release_payload",
  "release_deployment",
] as const;

/**
 * The five that must be true for a deployment to be accepted.
 *
 * `state_persisted` is deliberately not one of them: on a first deploy there is
 * nothing for it to have survived, and gating on it would make a correct first
 * deploy look like a failure. Volume evidence is a separate reading, taken
 * across a redeploy.
 *
 * `provider_configured` is not one of them either, and for a different reason:
 * a provisioner with no provider credentials IDLES CORRECTLY - that is the
 * design, and D2 measured it over 37 minutes. Gating on it would call a
 * deliberate state a failure. It is a reading the operator asserts when the
 * credentials are supposed to be there (D4, 2026-08-12), and the acceptance of
 * that gate names it explicitly rather than letting `ok` carry it.
 */
export const GATING_KEYS = [
  "ok",
  "bounds_governed",
  "branch_pinned",
  "database_reachable",
  "tick_recent",
] as const;

export interface HealthVerdict {
  /** Exactly the expected top-level and nested keys, with exact value types. */
  shapeOk: boolean;
  /** How many fields we did not expect. A COUNT: naming them would print
   * whatever a compromised or mistaken surface decided to send. */
  unexpectedFields: number;
  missingFields: number;
  nonBooleanFields: number;
  /** All five gating booleans true. */
  gatingTrue: boolean;
  /** Valid known identity or the explicit no-claim value. Not a readiness gate:
   * identity does not change whether the process can provision an office. */
  releaseShapeOk: boolean;
  sourceKnown: boolean;
  payloadKnown: boolean;
  deploymentKnown: boolean;
  /** Fixed keys, fixed order, for printing. */
  lines: string[];
}

export function judgeHealth(body: unknown): HealthVerdict {
  const map =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const present = new Set(Object.keys(map));
  const expected = [...HEALTH_KEYS, ...RELEASE_KEYS];
  const missingFields = expected.filter((k) => !present.has(k)).length;
  const unexpectedFields = [...present].filter(
    (k) => !(expected as readonly string[]).includes(k),
  ).length;
  const nonBooleanFields = HEALTH_KEYS.filter(
    (k) => present.has(k) && typeof map[k] !== "boolean",
  ).length;
  const lines = HEALTH_KEYS.map((key) => {
    if (!present.has(key)) return `  ${key}: MISSING`;
    const value = map[key];
    return typeof value === "boolean"
      ? `  ${key}: ${value}`
      : `  ${key}: NOT A BOOLEAN`;
  });
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  const source = record(map.release_source);
  const sourceCommit =
    source?.known === true &&
    exactKeys(source, ["known", "commit", "deploy_started_at"]) &&
    typeof source.commit === "string" &&
    /^[0-9a-f]{40}$/.test(source.commit)
      ? source.commit
      : null;
  const sourceStartedAt =
    sourceCommit !== null &&
    typeof source?.deploy_started_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      source.deploy_started_at,
    )
      ? source.deploy_started_at
      : null;
  const sourceKnown = sourceCommit !== null && sourceStartedAt !== null;
  const sourceShapeOk =
    (source?.known === false && exactKeys(source, ["known"])) || sourceKnown;
  const payload = record(map.release_payload);
  const payloadSha256 =
    payload?.known === true &&
    exactKeys(payload, ["known", "sha256"]) &&
    typeof payload.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(payload.sha256)
      ? payload.sha256
      : null;
  const payloadKnown = payloadSha256 !== null;
  const payloadShapeOk =
    (payload?.known === false && exactKeys(payload, ["known"])) || payloadKnown;
  const deployment = record(map.release_deployment);
  const deploymentId =
    deployment?.known === true &&
    exactKeys(deployment, ["known", "id"]) &&
    typeof deployment.id === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(deployment.id)
      ? deployment.id
      : null;
  const deploymentKnown = deploymentId !== null;
  const deploymentShapeOk =
    (deployment?.known === false && exactKeys(deployment, ["known"])) ||
    deploymentKnown;
  const releaseShapeOk = sourceShapeOk && payloadShapeOk && deploymentShapeOk;
  lines.push(
    `  release_source_commit: ${sourceCommit ?? "NOT KNOWN"}`,
    `  release_deploy_started_at: ${sourceStartedAt ?? "NOT KNOWN"}`,
    `  release_payload_sha256: ${payloadSha256 ?? "NOT KNOWN"}`,
    `  release_deployment_id: ${deploymentId ?? "NOT KNOWN"}`,
  );
  return {
    shapeOk:
      missingFields === 0 &&
      unexpectedFields === 0 &&
      nonBooleanFields === 0 &&
      releaseShapeOk,
    unexpectedFields,
    missingFields,
    nonBooleanFields,
    gatingTrue: GATING_KEYS.every((k) => map[k] === true),
    releaseShapeOk,
    sourceKnown: sourceShapeOk && sourceKnown,
    payloadKnown: payloadShapeOk && payloadKnown,
    deploymentKnown: deploymentShapeOk && deploymentKnown,
    lines,
  };
}

async function main(): Promise<void> {
  const base = PROVISIONER_ORIGIN;
  const { checks, token } = inspectMintFile();
  console.log(`mint_file_present: ${checks.present}`);
  console.log(`mint_file_regular: ${checks.regularFile}`);
  console.log(`mint_file_mode_600: ${checks.mode600}`);
  console.log(`mint_file_shape_ok: ${checks.shapeOk}`);
  if (!mintFileUsable(checks)) {
    console.log("refusing: the seam credential file is not in the ruled shape");
    process.exitCode = 2;
    return;
  }
  const wrong = "x".repeat(token.length);

  const invite = `${base}${MINT_SEAM_PATH}`;
  const body = JSON.stringify({
    accountId: "probe-no-such-account",
    instanceId: "probe-no-such-instance",
    operationId: "probe-no-such-operation",
  });

  const anonymous = await fetch(invite, { method: "POST", body });
  console.log(`invite_without_credential: ${anonymous.status}`);

  const wrongOne = await fetch(invite, {
    method: "POST",
    headers: { authorization: `Bearer ${wrong}` },
    body,
  });
  console.log(`invite_with_wrong_credential_same_length: ${wrongOne.status}`);

  const real = await fetch(invite, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
  });
  const verb = (await real.json()) as { status?: string };
  console.log(`invite_with_credential: ${real.status}`);
  console.log(
    `invite_answer_forbidden: ${real.status === 404 && verb.status === "forbidden"}`,
  );

  const healthAnonymous = await fetch(`${base}${HEALTH_PATH}`);
  console.log(`health_without_credential: ${healthAnonymous.status}`);

  const health = await fetch(`${base}${HEALTH_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  console.log(`health_with_credential: ${health.status}`);
  const verdict = judgeHealth(await health.json().catch(() => null));
  for (const line of verdict.lines) console.log(line);
  console.log(`health_shape_ok: ${verdict.shapeOk}`);
  console.log(`health_missing_fields: ${verdict.missingFields}`);
  console.log(`health_unexpected_fields: ${verdict.unexpectedFields}`);
  console.log(`health_non_boolean_fields: ${verdict.nonBooleanFields}`);
  console.log(`health_release_shape_ok: ${verdict.releaseShapeOk}`);
  console.log(`health_release_source_known: ${verdict.sourceKnown}`);
  console.log(`health_release_payload_known: ${verdict.payloadKnown}`);
  console.log(`health_release_deployment_known: ${verdict.deploymentKnown}`);
  console.log(`health_gating_all_true: ${verdict.gatingTrue}`);

  const bearerEnforced =
    anonymous.status === 401 &&
    wrongOne.status === 401 &&
    healthAnonymous.status === 401;
  const surfaceAnswering =
    real.status === 404 && verb.status === "forbidden" && health.status === 200;
  console.log(`bearer_enforced: ${bearerEnforced}`);
  console.log(`surface_answering: ${surfaceAnswering}`);
  const accepted =
    bearerEnforced && surfaceAnswering && verdict.shapeOk && verdict.gatingTrue;
  console.log(`accepted: ${accepted}`);
  process.exitCode = accepted ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
