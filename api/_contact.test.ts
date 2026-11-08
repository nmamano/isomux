// The enterprise contact form's endpoint. GET hands the page the Turnstile site
// key; POST checks the request in layers (rate limit, size, honeypot and fill
// time, fields, configuration, Turnstile) and sends one mail through Resend.
// These tests run the real handler with a stubbed global fetch that answers for
// Cloudflare's siteverify and Resend and records every call.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import chat from "./chat.ts";
import handler, { CONTACT_LIMITS, FREE_MAIL_DOMAINS } from "./contact.ts";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND = "https://api.resend.com/emails";
const ENV = {
  TURNSTILE_SITE_KEY: "site-key-test",
  TURNSTILE_SECRET_KEY: "secret-key-test",
  RESEND_API_KEY: "resend-key-test",
} as const;
type EnvKey = keyof typeof ENV;

const realFetch = globalThis.fetch;
const realEnv = Object.fromEntries(
  Object.keys(ENV).map((key) => [key, process.env[key]]),
);

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let siteverify: () => Promise<Response>;
let resend: () => Promise<Response>;
let nextIp = 0;
let ip = "";

const verified =
  (over: Record<string, unknown> = {}) =>
  () =>
    Promise.resolve(
      Response.json({
        success: true,
        hostname: "isomux.com",
        action: "enterprise-contact",
        ...over,
      }),
    );

