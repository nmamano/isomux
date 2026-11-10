// POST /api/billing/portal: a Stripe portal session for the signed-in owner
// of a Hosted office, where the card is updated and the open invoice paid
// (task 87e0251d). It writes nothing of ours, but it spends a Stripe call, so
// it takes the same origin check and session as every other writing route.
// An office that is not yours and one that does not exist answer alike: a
// different answer would tell a stranger which office ids exist.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "next-auth";
import * as authModule from "../../../../auth";
import * as servicesModule from "../../../../lib/services.server";
import * as requestModule from "../../../../lib/i18n/request.server";

type PortalResult = Awaited<ReturnType<typeof servicesModule.hostedPortalFor>>;

let session: Session | null = null;
let trusted = true;
let answer: PortalResult = {
  ok: true,
  url: "https://billing.stripe.example/s/1",
};
/** The portal service's calls, as [accountId, instanceId]. */
let calls: [string, string][] = [];

const TRUSTED = "https://cloud.example";

// Outside a Next request `auth()` throws, and the services need a database.
// A module mock outlives this file in Bun's shared test process, so the real
// exports are copied out first and put back when this file is done.
const realAuth = { ...authModule };
const realServices = { ...servicesModule };
const realRequest = { ...requestModule };
await mock.module("../../../../auth", () => ({
  ...realAuth,
  auth: async () => session,
}));
await mock.module("../../../../lib/services.server", () => ({
  ...realServices,
  checkTrustedOrigin: async (origin: string | null) =>
    trusted && origin === TRUSTED
      ? { ok: true }
      : { ok: false, reason: "untrusted origin" },
  hostedPortalFor: async (accountId: string, instanceId: string) => {
    calls.push([accountId, instanceId]);
    return answer;
  },
}));
await mock.module("../../../../lib/i18n/request.server", () => ({
  ...realRequest,
  languageForRequest: async () => "en",
}));
afterAll(async () => {
  await mock.module("../../../../auth", () => realAuth);
  await mock.module("../../../../lib/services.server", () => realServices);
  await mock.module("../../../../lib/i18n/request.server", () => realRequest);
});

const { POST } = await import("./route");

function post(
  body: unknown,
  origin: string | null = TRUSTED,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (origin !== null) headers.origin = origin;
  return POST(
    new Request("https://cloud.example/api/billing/portal", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  session = {
    accountId: "account-1",
    user: { email: "owner@example.com" },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };
  trusted = true;
  answer = { ok: true, url: "https://billing.stripe.example/s/1" };
  calls = [];
});

describe("POST /api/billing/portal", () => {
  test("the owner gets the session URL for the office they asked about", async () => {
    const response = await post({ instanceId: "inst-1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: "https://billing.stripe.example/s/1",
    });
    expect(calls).toEqual([["account-1", "inst-1"]]);
  });

  test("a foreign origin, a signed-out visitor and a request with no office reach no Stripe call", async () => {
    const foreign = await post(
      { instanceId: "inst-1" },
      "https://evil.example",
    );
    expect(foreign.status).toBe(403);
    const missing = await post({ instanceId: "inst-1" }, null);
    expect(missing.status).toBe(403);

    session = null;
    const signedOut = await post({ instanceId: "inst-1" });
    expect(signedOut.status).toBe(401);

    session = {
      accountId: "account-1",
      user: { email: "owner@example.com" },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    };
    for (const body of [{}, { instanceId: "" }, { instanceId: 7 }, null]) {
      const bad = await post(body);
      expect([body, bad.status]).toEqual([body, 400]);
    }
    expect(calls).toEqual([]);
  });

  test("an office that is not yours answers exactly like one that does not exist", async () => {
    answer = { ok: false, reason: "not_yours" };
    const foreign = await post({ instanceId: "inst-1" });
    const foreignAnswer = [foreign.status, await foreign.text()];
    answer = { ok: false, reason: "no_subscription" };
    const absent = await post({ instanceId: "inst-2" });
    const absentAnswer = [absent.status, await absent.text()];
    // The enabling condition: both reached the service, and both refused.
    expect(calls.length).toBe(2);
    expect(foreign.status).not.toBe(200);
    expect(foreignAnswer).toEqual(absentAnswer);
    expect(JSON.parse(String(foreignAnswer[1])).ok).toBe(false);
  });

  test("a session Stripe refuses is a refusal, not a URL", async () => {
    answer = { ok: false, reason: "stripe" };
    const response = await post({ instanceId: "inst-1" });
    expect(response.status).not.toBe(200);
    const body = (await response.json()) as { ok: boolean; url?: unknown };
    expect(body.ok).toBe(false);
    expect(body.url).toBeUndefined();
  });
});
