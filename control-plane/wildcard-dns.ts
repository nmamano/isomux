import { createHash } from "node:crypto";
import type { DnsAnswers } from "./deprovision.ts";

export const WILDCARD_DNS_RUNG = "app-wildcard-dns";

/**
 * A stable, unguessable child name for proving that the wildcard reaches this
 * instance. Stability matters across retries: drawing a new label would turn
 * every retry into a fresh negative-cache lookup. The instance id is internal
 * and the digest keeps it out of public DNS.
 */
export function wildcardProbeHost(
  instanceId: string,
  officeHost: string,
): string {
  const digest = createHash("sha256")
    .update(instanceId)
    .digest("hex")
    .slice(0, 24);
  return `isomux-app-check-${digest}.${officeHost}`;
}

export type WildcardDnsVerdict =
  | { ready: true }
  | { ready: false; detail: "missing" | "wrong-a" | "aaaa" };

/** The wildcard is ready only when all traffic goes to the one box we own. */
export function wildcardDnsVerdict(
  answers: DnsAnswers,
  instanceIpv4: string,
): WildcardDnsVerdict {
  if (answers.aaaa.length > 0) return { ready: false, detail: "aaaa" };
  if (answers.a.length === 0) return { ready: false, detail: "missing" };
  if (answers.a.length !== 1 || answers.a[0] !== instanceIpv4) {
    return { ready: false, detail: "wrong-a" };
  }
  return { ready: true };
}

export function sameWildcardAnswers(
  evidence: Record<string, unknown>,
  answers: DnsAnswers,
): boolean {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? [...value].sort() : value;
  return (
    JSON.stringify(sorted(evidence.a ?? null)) ===
      JSON.stringify([...answers.a].sort()) &&
    JSON.stringify(sorted(evidence.aaaa ?? null)) ===
      JSON.stringify([...answers.aaaa].sort())
  );
}

/** One string for both raising and clearing the operator condition. */
export function wildcardDnsReasonFor(
  officeHost: string,
  instanceIpv4: string,
): string {
  return (
    `the wildcard DNS record *.${officeHost} must point only at ` +
    `${instanceIpv4} before app links can open; ` +
    `create the office A record and wildcard A record together`
  );
}
