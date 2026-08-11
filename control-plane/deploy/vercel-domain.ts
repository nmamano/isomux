// Attaching the one public hostname, and the lever that takes it away again.
//
// THE DETACH EXISTS BEFORE THE ATTACH, on purpose. Manager ruling
// R-2026-08-11-2 3(b): "if any probe fails its acceptance predicate, the
// immediate action is detach the domain (rollback lever), then diagnose - never
// leave a failing state public". A rollback written after the thing it rolls
// back is a rollback nobody has run.
//
// ONE HOSTNAME, AND IT IS A CONSTANT. Every function here refuses any name but
// `cloud.isomux.com`. A detach that took a name from a caller could remove the
// landing page's domain or this project's own `*.vercel.app`, and both of those
// are one typo away from an outage somebody else owns.
//
// WHAT MAY BE PRINTED: booleans, counts, statuses, and the finished DNS record.
// A DNS record is public by construction - that is the whole point of handing
// it to a registrar - so it is the one thing here that is meant to be read.

import { vercelApi } from "./vercel-api.ts";

/** The only hostname this slice may attach or detach. */
export const TARGET_DOMAIN = "cloud.isomux.com";

/** The label a registrar needs, given the zone is `isomux.com`. */
export const TARGET_LABEL = "cloud";

/** Never touched: the project's own generated hostname. */
export function isAutoDomain(name: string): boolean {
  return name.endsWith(".vercel.app");
}

/**
 * May this name be detached?
 *
 * Only the one we attached. Not the auto domain, not an apex, not a name a
 * caller passed in - there is no argument that reaches this decision.
 */
export function mayDetach(name: string): boolean {
  return name === TARGET_DOMAIN && !isAutoDomain(name);
}

export interface DomainRow {
  name?: unknown;
  verified?: unknown;
}

export interface AttachVerdict {
  targetPresent: boolean;
  targetVerified: boolean;
  autoDomainStillPresent: boolean;
  otherDomainsAdded: number;
}

export function judgeDomains(rows: DomainRow[]): AttachVerdict {
  const names = rows
    .map((r) => (typeof r.name === "string" ? r.name : ""))
    .filter((n) => n.length > 0);
  const target = rows.find((r) => r.name === TARGET_DOMAIN);
  return {
    targetPresent: names.includes(TARGET_DOMAIN),
    targetVerified: target?.verified === true,
    autoDomainStillPresent: names.some(isAutoDomain),
    // Anything that is neither ours nor the generated one. Attaching a domain
    // must not bring a second one with it, and detaching must not leave one.
    otherDomainsAdded: names.filter(
      (n) => !isAutoDomain(n) && n !== TARGET_DOMAIN,
    ).length,
  };
}

/** Attached cleanly: our name there, the auto domain untouched, nothing else. */
export function attachHeld(verdict: AttachVerdict): boolean {
  return (
    verdict.targetPresent &&
    verdict.autoDomainStillPresent &&
    verdict.otherDomainsAdded === 0
  );
}

/** Detached cleanly: our name GONE, the auto domain still there. The second
 * half is what catches a detach that removed the wrong record. */
export function detachHeld(verdict: AttachVerdict): boolean {
  return (
    !verdict.targetPresent &&
    verdict.autoDomainStillPresent &&
    verdict.otherDomainsAdded === 0
  );
}

export interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
}

/** A CNAME target as Vercel issues them. The documented example is
 * per-project rather than the familiar shared name everyone quotes -
 * `d1d4fc829fe7bc7c.vercel-dns-017.com` (page dated 2026-02-27) - and for THIS
 * hostname the answer is the shared one, measured 2026-08-11. The closed set
 * accepts both shapes and nothing else. */
const CNAME_TARGET = /^[a-z0-9.-]+\.vercel-dns(-\d+)?\.com$/i;

/**
 * One terminal root dot removed, and nothing else rewritten.
 *
 * `cname.vercel-dns.com.` and `cname.vercel-dns.com` are the same name: the dot
 * spells the root explicitly, and a registrar field takes the name without it.
 * EXACTLY ONE dot goes, because one is what was measured. A malformed
 * `...com..` keeps a dot, fails the closed set, and is refused - normalising
 * more than the measured shape would turn a malformed answer into a valid
 * record and hand it to a human.
 *
 * It runs ONCE, inside `preferredTarget`, which is why that function returns an
 * already-normalised name. Applying it twice would strip the second dot.
 */
function withoutRootDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

/**
 * THE TARGET VERCEL RANKS FIRST, NORMALISED - or nothing.
 *
 * Measured 2026-08-11: `recommendedCNAME` is an ARRAY OF OBJECTS carrying
 * `rank` and `value` - `[{ rank: 1, value: "cname.vercel-dns.com." }]` - and
 * the sibling `recommendedIPv4` uses the same envelope with an ARRAY inside
 * `value`. This function accepted only strings, so the first attach derived no
 * record and was rolled back by its own guard.
 *
 * Selection, per ruling R-2026-08-11-3 as clarified by the manager and the
 * reviewer: TOP-RANKED means the LOWEST numeric rank, so rank 1 beats rank 2.
 * It is an ORDERING, not a requirement that rank 1 exist - ranks 2 and 3 alone
 * make rank 2 the winner. What refuses is AMBIGUITY: two different names tied
 * at the winning rank, because nothing here can decide which one a human types
 * into a registrar. Identical names collapse, since they say the same thing,
 * and the comparison happens after the root dot goes so `x` and `x.` are one.
 *
 * A MALFORMED ROW REFUSES THE WHOLE ANSWER rather than dropping itself out of
 * the ranking: a bare string among ranked objects, a nested array, a null, a
 * rank that is not a whole number, or the IPv4 envelope's array-valued `value`.
 * If one row is not the shape we measured, the ENVELOPE is not the shape we
 * measured, and no row inside it has earned any trust either.
 */
function preferredTarget(cname: unknown): string | null {
  if (typeof cname === "string") return withoutRootDot(cname);
  if (!Array.isArray(cname) || cname.length === 0) return null;
  // The older all-strings shape, kept only while it says one thing.
  if (cname.every((entry) => typeof entry === "string")) {
    const named = new Set(cname.map(withoutRootDot));
    return named.size === 1 ? [...named][0] : null;
  }
  const rows: { rank: number; value: string }[] = [];
  for (const entry of cname) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const row = entry as { rank?: unknown; value?: unknown };
    if (typeof row.rank !== "number" || !Number.isInteger(row.rank))
      return null;
    // A non-string `value` is the IPv4 envelope, not a CNAME.
    if (typeof row.value !== "string") return null;
    rows.push({ rank: row.rank, value: withoutRootDot(row.value) });
  }
  if (rows.length === 0) return null;
  const winning = Math.min(...rows.map((row) => row.rank));
  const named = new Set(
    rows.filter((row) => row.rank === winning).map((row) => row.value),
  );
  return named.size === 1 ? [...named][0] : null;
}

/**
 * The record a registrar needs, DERIVED from what Vercel said.
 *
 * Returns null rather than a guess. Inventing a target would produce a record
 * that looks right, gets typed into a registrar by a human, and does not work -
 * and the failure would land on Nil rather than on us.
 *
 * The closed set is applied to the SELECTED name, never to a survivor of a
 * filter: if Vercel's own top-ranked target fails it, that is a refusal, not a
 * reason to hand over the second choice.
 */
export function recordFrom(config: {
  recommendedCNAME?: unknown;
  recommendedIPv4?: unknown;
}): DnsRecord | null {
  const value = preferredTarget(config.recommendedCNAME);
  if (value === null) return null;
  if (!CNAME_TARGET.test(value)) return null;
  return { type: "CNAME", name: TARGET_LABEL, value };
}

/** A verification challenge, if Vercel asks for one. Same rule: read, never
 * invent. */
export function challengeFrom(rows: unknown): DnsRecord | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Record<string, unknown>;
    if (
      entry.type === "TXT" &&
      typeof entry.domain === "string" &&
      typeof entry.value === "string"
    ) {
      return { type: "TXT", name: entry.domain, value: entry.value };
    }
  }
  return null;
}

export function renderRecord(record: DnsRecord): string {
  return `${record.type}  ${record.name}  ${record.value}`;
}

