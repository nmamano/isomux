// The account routes: asking for an email change, confirming it from the link,
// and removing the Google sign-in (task 887bfb07). The link applies only for
// the account's own session, and a change that applied keeps that session
// while it ends the account's others (task 4fe8a83c).
//
// Every dependency is passed in except the origin check, which is the real one.
// The store and Stripe ends are stand-ins that record what they were asked, so
// the properties here are the route's own: who may ask, where the link goes,
// what the link alone may do, and in which order Stripe, the account and the
// notice move.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  handleEmailChangeConfirm,
  handleEmailChangeRequest,
  handleGoogleRemoval,
  type EmailChangeConfirmDeps,
  type EmailChangeRequestDeps,
  type GoogleRemovalDeps,
} from "./account-email-request.server";
import { createLimiter, type Limiter } from "./rate-limit.server";
import {
  createEmailChangeTokens,
  type EmailChangeClaims,
  type LinkTokens,
} from "./signin-link.server";
import { SUPPORT_EMAIL } from "./support-email";

const ORIGIN = "https://hosted.example.com";
const CONTAINER = "http://localhost:3000";
const KEY = "re_account_test_key_4be1a0";
const SECRET = "account-route-secret-0123456789abcdef";
const ACCOUNT = "acct-customer";
const OLD = "customer.name@gmail.com";
const NEW = "work@example.com";

beforeEach(() => {
  // Read per request by the real origin check.
  process.env.AUTH_URL = ORIGIN;
});

// The customer cannot fix a route the deployment left unconfigured, so the
// refusal must give them somewhere to go.
function expectSupportNamed(body: string): void {
  expect(body).toContain(SUPPORT_EMAIL);
}

function wide(): Limiter {
  return createLimiter({ limit: 1000, windowMs: 600_000, maxKeys: 100 });
}

function tight(limit: number): Limiter {
  return createLimiter({ limit, windowMs: 600_000, maxKeys: 100 });
}

let client = 10;