beforeEach(() => {
  ip = `198.51.100.${++nextIp}`;
  calls = [];
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
  siteverify = verified();
  resend = () => Promise.resolve(Response.json({ id: "mail-1" }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    if (url === SITEVERIFY) return siteverify();
    if (url === RESEND) return resend();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(realEnv))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "buyer@acme.example",
    company: "Acme Corp",
    message: "We want agents for our support team.",
    website: "",
    startedAt: Date.now() - 10_000,
    turnstileToken: "token-1",
    ...over,
  };
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    handler(
      new Request("https://isomux.com/api/contact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `${ip}, 10.0.0.1`,
          "user-agent": "TestBrowser/1.0",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}

function request(method: string): Promise<Response> {
  return Promise.resolve(
    handler(
      new Request("https://isomux.com/api/contact", {
        method,
        headers: { "x-forwarded-for": ip },
      }),
    ),
  );
}

/** Every response is never cached. */
function noStore(res: Response): Response {
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res;
}

async function errorOf(
  res: Response,
): Promise<{ status: number; code: string; field?: string }> {
  noStore(res);
  const body = (await res.json()) as {
    error: { code: string; field?: string };
  };
  return { status: res.status, code: body.error.code, field: body.error.field };
}

const urls = () => calls.map((call) => call.url);
const resendBody = () =>
  JSON.parse(String(calls.find((c) => c.url === RESEND)!.init.body)) as {
    from: string;
    to: string | string[];
    reply_to: string | string[];
    subject: string;
    text: string;
  };
const list = (value: string | string[]) =>
  Array.isArray(value) ? value : [value];

describe("POST /api/contact sends one mail", () => {
  it("checks the token with Cloudflare, then mails the form to llc@isomux.com", async () => {
    const res = noStore(await post(valid()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(urls()).toEqual([SITEVERIFY, RESEND]);

    // siteverify gets the secret, the page's token and the visitor's address.
    const verify = calls[0];
    expect(verify.init.method).toBe("POST");
    const form = new URLSearchParams(String(verify.init.body));
    expect(form.get("secret")).toBe(ENV.TURNSTILE_SECRET_KEY);
    expect(form.get("response")).toBe("token-1");
    expect(form.get("remoteip")).toBe(ip);

    // Resend sends from our domain, to our mailbox, with replies to the buyer.
    const send = calls[1];
    expect(send.init.method).toBe("POST");
    expect(new Headers(send.init.headers).get("authorization")).toBe(
      `Bearer ${ENV.RESEND_API_KEY}`,
    );
    const mail = resendBody();
    expect(mail.from).toMatch(/@isomux\.com>?$/);
    expect(list(mail.to)).toEqual(["llc@isomux.com"]);
    expect(list(mail.reply_to)).toEqual(["buyer@acme.example"]);
    expect(mail.subject.startsWith("[Enterprise form] ")).toBe(true);
    expect(mail.subject).toContain("Acme Corp");
    expect(mail.subject).not.toContain("[free mail]");
    for (const value of [
      "buyer@acme.example",
      "Acme Corp",
      "We want agents for our support team.",
    ])
      expect(mail.text).toContain(value);
    // The mail carries no visitor address or browser.
    expect(mail.text).not.toContain(ip);
    expect(mail.text).not.toContain("TestBrowser");
  });

  it("bounds both upstream calls with a timeout signal", async () => {
    expect((await post(valid())).status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.signal!.aborted).toBe(false);
    }
    expect(CONTACT_LIMITS.upstreamTimeoutMs).toBe(10_000);
  });

  it("marks a free-mail sender in the subject, whatever the domain's case", async () => {
    expect(FREE_MAIL_DOMAINS.has("gmail.com")).toBe(true);
    for (const email of ["someone@gmail.com", "Someone@GMail.COM"]) {
      calls = [];
      expect((await post(valid({ email }))).status).toBe(200);
      expect(
        resendBody().subject.startsWith("[Enterprise form] [free mail] "),
      ).toBe(true);
    }
  });

  it("keeps the subject on one line when the company holds control characters", async () => {
    const company = "Acme\r\nBcc: victim@example.com\u0007\u0000Corp";
    expect((await post(valid({ company }))).status).toBe(200);
    const { subject } = resendBody();
    const controls = [...subject].filter((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    expect(controls).toEqual([]);
    expect(subject).toContain("Acme");
    expect(subject).toContain("Corp");
  });

  it("accepts each field at its limit and the www host", async () => {
    siteverify = verified({ hostname: "www.isomux.com" });
    const local = "a".repeat(CONTACT_LIMITS.maxEmailChars - "@acme.co".length);
    const res = await post(
      valid({
        email: `${local}@acme.co`,
        company: `  ${"c".repeat(CONTACT_LIMITS.maxCompanyChars)}  `,
        message: "m".repeat(CONTACT_LIMITS.maxMessageChars),
        startedAt: Date.now() - CONTACT_LIMITS.minFillMs - 500,
      }),
    );
    expect(res.status).toBe(200);
    expect(urls()).toEqual([SITEVERIFY, RESEND]);
  });

  it("accepts a team size from a page cached before the field went, and mails nothing of it", async () => {
    const size = "201-1000";
    const res = noStore(await post(valid({ size })));
    expect(res.status).toBe(200);
    expect(urls()).toEqual([SITEVERIFY, RESEND]);
    const mail = resendBody();
    expect(mail.text).toContain("Acme Corp");
    expect(mail.subject).not.toContain(size);
    expect(mail.text).not.toContain(size);
  });

  it("sends without the site key: only the GET needs it", async () => {
    delete process.env.TURNSTILE_SITE_KEY;
    expect((await post(valid())).status).toBe(200);
    expect(urls()).toEqual([SITEVERIFY, RESEND]);
  });
});

describe("POST /api/contact drops bots silently", () => {
  const drops: [string, () => Record<string, unknown>][] = [
    ["a filled honeypot", () => ({ website: "https://spam.example" })],
    [
      "a fill faster than the minimum",
      () => ({ startedAt: Date.now() - CONTACT_LIMITS.minFillMs + 1_000 }),
    ],
    ["no start time", () => ({ startedAt: undefined })],
    ["a start time that is not a number", () => ({ startedAt: "yesterday" })],
  ];
  for (const [name, over] of drops)
    it(`answers ok and sends nothing for ${name}`, async () => {
      const res = noStore(await post(valid(over())));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toHaveLength(0);
    });
});

describe("POST /api/contact rejects a bad request", () => {
  const tooLongEmail = `${"a".repeat(CONTACT_LIMITS.maxEmailChars - "@acme.co".length + 1)}@acme.co`;
  const cases: [string, Record<string, unknown>][] = [
    ["email", { email: undefined }],
    ["email", { email: "" }],
    ["email", { email: 5 }],
    ["email", { email: "no-at.example" }],
    ["email", { email: "a@@acme.co" }],
    ["email", { email: "a@b@acme.co" }],
    ["email", { email: "@acme.co" }],
    ["email", { email: "a@acmeco" }],
    ["email", { email: "a b@acme.co" }],
    ["email", { email: "a@acme.co\r\nBcc: v@x.co" }],
    ["email", { email: "a@acme.co\u0000" }],
    ["email", { email: "a@acme.co,victim@example.com" }],
    ["email", { email: "a@acme.co;victim@example.com" }],
    ["email", { email: "a,b@acme.co" }],
    ["email", { email: "a<b@acme.co" }],
    ["email", { email: "a>b@acme.co" }],
    ["email", { email: "Name <a@acme.co>" }],
    ["email", { email: '"a"@acme.co' }],
    ["email", { email: "a(b)@acme.co" }],
    ["email", { email: "a[b]@acme.co" }],
    ["email", { email: "a\\b@acme.co" }],
    ["email", { email: "a:b@acme.co" }],
    ["email", { email: tooLongEmail }],
    ["company", { company: undefined }],
    ["company", { company: "   " }],
    ["company", { company: 7 }],
    ["company", { company: "c".repeat(CONTACT_LIMITS.maxCompanyChars + 1) }],
    ["message", { message: undefined }],
    ["message", { message: " \n " }],
    ["message", { message: ["hi"] }],
    ["message", { message: "m".repeat(CONTACT_LIMITS.maxMessageChars + 1) }],
  ];
  for (const [field, over] of cases)
    it(`names ${field} for ${JSON.stringify(over)}`.slice(0, 120), async () => {
      expect(await errorOf(await post(valid(over)))).toEqual({
        status: 400,
        code: "invalid_request",
        field,
      });
      expect(calls).toHaveLength(0);
    });

  it("refuses a body that is not a JSON object", async () => {
    for (const body of ["{", "[]", "null", '"text"']) {
      ip = `${ip}0`; // one address per body: four POSTs pass the 10-minute quota
      const res = await post(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      noStore(res);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a body over the size limit before it reads the fields", async () => {
    const message = "m".repeat(CONTACT_LIMITS.maxBodyBytes);
    const res = await post(valid({ message }));
    expect(res.status).toBe(413);
    noStore(res);
    expect(calls).toHaveLength(0);
  });

  it("counts bytes, not characters, against the size limit", async () => {
    // Under the limit in characters, over it in UTF-8 bytes.
    const message = "é".repeat(Math.ceil(CONTACT_LIMITS.maxBodyBytes / 2) + 10);
    expect(message.length).toBeLessThan(CONTACT_LIMITS.maxBodyBytes);
    const res = await post(valid({ message }));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/contact without configuration", () => {
  for (const key of ["TURNSTILE_SECRET_KEY", "RESEND_API_KEY"] as EnvKey[])
    it(`answers 503 and calls nothing when ${key} is unset`, async () => {
      delete process.env[key];
      expect(await errorOf(await post(valid()))).toMatchObject({
        status: 503,
        code: "not_configured",
      });
      expect(calls).toHaveLength(0);
    });
});

describe("POST /api/contact sends nothing the bot check refuses", () => {
  const refusals: [string, () => Promise<Response>][] = [
    ["a failed check", verified({ success: false })],
    ["another hostname", verified({ hostname: "evil.example" })],
    ["another action", verified({ action: "other-form" })],
    ["no action", verified({ action: undefined })],
  ];
  for (const [name, answer] of refusals)
    it(`answers 403 for ${name}`, async () => {
      siteverify = answer;
      expect(await errorOf(await post(valid()))).toMatchObject({
        status: 403,
        code: "verification_failed",
      });
      expect(urls()).toEqual([SITEVERIFY]);
    });

  for (const token of [undefined, ""])
    it(`answers 403 without asking Cloudflare for token ${JSON.stringify(token)}`, async () => {
      expect(
        await errorOf(await post(valid({ turnstileToken: token }))),
      ).toMatchObject({ status: 403, code: "verification_failed" });
      expect(calls).toHaveLength(0);
    });

  it("answers 502 when Cloudflare cannot be reached", async () => {
    siteverify = () => Promise.reject(new TypeError("fetch failed"));
    expect((await errorOf(await post(valid()))).status).toBe(502);
    expect(urls()).toEqual([SITEVERIFY]);
  });
});

describe("POST /api/contact when Resend fails", () => {
  const failures: [string, () => Promise<Response>][] = [
    [
      "an error status",
      () => Promise.resolve(new Response("no", { status: 500 })),
    ],
    [
      "a refused key",
      () => Promise.resolve(new Response("no", { status: 401 })),
    ],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ];
  for (const [name, answer] of failures)
    it(`answers 502 send_failed for ${name}`, async () => {
      resend = answer;
      expect(await errorOf(await post(valid()))).toMatchObject({
        status: 502,
        code: "send_failed",
      });
      expect(urls()).toEqual([SITEVERIFY, RESEND]);
    });
});

describe("the contact rate limit", () => {
  const T0 = Date.parse("2026-11-08T12:00:00Z");
  const at = (seconds: number) => setSystemTime(new Date(T0 + seconds * 1000));
  /** A counted POST that sends nothing: the honeypot is filled. */
  const drop = () =>
    post(valid({ website: "x", startedAt: Date.now() - 10_000 }));

  function fields(
    value: string | null,
  ): Record<string, Record<string, number>> {
    expect(value).not.toBeNull();
    const out: Record<string, Record<string, number>> = {};
    for (const item of value!.split(",")) {
      const [name, ...params] = item.trim().split(";");
      out[JSON.parse(name)] = Object.fromEntries(
        params.map((p) => {
          const [k, v] = p.trim().split("=");
          return [k, Number(v)];
        }),
      );
    }
    return out;
  }

  it("allows 3 POSTs in 10 minutes per address, then answers 429 with Retry-After", async () => {
    at(0);
    for (let i = 0; i < 3; i++) {
      const res = await drop();
      expect(res.status).toBe(200);
      expect(res.headers.get("ratelimit-policy")).not.toBeNull();
    }
    at(60);
    const res = await post(valid());
    expect(res.status).toBe(429);
    noStore(res);
    expect(Number(res.headers.get("retry-after"))).toBe(540);
    expect(fields(res.headers.get("ratelimit"))["10min"].r).toBe(0);
    expect(fields(res.headers.get("ratelimit-policy"))["10min"]).toEqual({
      q: 3,
      w: 600,
    });
    expect(calls).toHaveLength(0);

    // Another address has its own count.
    ip = `${ip}0`;
    expect((await drop()).status).toBe(200);
  });

  it("allows 10 POSTs a day per address", async () => {
    for (let i = 0; i < 10; i++) {
      at(i * 601);
      expect((await drop()).status).toBe(200);
    }
    at(10 * 601);
    const res = await drop();
    expect(res.status).toBe(429);
    expect(fields(res.headers.get("ratelimit"))["day"].r).toBe(0);
    expect(fields(res.headers.get("ratelimit-policy"))["day"]).toEqual({
      q: 10,
      w: 86_400,
    });
    expect(Number(res.headers.get("retry-after"))).toBe(86_400 - 10 * 601);
    at(86_400);
    expect((await drop()).status).toBe(200);
  });

  it("does not count a GET or another method", async () => {
    at(0);
    for (let i = 0; i < 5; i++) {
      expect((await request("GET")).status).toBe(200);
      expect((await request("PUT")).status).toBe(405);
    }
    for (let i = 0; i < 3; i++) expect((await drop()).status).toBe(200);
  });

  it("keeps its counts apart from the chat's", async () => {
    at(0);
    // Five counted chat requests in a minute spend the chat's minute window.
    const chatPost = () =>
      chat(
        new Request("https://isomux.com/api/chat", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
          body: "{",
        }),
      );
    for (let i = 0; i < 5; i++) expect((await chatPost()).status).toBe(400);
    expect((await chatPost()).status).toBe(429);
    // The contact form still has its own 3.
    for (let i = 0; i < 3; i++) expect((await drop()).status).toBe(200);
    expect((await drop()).status).toBe(429);
  });
});

describe("GET /api/contact hands the page its configuration", () => {
  it("answers the site key and the server's time for the fill check", async () => {
    // The page sends startedAt back, so the minimum fill time is measured on
    // one clock: a visitor's clock running fast must not drop a real message.
    const now = Date.parse("2026-11-08T12:00:00Z");
    setSystemTime(new Date(now));
    const res = noStore(await request("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      turnstileSiteKey: ENV.TURNSTILE_SITE_KEY,
      startedAt: now,
    });
    expect(calls).toHaveLength(0);
  });

  for (const key of Object.keys(ENV) as EnvKey[])
    it(`answers 503 when ${key} is unset`, async () => {
      delete process.env[key];
      expect(await errorOf(await request("GET"))).toMatchObject({
        status: 503,
        code: "not_configured",
      });
    });

  it("answers 405 to other methods", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"])
      expect((await errorOf(await request(method))).status).toBe(405);
  });
});

describe("the enterprise page form", () => {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  window.document.write(readFileSync("site/enterprise.html", "utf8"));
  const doc = window.document;
  afterAll(() => window.happyDOM.close());
  const section = () => doc.getElementById("contact");
  const control = (name: string) =>
    section()?.querySelector(`form [name="${name}"]`) ?? null;

  it("has a control for each field the API reads, and no other", () => {
    expect(section()).not.toBeNull();
    expect(control("email")?.getAttribute("type")).toBe("email");
    expect(control("company")?.tagName).toBe("INPUT");
    expect(control("message")?.tagName).toBe("TEXTAREA");
    for (const name of ["email", "company", "message"])
      expect({
        name,
        required: control(name)?.hasAttribute("required"),
      }).toEqual({ name, required: true });
    // The fields the API reads, plus the honeypot; Turnstile adds its own
    // input only when its script runs, which this document does not do.
    const names = Array.from(section()!.querySelectorAll("form [name]"), (el) =>
      el.getAttribute("name"),
    ).sort();
    expect(names).toEqual(["company", "email", "message", "website"]);
  });

  it("hides the honeypot from people and assistive tech", () => {
    const honeypot = control("website");
    expect(honeypot).not.toBeNull();
    expect(honeypot!.getAttribute("tabindex")).toBe("-1");
    expect(honeypot!.getAttribute("autocomplete")).toBe("off");
    expect(honeypot!.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(honeypot!.hasAttribute("required")).toBe(false);
  });

  it("links the privacy policy from the form, and the page links the form", () => {
    expect(
      section()!.querySelector('a[href="/hosted-privacy"]'),
    ).not.toBeNull();
    expect(doc.querySelectorAll('a[href="#contact"]').length).toBeGreaterThan(
      0,
    );
    // The mail address stays as the fallback.
    expect(
      section()!.querySelector('a[href="mailto:llc@isomux.com"]'),
    ).not.toBeNull();
  });

  it("loads only scripts the page's CSP admits, and the CSP admits Turnstile's frame", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const main = vercel.headers.find(
      (rule) => rule.source === "/((?!demo$).*)",
    );
    const csp = main!.headers.find(
      (h) => h.key === "Content-Security-Policy",
    )!.value;
    const directive = (name: string) =>
      csp
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .find(([key]) => key === name)!
        .slice(1);
    const scripts = Array.from(doc.querySelectorAll("script[src]")).map(
      (script) => new URL(script.getAttribute("src")!, "https://isomux.com/"),
    );
    expect(
      scripts.some((url) => url.origin === "https://challenges.cloudflare.com"),
    ).toBe(true);
    for (const url of scripts) {
      const allowed =
        url.origin === "https://isomux.com"
          ? directive("script-src").includes("'self'")
          : directive("script-src").includes(url.origin);
      expect({ src: url.href, allowed }).toEqual({
        src: url.href,
        allowed: true,
      });
    }
    expect(directive("frame-src")).toContain(
      "https://challenges.cloudflare.com",
    );
  });
});

describe("the privacy policy", () => {
  it("names the Turnstile check with Cloudflare's privacy addendum", () => {
    const page = readFileSync("site/hosted-privacy.html", "utf8");
    expect(page).toMatch(
      /href="https:\/\/www\.cloudflare\.com\/[^"]*turnstile[^"]*"/i,
    );
  });
});
