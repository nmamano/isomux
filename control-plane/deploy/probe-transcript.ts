// What the probe child actually said, as typed fields - and what a coordinator
// is allowed to conclude from it.
//
// THE OLD READING WAS ONE LINE. The move coordinator scanned the child's output
// for `accepted: true` and required exit 0. That is a substring search over
// whatever a child printed: a probe that emitted the line and nothing else
// passed, a probe whose five statuses contradicted its own verdict passed, and
// a truncated run that happened to contain the line passed. The verdict was
// trusted rather than checked.
//
// So this module parses the COMPLETE expected transcript and RECOMPUTES the
// verdict from the typed fields. Every field the probe prints must be present
// exactly once and carry the right kind of value; the acceptance the child
// reported must equal the acceptance its own fields imply; and any
// disagreement, duplicate, unknown name, missing field or inconsistent count is
// a HARD failure rather than a retry. A child printing only `accepted: true`
// can no longer pass anything.
//
// RAW OUTPUT DOES NOT LEAVE THIS FILE. Every string that comes back is from a
// closed vocabulary declared here or a field name from the lists below - never
// a fragment of what the child printed, which is text this program does not
// control and must not put in a transcript.
//
// THE THIRD ANSWER, and why it is not "failed". A machine that has just been
// replaced is healthy and not yet TICKING: `tick_recent` is false until the
// first pass completes, and the probe correctly refuses. That is a deployment
// still coming up, not a deployment that is wrong, and telling the two apart is
// the difference between a rollback and a wait. `readiness_pending` is that
// state, and it is defined NARROWLY - one named boolean false, everything else
// exactly right - so nothing else can drift into it.

import { GATING_KEYS, HEALTH_KEYS } from "./probe.ts";

/** Fields whose value is `true` or `false` and nothing else. */
export const PROBE_BOOLEAN_FIELDS = [
  "mint_file_present",
  "mint_file_regular",
  "mint_file_mode_600",
  "mint_file_shape_ok",
  "invite_answer_forbidden",
  "health_shape_ok",
  "health_gating_all_true",
  "bearer_enforced",
  "surface_answering",
  "accepted",
] as const;

/** Fields carrying an HTTP status. */
export const PROBE_STATUS_FIELDS = [
  "invite_without_credential",
  "invite_with_wrong_credential_same_length",
  "invite_with_credential",
  "health_without_credential",
  "health_with_credential",
] as const;

/** Fields carrying a count of shape defects the child found. */
export const PROBE_COUNT_FIELDS = [
  "health_missing_fields",
  "health_unexpected_fields",
  "health_non_boolean_fields",
] as const;

/**
 * The health booleans, taken FROM THE PROBE so the two cannot drift.
 *
 * `probe.ts` prints exactly `HEALTH_KEYS`, indented; if a key is added there
 * this parser requires it here on the next run rather than counting it as an
 * unknown name.
 */
export const PROBE_HEALTH_FIELDS = HEALTH_KEYS;

export type ProbeBooleanField = (typeof PROBE_BOOLEAN_FIELDS)[number];
export type ProbeStatusField = (typeof PROBE_STATUS_FIELDS)[number];
export type ProbeCountField = (typeof PROBE_COUNT_FIELDS)[number];
export type ProbeHealthField = (typeof PROBE_HEALTH_FIELDS)[number];

export interface ProbeFields {
  booleans: Record<ProbeBooleanField, boolean>;
  statuses: Record<ProbeStatusField, number>;
  counts: Record<ProbeCountField, number>;
  health: Record<ProbeHealthField, boolean>;
}

/**
 * Everything this module will ever say about a run.
 *
 * A closed vocabulary, because these strings go into an operator's transcript
 * and the alternative - a message built from the child's output - is the
 * ruling-8 boundary being crossed by a diagnostic.
 */
export const PROBE_DEFECTS = {
  timedOut: "child_timed_out",
  groupSurvived: "child_group_survived",
  groupNotEmpty: "child_group_not_empty",
  uncleanExit: "child_unclean_exit",
  unexpectedExit: "child_unexpected_exit_code",
  unparseableLine: "unparseable_line",
  unknownField: "unknown_field",
  duplicateField: "duplicate_field",
  notABoolean: "value_not_a_boolean",
  notAStatus: "value_not_an_http_status",
  notACount: "value_not_a_count",
  mintFile: "mint_file_claims_inconsistent",
  counts: "health_counts_inconsistent",
  shape: "health_shape_inconsistent",
  gating: "health_gating_inconsistent",
  bearer: "bearer_verdict_inconsistent",
  forbidden: "forbidden_verdict_inconsistent",
  surface: "surface_verdict_inconsistent",
  accepted: "reported_acceptance_disagrees_with_fields",
  exitZeroNotAccepted: "exit_zero_without_acceptance",
  notPending: "refusal_is_not_the_readiness_state",
} as const;

export interface ParsedTranscript {
  ok: boolean;
  /** Fixed labels, and field names from the lists above. Never child text. */
  defects: string[];
  /** Present only when `ok`. */
  fields: ProbeFields | null;
}

