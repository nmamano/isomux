// Enterprise seats routes (opIds office.enterprise.*): the Settings -> Enterprise
// section's reads and writes over server/enterprise-seats.ts. Owner-only by
// the route table. No route returns or logs the secret.

import {
  fail,
  ok,
  type HandlerErrorStatus,
  type RouteHandler,
} from "./routes/executor.ts";
import {
  ENTERPRISE_ERROR_CODES,
  type EnterpriseOutcome,
  type EnterpriseRefusal,
  type EnterpriseSeats,
} from "./enterprise-seats.ts";

export interface EnterpriseSeatsRouteDeps {
  seats: () => EnterpriseSeats;
}

const STATUS: Record<EnterpriseRefusal, HandlerErrorStatus> = {
  seats_full: 409,
  bad_secret: 403,
  not_signed: 403,
  rate_limited: 429,
  secret_needed: 409,
  // The service could not read our request: our bug, not the owner's.
  bad_request: 502,
  unreachable: 503,
  invalid_secret: 400,
  off: 409,
};

export type EnterpriseRefusalOutcome = Exclude<
  EnterpriseOutcome<unknown>,
  { ok: true }
>;

export function enterpriseRefusalMessage(
  refusal: EnterpriseRefusalOutcome,
): string {
  switch (refusal.reason) {
    case "seats_full":
      return refusal.seats !== undefined && refusal.inUse !== undefined
        ? `The enterprise license is full: ${refusal.inUse} of ${refusal.seats} seats are in use. IT can add seats on the enterprise account.`
        : "The enterprise license is full. IT can add seats on the enterprise account.";
    case "bad_secret":
      return "Isomux did not accept the enterprise secret. Paste the current one from the enterprise account.";
    case "not_signed":
      return "The enterprise account has no signed agreement yet.";
    case "rate_limited":
      return "Too many seat requests. Try again in a minute.";
    case "secret_needed":
      return "Paste the enterprise secret in Settings -> Enterprise before you add members.";
    case "bad_request":
      return "The seat service could not read the office's request.";
    case "unreachable":
      return "Could not reach Isomux to check the secret. Try again.";
    case "invalid_secret":
      return "This is not an enterprise secret. Copy it again from the enterprise account.";
    case "off":
      return "Turn on the Enterprise Contract box first.";
  }
}

// The Enterprise Contract lock refuses a message to an agent (the
// officeNotEnterpriseLocked precondition). The UI shows its own catalog line
// for the code (ui/send-failure.ts).
export function enterpriseLockedResult() {
  return fail(
    409,
    ENTERPRISE_ERROR_CODES.secret_needed,
    "This office is marked as an Enterprise office, but it is not tied to a valid contract. Contact IT at your company. If you are IT, contact llc@isomux.com.",
  );
}

// A refused seat as a route error, for every member add path.
export function enterpriseRefusalResult(refusal: EnterpriseRefusalOutcome) {
  return fail(
    enterpriseRefusalStatus(refusal),
    ENTERPRISE_ERROR_CODES[refusal.reason],
    enterpriseRefusalMessage(refusal),
  );
}

export const enterpriseRefusalStatus = (
  refusal: EnterpriseRefusalOutcome,
): HandlerErrorStatus => STATUS[refusal.reason];

const hosted = () =>
  fail(403, "hosted", "Hosted offices have no Enterprise Contract setting.");

export function enterpriseSeatsHandlers(
  deps: EnterpriseSeatsRouteDeps,
): Record<string, RouteHandler> {
  return {
    "office.enterprise.get": () => ok(deps.seats().view()),

    "office.enterprise.setEnabled": async (ctx) => {
      const seats = deps.seats();
      if (!seats.available()) return hosted();
      const enabled = (ctx.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean")
        return fail(400, "invalid_request", "enabled must be a boolean");
      return ok(await seats.setEnabled(enabled));
    },

    "office.enterprise.setSecret": async (ctx) => {
      const seats = deps.seats();
      if (!seats.available()) return hosted();
      const secret = (ctx.body as { secret?: unknown } | undefined)?.secret;
      if (typeof secret !== "string")
        return fail(400, "invalid_request", "secret must be a string");
      const r = await seats.pasteSecret(secret);
      return r.ok ? ok(r.value) : enterpriseRefusalResult(r);
    },

    "office.enterprise.check": async () => ok(await deps.seats().checkIn()),
  };
}