export interface RecordSet {
  records: DnsRecord[];
  /** A CLOSED set: exactly one CNAME for `cloud`, plus AT MOST the one TXT
   * challenge Vercel returned. Anything else stops the phase. */
  ok: boolean;
  conflicts: number;
}

/**
 * Everything a registrar must be given, or a refusal.
 *
 * This replaces an earlier contradiction of mine - "hand the TXT as a second
 * record" against "stop if it is not a single record". Both cannot be the
 * rule, so the rule is a closed SET: one CNAME, optionally one TXT, nothing
 * else, and a stop if the shape differs or if Vercel reports a conflicting
 * record already in the zone.
 */
export function recordSet(
  config: {
    recommendedCNAME?: unknown;
    conflicts?: unknown;
    acceptedChallenges?: unknown;
  },
  verification: unknown,
): RecordSet {
  const cname = recordFrom(config);
  const challenge = challengeFrom(verification);
  const conflicts = Array.isArray(config.conflicts)
    ? config.conflicts.length
    : 0;
  const records = [cname, challenge].filter((r): r is DnsRecord => r !== null);
  return {
    records,
    ok:
      cname !== null &&
      records.length >= 1 &&
      records.length <= 2 &&
      records.filter((r) => r.type === "CNAME").length === 1 &&
      records.filter((r) => r.type === "TXT").length <= 1 &&
      conflicts === 0,
    conflicts,
  };
}

/**
 * The DELETE this phase may issue, as a VALUE rather than a call.
 *
 * Built and returned so it can be asserted in a test without a live request:
 * the reviewer's condition is that the builder can never select the generated
 * hostname, another project, or a name from anywhere else. The project id is
 * bound to the one proved in this run, so a detach cannot wander to another
 * project even with a correct hostname.
 */
export function detachRequest(
  projectId: string,
  provedProjectId: string,
): { method: "DELETE"; path: string } | null {
  if (projectId !== provedProjectId || projectId.length === 0) return null;
  if (!mayDetach(TARGET_DOMAIN)) return null;
  return {
    method: "DELETE",
    path: `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(TARGET_DOMAIN)}`,
  };
}

// ------------------------------------------------------------ the two calls

export async function attach(
  projectId: string,
  token: string,
): Promise<Record<string, unknown>> {
  return vercelApi<Record<string, unknown>>(
    `/v10/projects/${projectId}/domains`,
    token,
    { method: "POST", body: { name: TARGET_DOMAIN } },
  );
}

/**
 * The rollback lever. Refuses anything but our one hostname, in its own body,
 * so that "which domain" is never a value that travelled from somewhere else.
 */
export async function detach(
  projectId: string,
  provedProjectId: string,
  token: string,
): Promise<void> {
  const request = detachRequest(projectId, provedProjectId);
  if (!request) {
    throw new Error("refusing: that is not this slice's hostname and project");
  }
  await vercelApi(request.path, token, { method: request.method });
}

export async function domainsOf(
  projectId: string,
  token: string,
): Promise<DomainRow[]> {
  const answer = await vercelApi<{ domains?: DomainRow[] }>(
    `/v9/projects/${projectId}/domains?limit=100`,
    token,
  );
  return answer.domains ?? [];
}

/**
 * The AUTHORITATIVE configuration for the hostname.
 *
 * Measured read-only 2026-08-11 against the domain this project already has:
 * `/v9/projects/<id>/domains/<name>/config` does NOT answer, and
 * `/v6/domains/<name>/config` does, carrying `recommendedCNAME`,
 * `recommendedIPv4`, `misconfigured`, `conflicts` and `acceptedChallenges`.
 * The project-scoped record carries `verified` - which is OWNERSHIP, a
 * different question from whether DNS is configured.
 */
export async function domainConfig(
  token: string,
): Promise<Record<string, unknown>> {
  return vercelApi<Record<string, unknown>>(
    `/v6/domains/${TARGET_DOMAIN}/config`,
    token,
  );
}

/** The project-scoped record, whose `verified` is about ownership only. */
export async function projectDomain(
  projectId: string,
  token: string,
): Promise<Record<string, unknown>> {
  return vercelApi<Record<string, unknown>>(
    `/v9/projects/${projectId}/domains/${TARGET_DOMAIN}`,
    token,
  );
}