const BOOLEANS = new Set<string>(PROBE_BOOLEAN_FIELDS);
const STATUSES = new Set<string>(PROBE_STATUS_FIELDS);
const COUNTS = new Set<string>(PROBE_COUNT_FIELDS);
const HEALTH = new Set<string>(PROBE_HEALTH_FIELDS);

/**
 * The whole transcript, typed - or a list of reasons it is not one.
 *
 * ORDER IS NOT REQUIRED and completeness is. A parser that insisted on the
 * printing order would break on a line moved in `probe.ts` while a genuinely
 * truncated run - the failure this is guarding against - is caught by the
 * missing fields either way.
 */
export function parseProbeTranscript(stdout: string): ParsedTranscript {
  const defects: string[] = [];
  const seen = new Set<string>();
  const booleans = new Map<string, boolean>();
  const statuses = new Map<string, number>();
  const counts = new Map<string, number>();
  const health = new Map<string, boolean>();
  let unparseable = 0;
  let unknown = 0;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /^([a-z0-9_]+): (.*)$/.exec(line);
    if (!match) {
      unparseable++;
      continue;
    }
    const [, name, value] = match;
    if (seen.has(name)) {
      // A duplicate is a defect whether or not the two agree: the transcript is
      // supposed to be one run's answer, and two answers to one question is not
      // a thing to pick between.
      if (!defects.includes(PROBE_DEFECTS.duplicateField)) {
        defects.push(PROBE_DEFECTS.duplicateField);
      }
      continue;
    }
    seen.add(name);

    if (BOOLEANS.has(name) || HEALTH.has(name)) {
      if (value !== "true" && value !== "false") {
        defects.push(`${PROBE_DEFECTS.notABoolean}:${name}`);
        continue;
      }
      (BOOLEANS.has(name) ? booleans : health).set(name, value === "true");
      continue;
    }
    if (STATUSES.has(name)) {
      const n = Number(value);
      if (!/^[0-9]{3}$/.test(value) || !Number.isInteger(n) || n < 100) {
        defects.push(`${PROBE_DEFECTS.notAStatus}:${name}`);
        continue;
      }
      statuses.set(name, n);
      continue;
    }
    if (COUNTS.has(name)) {
      const n = Number(value);
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isInteger(n)) {
        defects.push(`${PROBE_DEFECTS.notACount}:${name}`);
        continue;
      }
      counts.set(name, n);
      continue;
    }
    // NAMED, NEVER QUOTED. The name came from the child, so it is counted and
    // the count is what a transcript carries.
    unknown++;
  }

  if (unparseable > 0) defects.push(PROBE_DEFECTS.unparseableLine);
  if (unknown > 0) defects.push(PROBE_DEFECTS.unknownField);
  for (const name of PROBE_BOOLEAN_FIELDS) {
    if (!booleans.has(name)) defects.push(`missing_field:${name}`);
  }
  for (const name of PROBE_STATUS_FIELDS) {
    if (!statuses.has(name)) defects.push(`missing_field:${name}`);
  }
  for (const name of PROBE_COUNT_FIELDS) {
    if (!counts.has(name)) defects.push(`missing_field:${name}`);
  }
  for (const name of PROBE_HEALTH_FIELDS) {
    if (!health.has(name)) defects.push(`missing_field:${name}`);
  }
  if (defects.length > 0) return { ok: false, defects, fields: null };

  const fields: ProbeFields = {
    booleans: Object.fromEntries(booleans) as ProbeFields["booleans"],
    statuses: Object.fromEntries(statuses) as ProbeFields["statuses"],
    counts: Object.fromEntries(counts) as ProbeFields["counts"],
    health: Object.fromEntries(health) as ProbeFields["health"],
  };
  defects.push(...inconsistencies(fields));
  return defects.length > 0
    ? { ok: false, defects, fields: null }
    : { ok: true, defects: [], fields };
}

/**
 * Where the child's own claims contradict its own measurements.
 *
 * EVERY DERIVED FIELD IS RECOMPUTED, and the recomputation is the check. The
 * probe prints both the readings and the verdicts it drew from them, so a
 * verdict that does not follow means the two halves came from different runs,
 * a different program, or a version of the probe this coordinator has not
 * read - and each of those is a reason to stop rather than to believe the
 * cheerful line.
 */
