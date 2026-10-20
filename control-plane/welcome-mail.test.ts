// The welcome mail on the wire to Resend, and the unsubscribe contract it
// carries.
//
// The request shape is Resend's API contract
// (https://resend.com/docs/api-reference/emails/send-email) and the two
// unsubscribe headers are RFC 2369 and RFC 8058: a wrong field there fails only
// in a customer's inbox, where no test reaches. The copy itself is a draft for
// Nil, so nothing here reads it: the tests pin what every step must carry.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  STOREFRONT_ORIGIN,
  WELCOME_MAIL_FROM,
  WELCOME_MAIL_OFFSETS_MS,
  WELCOME_MAIL_REPLY_TO,
  renderWelcomeMail,
  sendWelcomeMail,
  welcomeMailConfigured,
} from "./welcome-mail.ts";

const KEY = "re_test_key_51c0e8a7d2b94f63";
const TOKEN = "tok_Zm9vYmFyYmF6cXV4LXdlbGNvbWUtbWFpbA";
const OFFICE = "https://acme.test.isomux.app";
const POSTAL = "Isomux LLC, 1 Example Street, Springfield";
const WEB_APP = path.join(import.meta.dir, "web", "app");

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recorder(answer: () => Response | Promise<Response>): {
  sent: Sent[];
  fetch: typeof fetch;
} {
  const sent: Sent[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      ) as Record<string, unknown>,
    });
    return answer();
  }) as typeof fetch;
  return { sent, fetch: fake };
}

const logged: string[] = [];
const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
function captureConsole(): void {
  for (const name of ["log", "warn", "error"] as const) {
    console[name] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }
}
afterEach(() => {
  Object.assign(console, original);
  logged.length = 0;
});

/** The URL a storefront link names, checked against the storefront origin and
 * the route that serves it. */
function storefrontRoute(href: string, file: "route.ts" | "page.tsx"): URL {
  const url = new URL(href);
  expect(url.origin).toBe(STOREFRONT_ORIGIN);
  expect(url.searchParams.get("t")).toBe(TOKEN);
  // The mail and the web app are two deployables: the path a mail names must be
  // one the app serves, with the handler kind the client uses on it.
  expect([
    url.pathname,
    fs.existsSync(path.join(WEB_APP, url.pathname, file)),
  ]).toEqual([url.pathname, true]);
  return url;
}

