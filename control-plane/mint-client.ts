// The web app's half of the invite seam.
//
// Deliberately tiny, and deliberately importing nothing from the control plane
// except types: this module is IN the public app's bundle, so anything it
// reaches, the app reaches. It speaks HTTP to the provisioner and knows nothing
// about stores, drivers, keys or operations - it cannot even name a kind.
//
// The URL it returns is handed to the page that asked and is never written
// down: no console, no cache, no cookie, no store. The caller renders it once.

import type { FetchResult } from "./mint-seam.ts";

export type { FetchResult };

export interface MintSeamConfig {
  /** Where the provisioner answers. From the environment, because it genuinely
   * differs per deployment - loopback here, a private surface once deployed. */
  baseUrl: string;
  token: string;
}

/**
 * Read the seam's configuration, or say why there is none.
 *
 * Returning null rather than throwing is what lets the dashboard say "this
 * deployment cannot hand out invites" instead of showing a button that 500s.
 */
export function seamConfigFrom(
  env: Record<string, string | undefined>,
): MintSeamConfig | null {
  const baseUrl = env.CONTROL_PLANE_MINT_URL;
  const token = env.CONTROL_PLANE_MINT_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/**
 * Collect a minted invite, once.
 *
 * Every failure is a typed status rather than a throw, because every one of
 * them is a sentence the customer needs to read. A transport failure is
 * reported as `expired_or_lost` ONLY if the provisioner said so - a network
 * error is its own status, because "we could not ask" and "it is gone" lead to
 * different advice.
 */
export async function fetchInviteFromSeam(
  config: MintSeamConfig,
  req: { accountId: string; instanceId: string; operationId: string },
  timeoutMs = 10_000,
): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(new URL("/internal/invite", config.baseUrl).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // The detail is deliberately dropped: a fetch error message can carry the
    // target URL and credentials-adjacent context into a customer-facing
    // string, and none of it helps the person reading it.
    return {
      status: "failed",
      reason: "we could not reach the service that prepares invites",
    };
  }
  if (res.status === 401) {
    return {
      status: "failed",
      reason: "this deployment is not configured to hand out invites",
    };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { status: "failed", reason: "the invite service answered oddly" };
  }
  const status = (parsed as { status?: unknown } | null)?.status;
  if (status === "ready") {
    const url = (parsed as { url?: unknown }).url;
    if (typeof url !== "string" || url.length === 0) {
      return { status: "failed", reason: "the invite service answered oddly" };
    }
    return { status: "ready", url };
  }
  const known = [
    "not_ready",
    "expired_or_lost",
    "window_closed",
    "failed",
    "forbidden",
  ] as const;
  const match = known.find((s) => s === status);
  if (!match) {
    return { status: "failed", reason: "the invite service answered oddly" };
  }
  const reason = (parsed as { reason?: unknown }).reason;
  return {
    status: match,
    reason: typeof reason === "string" ? reason : "",
  };
}
