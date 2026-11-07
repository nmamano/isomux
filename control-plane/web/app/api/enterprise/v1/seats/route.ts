import { createHash } from "node:crypto";
import {
  clientKey,
  enterpriseSeatIpLimiter,
  enterpriseSeatSecretLimiter,
  type Limiter,
} from "../../../../../lib/rate-limit.server";
import { recordSeatsFor } from "../../../../../lib/services.server";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

const STATUS = {
  bad_request: 400,
  bad_secret: 401,
  not_signed: 403,
  seats_full: 409,
} as const;

function refusal(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, ...extra },
    { status, headers: { ...NO_STORE, ...headers } },
  );
}

/** 429 {error:"rate_limited"} when `key` is past the limiter's quota. */
function limited(limiter: Limiter, key: string): Response | null {
  const decision = limiter.take(key);
  return decision.allowed
    ? null
    : refusal(
        "rate_limited",
        429,
        {},
        {
          "retry-after": String(decision.retryAfterSeconds),
        },
      );
}

/**
 * The seat service: an office takes a seat before it adds a member (add:true)
 * and reports its member count (add:false), with the enterprise account's
 * secret as its only credential (control-plane/enterprise.ts recordSeats).
 * Server to server: no session and no origin check.
 */
export async function POST(request: Request): Promise<Response> {
  const byAddress = limited(
    enterpriseSeatIpLimiter,
    clientKey(request.headers),
  );
  if (byAddress) return byAddress;
  const match = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) return refusal("bad_secret", 401);
  const secret = match[1];
  // Keyed on a hash of the whole bearer, never on the enterprise id in it:
  // an id key would let anyone who knows the id spend a customer's quota.
  const bySecret = limited(
    enterpriseSeatSecretLimiter,
    createHash("sha256").update(secret).digest("hex"),
  );
  if (bySecret) return bySecret;
  // undefined when the body does not parse: recordSeats checks the secret
  // first, so a caller without it learns nothing about the body.
  const body: unknown = await request.json().catch(() => undefined);
  const result = await recordSeatsFor(secret, body);
  if (result.ok) {
    const { ok: _ok, ...answer } = result;
    return Response.json(answer, { headers: NO_STORE });
  }
  if (result.reason === "seats_full") {
    return refusal(result.reason, STATUS.seats_full, {
      seats: result.seats,
      inUse: result.inUse,
    });
  }
  return refusal(result.reason, STATUS[result.reason]);
}
