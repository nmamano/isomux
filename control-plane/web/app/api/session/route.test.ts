// What /api/session tells the browser, and what each question costs.
//
// Three callers ask it. The sign-in guard asks the bare question and must not
// wait on the store. The top bar asks `?account=1`: it shows the account's
// address, which an email change moves after the session was issued, so it
// reads the account and nothing else. The landing asks `?offices=1` for its
// cards, and each card carries the office's plan.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "next-auth";
import * as authModule from "../../../auth";
import * as servicesModule from "../../../lib/services.server";
import type { ProgressView } from "../../../lib/services.server";
import type { SessionView } from "../../../lib/session-view";

let session: Session | null = null;
// Each stand-in service records its name when the route calls it.
let calls: string[] = [];

const SESSION_EMAIL = "old@example.com";
const ACCOUNT_EMAIL = "new@example.com";

const tier: ProgressView["tier"] = {
  label: "Entry",
  specification: "4 vCPU, 8 GB RAM, 100 GB SSD",
  customerPrice: { amounts: { USD: 9, EUR: 8 }, billingPeriod: "month" },
  currency: "EUR" as const,
};

// Only the fields the route maps are read; the rest of the projection never
// reaches the browser.
const office = {
  instanceId: "i-1",
  officeName: "acme",
  hostname: "acme.isomux.app",
  ready: true,
  ended: false,
  tier,
} as unknown as ProgressView;

// Outside a Next request `auth()` throws, and the services need a database.
// A module mock outlives this file in Bun's shared test process, so the real
// exports are copied out first and put back when this file is done.
const realAuth = { ...authModule };
const realServices = { ...servicesModule };
await mock.module("../../../auth", () => ({
  ...realAuth,
  auth: async () => session,
}));
await mock.module("../../../lib/services.server", () => ({
  ...realServices,
  officesForAccount: async () => {
    calls.push("officesForAccount");
    return [office];
  },
  accountSettings: async () => {
    calls.push("accountSettings");
    return { email: ACCOUNT_EMAIL, google: false };
  },
}));
afterAll(async () => {
  await mock.module("../../../auth", () => realAuth);
  await mock.module("../../../lib/services.server", () => realServices);
});

const { GET } = await import("./route");

async function ask(query: string): Promise<SessionView> {
  const response = await GET(
    new Request(`http://localhost:3000/api/session${query}`),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as SessionView;
}

beforeEach(() => {
  session = {
    accountId: "account-1",
    user: { email: SESSION_EMAIL },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };
  calls = [];
});

describe("GET /api/session", () => {
  test("signed out: no store work, whatever was asked", async () => {
    session = null;
    for (const query of ["", "?account=1", "?offices=1"]) {
      expect([query, await ask(query)]).toEqual([query, { signedIn: false }]);
    }
    expect(calls).toEqual([]);
  });

  test("the bare probe answers from the session alone", async () => {
    expect(await ask("")).toEqual({
      signedIn: true,
      email: SESSION_EMAIL,
      offices: null,
    });
    expect(calls).toEqual([]);
  });

  test("?account=1 answers the account's address and reads no offices", async () => {
    expect(await ask("?account=1")).toEqual({
      signedIn: true,
      email: ACCOUNT_EMAIL,
      offices: null,
    });
    expect(calls).toEqual(["accountSettings"]);
  });

  test("?offices=1 lists each office with its plan", async () => {
    const view = await ask("?offices=1");
    expect(view).toEqual({
      signedIn: true,
      email: ACCOUNT_EMAIL,
      offices: [
        {
          instanceId: "i-1",
          officeName: "acme",
          hostname: "acme.isomux.app",
          ready: true,
          ended: false,
          plan: tier,
        },
      ],
    });
    expect(calls.sort()).toEqual(["accountSettings", "officesForAccount"]);
  });
});
