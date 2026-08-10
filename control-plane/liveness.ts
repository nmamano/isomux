// Liveness as a probe ladder, not one boolean.
//
// Each rung fails differently - our DNS, their certificate, a dead service -
// and the distinction is what makes the support answer right. A box that is
// "down" because the A record has not propagated needs a completely different
// response from one whose office is not serving.
//
// /readyz is unauthenticated and rate-limited at 30/min per caller, so a poll
// every few seconds during provisioning is well inside budget.

import * as dns from "node:dns/promises";
import * as net from "node:net";

export type Rung = "dns" | "wrong-box" | "tcp" | "tls" | "readyz" | "ok";

/**
 * Three consecutive failures before we call an office unreachable (design:
 * "Three strikes before we call it unreachable"). One failed probe is a flap -
 * a DNS hiccup here, a dropped SYN there - and telling a customer their office
 * is down on the strength of one is how a dashboard trains people to ignore it.
 */
export const LIVENESS_STRIKES = 3;

/** How often a live office is probed. /readyz is rate-limited at 30/min per
 * caller, so this is two orders of magnitude inside budget, and it is fast
 * enough that a reboot's dip and recovery are both visible on the dashboard. */
export const LIVENESS_INTERVAL_MS = 60_000;

/** How long one prober may hold the right to check an office. Longer than any
 * single probe can take (DNS + connect + fetch are each bounded well under
 * this), so a crashed prober's claim expires rather than stalling the ladder. */
export const LIVENESS_CLAIM_MS = 5 * 60_000;

/**
 * The strike count after a result. Consecutive is the whole point: any `ok`
 * resets to zero, so three strikes means three failures in a row rather than
 * three failures ever.
 */
export function strikesAfter(previous: number, rung: Rung): number {
  return rung === "ok" ? 0 : previous + 1;
}

export interface LivenessResult {
  /** The furthest rung reached. "ok" means every rung passed. */
  rung: Rung;
  detail: string;
  ipv4?: string;
}

export interface LivenessDeps {
  lookup?: (host: string) => Promise<string>;
  connect?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Only the call shape is needed, not fetch's static surface. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

function tcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error("timed out")));
    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
  });
}

/**
 * Walk the ladder for `host`, and refuse to bless a box that is not ours.
 *
 * `expectIpv4` is not optional in spirit. `*.test.isomux.app` already resolves
 * via a wildcard, and a stale or wildcard A record plus a healthy office
 * somewhere else is enough for every rung below to pass against a machine we
 * did not build. Acceptance has to mean "this box", so the resolved address is
 * checked against the instance's own address before anything else counts.
 */
export async function probeLiveness(
  host: string,
  deps: LivenessDeps = {},
  expectIpv4?: string,
): Promise<LivenessResult> {
  const lookup =
    deps.lookup ??
    (async (h: string) => (await dns.lookup(h, { family: 4 })).address);
  const connect = deps.connect ?? tcpConnect;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let ipv4: string;
  try {
    ipv4 = await lookup(host);
  } catch (err) {
    return { rung: "dns", detail: `name does not resolve: ${messageOf(err)}` };
  }

  if (expectIpv4 && ipv4 !== expectIpv4) {
    return {
      rung: "wrong-box",
      detail:
        `${host} resolves to ${ipv4}, not this instance's ${expectIpv4}. ` +
        `A wildcard or stale record can point at a healthy office that is not ours, ` +
        `so nothing below this rung is allowed to count.`,
      ipv4,
    };
  }

  try {
    await connect(host, 443, 10_000);
  } catch (err) {
    return {
      rung: "tcp",
      detail: `443 does not accept: ${messageOf(err)}`,
      ipv4,
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(`https://${host}/readyz`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // A TLS failure lands here, and during provisioning it usually means Caddy
    // has not obtained a certificate yet - which is expected until the A record
    // exists, because HTTP-01 cannot complete without it.
    return {
      rung: "tls",
      detail: `TLS did not complete: ${messageOf(err)}`,
      ipv4,
    };
  }

  if (res.status !== 200) {
    return {
      rung: "readyz",
      detail: `/readyz returned HTTP ${res.status}`,
      ipv4,
    };
  }
  return { rung: "ok", detail: "office is serving", ipv4 };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