function inconsistencies(f: ProbeFields): string[] {
  const out: string[] = [];
  // The probe stops and exits 2 unless all four hold, so a complete transcript
  // carrying a false one cannot have come from this program.
  const mintFileOk =
    f.booleans.mint_file_present &&
    f.booleans.mint_file_regular &&
    f.booleans.mint_file_mode_600 &&
    f.booleans.mint_file_shape_ok;
  if (!mintFileOk) out.push(PROBE_DEFECTS.mintFile);

  // Six health keys parsed as booleans means the child cannot have found any
  // missing or non-boolean. Unexpected fields are the one count that may be
  // non-zero without a key line changing.
  if (f.counts.health_missing_fields !== 0) out.push(PROBE_DEFECTS.counts);
  if (f.counts.health_non_boolean_fields !== 0) out.push(PROBE_DEFECTS.counts);

  const shape =
    f.counts.health_missing_fields === 0 &&
    f.counts.health_unexpected_fields === 0 &&
    f.counts.health_non_boolean_fields === 0;
  if (f.booleans.health_shape_ok !== shape) out.push(PROBE_DEFECTS.shape);

  const gating = GATING_KEYS.every((k) => f.health[k] === true);
  if (f.booleans.health_gating_all_true !== gating) {
    out.push(PROBE_DEFECTS.gating);
  }

  const bearer =
    f.statuses.invite_without_credential === 401 &&
    f.statuses.invite_with_wrong_credential_same_length === 401 &&
    f.statuses.health_without_credential === 401;
  if (f.booleans.bearer_enforced !== bearer) out.push(PROBE_DEFECTS.bearer);

  // `invite_answer_forbidden` is the status AND the verb's own word, so it
  // cannot be true unless the status was 404.
  if (
    f.booleans.invite_answer_forbidden &&
    f.statuses.invite_with_credential !== 404
  ) {
    out.push(PROBE_DEFECTS.forbidden);
  }
  const surface =
    f.booleans.invite_answer_forbidden &&
    f.statuses.health_with_credential === 200;
  if (f.booleans.surface_answering !== surface) out.push(PROBE_DEFECTS.surface);

  if (f.booleans.accepted !== derivedAcceptance(f)) {
    out.push(PROBE_DEFECTS.accepted);
  }
  return out;
}

/** Acceptance as the probe's own fields imply it, which is what the reported
 * value is required to equal. */
export function derivedAcceptance(f: ProbeFields): boolean {
  return (
    f.booleans.bearer_enforced &&
    f.booleans.surface_answering &&
    f.booleans.health_shape_ok &&
    f.booleans.health_gating_all_true
  );
}

export type ProbeVerdict = "accepted" | "readiness_pending" | "hard";

/** What a bounded child run of the probe amounts to. */
export interface ProbeRun {
  code: number | null;
  timedOut: boolean;
  groupSurvived: boolean;
  groupEmpty: boolean;
  stdout: string;
}

export interface ProbeOutcome {
  verdict: ProbeVerdict;
  defects: string[];
}

/**
 * IS THIS A DEPLOYMENT STILL COMING UP?
 *
 * The predicate is deliberately narrow and positive: everything that must be
 * true is named, `tick_recent` is the ONE reading allowed to be false, and the
 * machine's own `ok` follows from it (it is the conjunction that includes
 * `tick_recent`, so a healthy machine mid-boot reports it false). `ok` being
 * false is therefore not independently a failure here - and `ok` being TRUE
 * while `tick_recent` is false is a machine contradicting itself, which falls
 * out of this predicate as hard.
 *
 * `state_persisted` is not gated on at all, exactly as the probe does not gate
 * on it: a first deploy has nothing to have survived.
 */
export function isReadinessPending(f: ProbeFields): boolean {
  return (
    f.booleans.bearer_enforced &&
    f.booleans.surface_answering &&
    f.booleans.health_shape_ok &&
    f.counts.health_missing_fields === 0 &&
    f.counts.health_unexpected_fields === 0 &&
    f.counts.health_non_boolean_fields === 0 &&
    f.health.bounds_governed &&
    f.health.branch_pinned &&
    f.health.database_reachable &&
    f.health.tick_recent === false &&
    f.health.ok === false &&
    f.booleans.accepted === false
  );
}

/**
 * The one classification, from the child's exit and its transcript.
 *
 * EXIT 1 IS THE PROBE'S REFUSAL and the only code a pending state may arrive
 * on; exit 0 must carry a derived acceptance, and anything else - a timeout, a
 * group that outlived its leader or would not prove empty, a code this program
 * does not issue - is hard. An unclean run's output is a fragment by
 * definition, so it is not parsed at all (`fly-cli.ts` states that contract).
 */
export function classifyProbeRun(run: ProbeRun): ProbeOutcome {
  const hard = (defect: string): ProbeOutcome => ({
    verdict: "hard",
    defects: [defect],
  });
  if (run.timedOut) return hard(PROBE_DEFECTS.timedOut);
  if (run.groupSurvived) return hard(PROBE_DEFECTS.groupSurvived);
  if (!run.groupEmpty) return hard(PROBE_DEFECTS.groupNotEmpty);
  if (run.code === null) return hard(PROBE_DEFECTS.uncleanExit);
  if (run.code !== 0 && run.code !== 1) {
    return hard(PROBE_DEFECTS.unexpectedExit);
  }

  const parsed = parseProbeTranscript(run.stdout);
  if (!parsed.ok || parsed.fields === null) {
    return { verdict: "hard", defects: parsed.defects };
  }
  if (run.code === 0) {
    return parsed.fields.booleans.accepted
      ? { verdict: "accepted", defects: [] }
      : hard(PROBE_DEFECTS.exitZeroNotAccepted);
  }
  return isReadinessPending(parsed.fields)
    ? { verdict: "readiness_pending", defects: [] }
    : hard(PROBE_DEFECTS.notPending);
}