describe("the series is configured only when it may send", () => {
  test("the flag and the key are both required", () => {
    expect(welcomeMailConfigured({ RESEND_API_KEY: KEY }, true)).toBe(true);
    expect(welcomeMailConfigured({ RESEND_API_KEY: KEY }, false)).toBe(false);
    expect(welcomeMailConfigured({}, true)).toBe(false);
    expect(welcomeMailConfigured({ RESEND_API_KEY: "" }, true)).toBe(false);
  });

  test("the shipped flag is off until Nil approves the copy", () => {
    // The default arguments are the production call: the key alone must not
    // start the series.
    const saved = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = KEY;
    try {
      expect(welcomeMailConfigured()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = saved;
    }
  });
});

describe("every step", () => {
  test("renders with every placeholder filled, the office address on day 0, and the opt-out at the end", () => {
    expect(WELCOME_MAIL_OFFSETS_MS.length).toBe(5);
    for (let step = 0; step < WELCOME_MAIL_OFFSETS_MS.length; step++) {
      const mail = renderWelcomeMail(step, {
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
        postalAddress: POSTAL,
      });
      expect([step, mail.subject.trim().length > 0]).toEqual([step, true]);
      // A placeholder left in is a mail that says "{dashboardUrl}".
      expect([step, /[{}]/.test(mail.subject + mail.text)]).toEqual([
        step,
        false,
      ]);
      expect([step, mail.text.includes(POSTAL)]).toEqual([step, true]);
      const links = mail.text.match(/https:\/\/\S+/g) ?? [];
      const optOut = links.filter((link) => link.includes(TOKEN));
      expect([step, optOut.length]).toEqual([step, 1]);
      storefrontRoute(optOut[0], "page.tsx");
      if (step === 0) expect(mail.text).toContain(OFFICE);
    }
  });

  test("the first step stands alone; the series has no step past the offsets", () => {
    const vars = {
      officeUrl: OFFICE,
      unsubscribeToken: TOKEN,
      postalAddress: POSTAL,
    };
    expect(() =>
      renderWelcomeMail(WELCOME_MAIL_OFFSETS_MS.length, vars),
    ).toThrow();
    // Offsets are counted from first live, strictly increasing, starting at 0.
    expect(WELCOME_MAIL_OFFSETS_MS[0]).toBe(0);
    for (let i = 1; i < WELCOME_MAIL_OFFSETS_MS.length; i++)
      expect(WELCOME_MAIL_OFFSETS_MS[i]).toBeGreaterThan(
        WELCOME_MAIL_OFFSETS_MS[i - 1],
      );
  });
});

describe("the request to Resend", () => {
  test("one authenticated plain-text POST from the fixed sender, with the one-click headers", async () => {
    const { sent, fetch } = recorder(() => Response.json({ id: "email-1" }));
    const result = await sendWelcomeMail(
      {
        to: "owner@example.com",
        step: 2,
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
      },
      { apiKey: KEY, fetch, postalAddress: POSTAL },
    );
    expect(result).toEqual({ ok: true });
    expect(sent.length).toBe(1);
    const [request] = sent;
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("content-type")).toContain("application/json");
    expect(request.body.from).toBe(WELCOME_MAIL_FROM);
    expect([request.body.reply_to].flat()).toEqual([WELCOME_MAIL_REPLY_TO]);
    expect([request.body.to].flat()).toEqual(["owner@example.com"]);
    // Plain text only: no HTML part at all.
    expect("html" in request.body).toBe(false);
    const rendered = renderWelcomeMail(2, {
      officeUrl: OFFICE,
      unsubscribeToken: TOKEN,
      postalAddress: POSTAL,
    });
    expect(request.body.subject).toBe(rendered.subject);
    expect(request.body.text).toBe(rendered.text);

    const headers = request.body.headers as Record<string, string>;
    // RFC 2369: the URI in angle brackets. RFC 8058: the POST target is that
    // same URI, so it must be served by a route handler, not a page.
    const list = headers["List-Unsubscribe"];
    expect(list).toMatch(/^<https:\/\/[^>]+>$/);
    storefrontRoute(list.slice(1, -1), "route.ts");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // The key travels in the Authorization header and nowhere else.
    expect(JSON.stringify(request.body)).not.toContain(KEY);
  });

  test("an empty postal address refuses without a request", async () => {
    const { sent, fetch } = recorder(() => Response.json({ id: "x" }));
    const result = await sendWelcomeMail(
      {
        to: "a@example.com",
        step: 0,
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
      },
      { apiKey: KEY, fetch, postalAddress: "" },
    );
    expect(result.ok).toBe(false);
    expect(sent.length).toBe(0);
    // The shipped constant is empty until Nil fills it, so the default refuses
    // the same way.
    const byDefault = await sendWelcomeMail(
      {
        to: "a@example.com",
        step: 0,
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
      },
      { apiKey: KEY, fetch },
    );
    expect(byDefault.ok).toBe(false);
    expect(sent.length).toBe(0);
  });
});

describe("a send that fails", () => {
  test("a refusal from Resend is a value, and neither it nor the log carries the key", async () => {
    captureConsole();
    const { fetch } = recorder(
      () =>
        new Response(JSON.stringify({ name: "rate_limit_exceeded" }), {
          status: 429,
        }),
    );
    const result = await sendWelcomeMail(
      {
        to: "a@example.com",
        step: 1,
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
      },
      { apiKey: KEY, fetch, postalAddress: POSTAL },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  test("a network failure is a value too, not a rejection", async () => {
    captureConsole();
    const { fetch } = recorder(() => {
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    });
    const result = await sendWelcomeMail(
      {
        to: "a@example.com",
        step: 1,
        officeUrl: OFFICE,
        unsubscribeToken: TOKEN,
      },
      { apiKey: KEY, fetch, postalAddress: POSTAL },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });
});