function post(
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${CONTAINER}${pathname}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${client++}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ------------------------------------------------------------------ request

type RequestMail = Parameters<EmailChangeRequestDeps["sendMail"]>[0];

function requestHarness(over: Partial<EmailChangeRequestDeps> = {}) {
  const mails: RequestMail[] = [];
  const refusalAsked: [string, string][] = [];
  const tokens = createEmailChangeTokens({ secret: SECRET });
  let signedIn: string | null = ACCOUNT;
  const deps: EmailChangeRequestDeps = {
    apiKey: KEY,
    tokens,
    accountId: async () => signedIn,
    ipLimiter: wide(),
    accountLimiter: wide(),
    addressLimiter: wide(),
    refusal: async (accountId, newEmail) => {
      refusalAsked.push([accountId, newEmail]);
      return null;
    },
    sendMail: async (mail) => {
      mails.push(mail);
      return { ok: true };
    },
    ...over,
  };
  return {
    deps,
    mails,
    refusalAsked,
    tokens,
    signInAs: (id: string | null) => (signedIn = id),
  };
}

const ask = (body: unknown, headers?: Record<string, string>) =>
  post("/api/account/email", body, headers);

describe("asking for an email change", () => {
  test("mails one link to the NEW address, on the deployment origin, carrying this account and that address", async () => {
    const { deps, mails, refusalAsked, tokens } = requestHarness();
    const response = await handleEmailChangeRequest(
      ask({ email: "  Work@Example.COM " }, { "accept-language": "es-ES" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(refusalAsked).toEqual([[ACCOUNT, NEW]]);
    expect(mails.length).toBe(1);
    const [mail] = mails;
    expect(mail.to).toBe(NEW);
    expect(mail.language).toBe("es");
    const link = new URL(mail.link);
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/account/email");
    // The token rides in the fragment only: a query reaches logs and Referers.
    expect(link.search).toBe("");
    const token = new URLSearchParams(link.hash.slice(1)).get("token") ?? "";
    const checked = tokens.check(token);
    expect(checked.ok && checked.claims).toEqual({ a: ACCOUNT, e: NEW });
  });

  test("a visitor who is not signed in gets a 401 and nothing is mailed", async () => {
    const h = requestHarness();
    h.signInAs(null);
    const response = await handleEmailChangeRequest(
      ask({ email: NEW }),
      h.deps,
    );
    expect(response.status).toBe(401);
    expect(h.mails.length).toBe(0);
  });

  test("a post from another site, or with no origin, is a 403 and nothing is mailed", async () => {
    const { deps, mails } = requestHarness();
    const foreign = await handleEmailChangeRequest(
      ask({ email: NEW }, { origin: "https://evil.example.net" }),
      deps,
    );
    const request = ask({ email: NEW });
    request.headers.delete("origin");
    const missing = await handleEmailChangeRequest(request, deps);
    expect([foreign.status, missing.status]).toEqual([403, 403]);
    expect(mails.length).toBe(0);
  });

  test("without the mail key or the token secret the route is unavailable, and says whom to write to", async () => {
    for (const over of [{ apiKey: undefined }, { tokens: null }]) {
      const { deps, mails } = requestHarness(over);
      const response = await handleEmailChangeRequest(
        ask({ email: NEW }),
        deps,
      );
      expect(response.status).toBe(503);
      expectSupportNamed(await response.text());
      expect(mails.length).toBe(0);
    }
  });

  test("a body that is not one address is a 400", async () => {
    const { deps, mails } = requestHarness();
    for (const body of [{ email: "nope" }, { email: [NEW] }, {}, "not json"]) {
      expect((await handleEmailChangeRequest(ask(body), deps)).status).toBe(
        400,
      );
    }
    expect(mails.length).toBe(0);
  });

  test("the account's own address is a 400 and another account's is a 409, both before any mail", async () => {
    for (const [refusal, status] of [
      ["unchanged", 400],
      ["taken", 409],
    ] as const) {
      const { deps, mails } = requestHarness({ refusal: async () => refusal });
      const response = await handleEmailChangeRequest(
        ask({ email: NEW }),
        deps,
      );
      expect(response.status).toBe(status);
      expect(mails.length).toBe(0);
    }
  });

  test("one account past its quota is refused from every client", async () => {
    const { deps, mails } = requestHarness({ accountLimiter: tight(2) });
    const statuses: number[] = [];
    // A fresh client address and a fresh target per request: only the
    // account quota can refuse.
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      statuses.push(
        (await handleEmailChangeRequest(ask({ email }), deps)).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(mails.length).toBe(2);
  });

  test("one target address past its quota is refused from every account, however it is written", async () => {
    const h = requestHarness({ addressLimiter: tight(2) });
    const statuses: number[] = [];
    for (const [account, email] of [
      ["acct-1", "victim@example.com"],
      ["acct-2", "Victim@Example.com"],
      ["acct-3", " VICTIM@example.COM"],
    ]) {
      h.signInAs(account);
      statuses.push(
        (await handleEmailChangeRequest(ask({ email }), h.deps)).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(h.mails.length).toBe(2);
  });

  test("one client past its quota is refused, whatever it asks for", async () => {
    const h = requestHarness({ ipLimiter: tight(2) });
    const ip = { "x-forwarded-for": "203.0.113.9" };
    const statuses: number[] = [];
    for (const [account, email] of [
      ["acct-1", "a@example.com"],
      ["acct-2", "b@example.com"],
      ["acct-3", "c@example.com"],
    ]) {
      h.signInAs(account);
      statuses.push(
        (await handleEmailChangeRequest(ask({ email }, ip), h.deps)).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("a mail the sender refuses or cannot deliver is a 502", async () => {
    for (const sendMail of [
      async () => ({ ok: false as const, reason: "provider said no" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const { deps } = requestHarness({ sendMail });
      expect(
        (await handleEmailChangeRequest(ask({ email: NEW }), deps)).status,
      ).toBe(502);
    }
  });
});

// ------------------------------------------------------------------ confirm

interface Recorder {
  events: string[];
  /** The store reads before any write: the refusal check, then the Stripe
   * customers. */
  reads: string[];
  stripeCalls: { customer: string; email: string; key: string }[];
  changes: { accountId: string; newEmail: string }[];
  notices: { to: string; newEmail: string }[];
  /** One entry per keepSession call: how many changes had applied by then. */
  kept: number[];
}

function confirmHarness(
  over: Partial<EmailChangeConfirmDeps> = {},
  tokens: LinkTokens<EmailChangeClaims> = createEmailChangeTokens({
    secret: SECRET,
  }),
) {
  const r: Recorder = {
    events: [],
    reads: [],
    stripeCalls: [],
    changes: [],
    notices: [],
    kept: [],
  };
  let signedIn: string | null = ACCOUNT;
  const deps: EmailChangeConfirmDeps = {
    apiKey: KEY,
    tokens,
    accountId: async () => signedIn,
    ipLimiter: wide(),
    refusal: async () => {
      r.reads.push("refusal");
      return null;
    },
    stripeCustomers: async () => {
      r.reads.push("customers");
      return ["cus_a", "cus_b"];
    },
    updateStripeEmail: async (customer, email, key) => {
      r.events.push(`stripe:${customer}`);
      r.stripeCalls.push({ customer, email, key });
      return "updated";
    },
    change: async (args) => {
      r.events.push("change");
      r.changes.push(args);
      return { ok: true, oldEmail: OLD, changed: true };
    },
    sendNotice: async (mail) => {
      r.events.push("notice");
      r.notices.push({ to: mail.to, newEmail: mail.newEmail });
      return { ok: true };
    },
    keepSession: async () => {
      r.kept.push(r.changes.length);
    },
    ...over,
  };
  const link = (claims: EmailChangeClaims = { a: ACCOUNT, e: NEW }) =>
    tokens.create(claims);
  return {
    deps,
    r,
    tokens,
    link,
    signInAs: (id: string | null) => (signedIn = id),
  };
}

const confirm = (body: unknown, headers?: Record<string, string>) =>
  post("/api/account/email/confirm", body, headers);

async function emailOf(response: Response): Promise<unknown> {
  return ((await response.json()) as { email?: unknown }).email;
}

describe("confirming an email change", () => {
  test("with the account's own session: Stripe follows first, then the account, then the notice to the OLD address", async () => {
    const { deps, r, tokens, link } = confirmHarness();
    const token = link();
    // An address in the body is not the link's address and is ignored: the
    // token alone names the account and the address.
    const response = await handleEmailChangeConfirm(
      confirm({ token, email: "attacker@example.net" }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await emailOf(response)).toBe(NEW);
    expect(r.events).toEqual([
      "stripe:cus_a",
      "stripe:cus_b",
      "change",
      "notice",
    ]);
    expect(r.stripeCalls.map((c) => c.email)).toEqual([NEW, NEW]);
    expect(r.changes).toEqual([{ accountId: ACCOUNT, newEmail: NEW }]);
    expect(r.notices).toEqual([{ to: OLD, newEmail: NEW }]);
    // The change ended the account's other sessions; this one is kept, once,
    // and only after the change applied.
    expect(r.kept).toEqual([1]);
    // The link is spent.
    expect(tokens.check(token)).toEqual({ ok: false, reason: "used" });
    const again = await handleEmailChangeConfirm(confirm({ token }), deps);
    expect(again.status).toBe(400);
    expect(r.changes.length).toBe(1);
    expect(r.kept).toEqual([1]);
  });

  test("without a session it is a 401, and with another account's a 403: nothing is read or written and the link stays good", async () => {
    // The pre-claim this closes: account A asks to move to an address nobody
    // holds yet, and that inbox's owner presses the button.
    const h = confirmHarness();
    const token = h.link();
    const statuses: number[] = [];
    for (const session of [null, "acct-other"]) {
      h.signInAs(session);
      statuses.push(
        (await handleEmailChangeConfirm(confirm({ token }), h.deps)).status,
      );
    }
    expect(statuses).toEqual([401, 403]);
    expect(h.r.reads).toEqual([]);
    expect(h.r.events).toEqual([]);
    expect(h.r.kept).toEqual([]);
    expect(h.tokens.check(token).ok).toBe(true);

    // The session was the only thing missing: the same link applies for the
    // account that asked.
    h.signInAs(ACCOUNT);
    const applied = await handleEmailChangeConfirm(confirm({ token }), h.deps);
    expect(applied.status).toBe(200);
    expect(h.r.changes).toEqual([{ accountId: ACCOUNT, newEmail: NEW }]);
  });

  test("a session that cannot be kept does not fail a change that applied", async () => {
    const { deps, r, link } = confirmHarness({
      keepSession: async () => {
        throw new Error("the session store is down");
      },
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await emailOf(response)).toBe(NEW);
    expect(r.changes.length).toBe(1);
    expect(r.notices).toEqual([{ to: OLD, newEmail: NEW }]);
  });

  test("a Stripe failure is a 502 that changes nothing and leaves the link good; the retry replays the same Stripe keys", async () => {
    let stripeUp = false;
    const { deps, r, tokens, link } = confirmHarness({});
    const recordingUpdate = deps.updateStripeEmail;
    deps.updateStripeEmail = async (customer, email, key) => {
      if (!stripeUp && customer === "cus_b") {
        r.stripeCalls.push({ customer, email, key });
        return "failed";
      }
      return recordingUpdate(customer, email, key);
    };
    const token = link();

    const failed = await handleEmailChangeConfirm(confirm({ token }), deps);
    expect(failed.status).toBe(502);
    expect(r.changes).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(tokens.check(token).ok).toBe(true);
    const first = r.stripeCalls.map((c) => ({
      customer: c.customer,
      key: c.key,
    }));
    expect(first.map((c) => c.customer)).toEqual(["cus_a", "cus_b"]);
    // One key per customer.
    expect(first[0].key).not.toBe(first[1].key);

    stripeUp = true;
    r.stripeCalls.length = 0;
    const retried = await handleEmailChangeConfirm(confirm({ token }), deps);
    expect(retried.status).toBe(200);
    expect(r.changes.length).toBe(1);
    // A retry of one link is a replay at Stripe, customer by customer.
    expect(
      r.stripeCalls.map((c) => ({ customer: c.customer, key: c.key })),
    ).toEqual(first);
  });

  test("Stripe not configured (the update throws) is a 502 with the link still good", async () => {
    const { deps, r, tokens, link } = confirmHarness({
      updateStripeEmail: async () => {
        throw new Error("Stripe is not configured");
      },
    });
    const token = link();
    const response = await handleEmailChangeConfirm(confirm({ token }), deps);
    expect(response.status).toBe(502);
    expect(r.changes).toEqual([]);
    expect(tokens.check(token).ok).toBe(true);
  });

  test("a customer Stripe no longer has is skipped, and the change goes through", async () => {
    const { deps, r, link } = confirmHarness({
      updateStripeEmail: async (customer) => {
        r.events.push(`stripe:${customer}`);
        return customer === "cus_a" ? "missing" : "updated";
      },
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(r.events).toEqual([
      "stripe:cus_a",
      "stripe:cus_b",
      "change",
      "notice",
    ]);
  });

  test("two links for the same change write Stripe under different keys", async () => {
    // A key derived from the account and the address would replay the first
    // change's answer when the customer moves back and forth within Stripe's
    // 24 hours, and Stripe would keep the wrong address.
    const { deps, r, link } = confirmHarness({
      stripeCustomers: async () => ["cus_a"],
    });
    await handleEmailChangeConfirm(confirm({ token: link() }), deps);
    await handleEmailChangeConfirm(confirm({ token: link() }), deps);
    expect(r.stripeCalls.length).toBe(2);
    expect(r.stripeCalls[0].key).not.toBe(r.stripeCalls[1].key);
  });

  test("an address another account took since the link was sent is a 409 before Stripe is written", async () => {
    const { deps, r, link } = confirmHarness({ refusal: async () => "taken" });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(409);
    expect(r.events).toEqual([]);
  });

  test("an account that is gone is a 404 before Stripe is written", async () => {
    const { deps, r, link } = confirmHarness({
      refusal: async () => "no-account",
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(r.events).toEqual([]);
  });

  test("a link opened after the account already moved there is a success with no notice", async () => {
    const { deps, r, link } = confirmHarness({
      refusal: async () => "unchanged",
      change: async (args) => {
        r.events.push("change");
        r.changes.push(args);
        return { ok: true, oldEmail: NEW, changed: false };
      },
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await emailOf(response)).toBe(NEW);
    expect(r.notices).toEqual([]);
    // Nothing changed, so no session ended and none needs keeping.
    expect(r.kept).toEqual([]);
  });

  test("a change that finds the account already moved sends no notice", async () => {
    // Another link for the same address landed between this link's check and
    // its change: the old address was told once already.
    const { deps, r, link } = confirmHarness({
      change: async (args) => {
        r.events.push("change");
        r.changes.push(args);
        return { ok: true, oldEmail: NEW, changed: false };
      },
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(r.events).toEqual(["stripe:cus_a", "stripe:cus_b", "change"]);
    expect(r.notices).toEqual([]);
    expect(r.kept).toEqual([]);
  });

  test("the account losing the race after Stripe moved is a 409 with no notice", async () => {
    const { deps, r, link } = confirmHarness({
      change: async (args) => {
        r.events.push("change");
        r.changes.push(args);
        return { ok: false, code: "taken" };
      },
    });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(409);
    expect(r.events).toEqual(["stripe:cus_a", "stripe:cus_b", "change"]);
    expect(r.notices).toEqual([]);
    expect(r.kept).toEqual([]);
  });

  test("a notice that cannot be sent does not undo or fail the change", async () => {
    for (const sendNotice of [
      async () => ({ ok: false as const, reason: "provider said no" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const { deps, r, link } = confirmHarness({ sendNotice });
      const response = await handleEmailChangeConfirm(
        confirm({ token: link() }),
        deps,
      );
      expect(response.status).toBe(200);
      expect(r.changes.length).toBe(1);
    }
  });

  test("a sign-in link, a forged or expired link, or no link is a 400 that touches nothing", async () => {
    const { deps, r, tokens } = confirmHarness();
    const { createSignInTokens } = await import("./signin-link.server");
    const signInLink = createSignInTokens({ secret: SECRET }).create(NEW);
    const expired = tokens.create(
      { a: ACCOUNT, e: NEW },
      Date.now() - 3_600_000,
    );
    for (const body of [
      { token: signInLink },
      { token: expired },
      { token: "abc.def" },
      {},
      "not json",
    ]) {
      const response = await handleEmailChangeConfirm(confirm(body), deps);
      expect(response.status).toBe(400);
    }
    expect(r.events).toEqual([]);
  });

  test("a post from another site is a 403 and leaves the link good", async () => {
    const { deps, r, tokens, link } = confirmHarness();
    const token = link();
    const response = await handleEmailChangeConfirm(
      confirm({ token }, { origin: "https://evil.example.net" }),
      deps,
    );
    expect(response.status).toBe(403);
    expect(r.events).toEqual([]);
    expect(tokens.check(token).ok).toBe(true);
  });

  test("without the token secret the route is unavailable, says whom to write to, and touches nothing", async () => {
    const { deps, r, link } = confirmHarness({ tokens: null });
    const response = await handleEmailChangeConfirm(
      confirm({ token: link() }),
      deps,
    );
    expect(response.status).toBe(503);
    expectSupportNamed(await response.text());
    expect(r.events).toEqual([]);
  });

  test("one client past its quota is refused", async () => {
    const { deps, r, link } = confirmHarness({ ipLimiter: tight(1) });
    const ip = { "x-forwarded-for": "203.0.113.11" };
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) {
      statuses.push(
        (await handleEmailChangeConfirm(confirm({ token: link() }, ip), deps))
          .status,
      );
    }
    expect(statuses).toEqual([200, 429]);
    expect(r.changes.length).toBe(1);
  });
});

// ------------------------------------------------------------ Google removal

describe("removing the Google sign-in", () => {
  function removal(bound: boolean, over: Partial<GoogleRemovalDeps> = {}) {
    const removed: string[] = [];
    // One entry per keepSession call: how many removals had run by then.
    const kept: number[] = [];
    let signedIn: string | null = ACCOUNT;
    const deps: GoogleRemovalDeps = {
      accountId: async () => signedIn,
      remove: async (accountId: string) => {
        removed.push(accountId);
        return bound;
      },
      keepSession: async () => {
        kept.push(removed.length);
      },
      ...over,
    };
    return {
      removed,
      kept,
      signInAs: (id: string | null) => (signedIn = id),
      deps,
    };
  }
  const remove = (headers?: Record<string, string>) =>
    post("/api/account/google/remove", {}, headers);

  test("removes it from the signed-in account, and keeps this session after the removal ended the others", async () => {
    const h = removal(true);
    expect((await handleGoogleRemoval(remove(), h.deps)).status).toBe(200);
    expect(h.removed).toEqual([ACCOUNT]);
    expect(h.kept).toEqual([1]);
  });

  test("a session that cannot be kept does not fail a removal that applied", async () => {
    const h = removal(true, {
      keepSession: async () => {
        throw new Error("the session store is down");
      },
    });
    expect((await handleGoogleRemoval(remove(), h.deps)).status).toBe(200);
    expect(h.removed).toEqual([ACCOUNT]);
  });

  test("an account with no Google sign-in is a 404, and no session is touched", async () => {
    const h = removal(false);
    expect((await handleGoogleRemoval(remove(), h.deps)).status).toBe(404);
    expect(h.removed).toEqual([ACCOUNT]);
    expect(h.kept).toEqual([]);
  });

  test("signed out is a 401 and another site is a 403, and neither removes anything", async () => {
    const h = removal(true);
    const foreign = await handleGoogleRemoval(
      remove({ origin: "https://evil.example.net" }),
      h.deps,
    );
    h.signInAs(null);
    const signedOut = await handleGoogleRemoval(remove(), h.deps);
    expect([foreign.status, signedOut.status]).toEqual([403, 401]);
    expect(h.removed).toEqual([]);
    expect(h.kept).toEqual([]);
  });
});
