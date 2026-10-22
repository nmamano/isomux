// The sign-in mail on the wire to Resend, and what a failed send leaves behind.
//
// The request shape is Resend's API contract (https://resend.com/docs/api-reference/emails/send-email):
// a wrong field there fails only in production, where no test reaches. A
// failure must come back as a value the route turns into a 502, never as a
// rejection, and nothing it leaves in the result or the log may carry the key.

import { afterEach, describe, expect, test } from "bun:test";
import {
  SIGNIN_MAIL_FROM,
  sendEmailChangeMail,
  sendEmailChangedNotice,
  sendSignInMail,
} from "./signin-mail.server";

const KEY = "re_test_key_7f3a9c1e5b2d4086";
const LINK = "https://hosted.example.com/signin/email#token=abc.def";

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
      logged.push(
        args
          .map((a) =>
            a instanceof Error ? `${a.message} ${a.stack}` : String(a),
          )
          .join(" "),
      );
    };
  }
}
afterEach(() => {
  Object.assign(console, original);
  logged.length = 0;
});

describe("the request to Resend", () => {
  test("one authenticated POST from the fixed sender, carrying the link", async () => {
    const { sent, fetch } = recorder(() =>
      Response.json({ id: "email-1" }, { status: 200 }),
    );
    const result = await sendSignInMail(
      { to: "user@proton.me", link: LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    expect(result).toEqual({ ok: true });
    expect(sent.length).toBe(1);
    const [request] = sent;
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request.headers.get("content-type")).toContain("application/json");
    expect(request.body.from).toBe(SIGNIN_MAIL_FROM);
    expect([request.body.to].flat()).toEqual(["user@proton.me"]);
    expect(typeof request.body.subject).toBe("string");
    expect(String(request.body.subject).length).toBeGreaterThan(0);
    // Both bodies carry the link whole: a client that shows only one of them
    // must still give the customer a way in.
    expect(String(request.body.text)).toContain(LINK);
    expect(String(request.body.html)).toContain(LINK);
  });

  test("the mail is written in the language it is sent in", async () => {
    const { sent, fetch } = recorder(() => Response.json({ id: "x" }));
    await sendSignInMail(
      { to: "a@example.com", link: LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    await sendSignInMail(
      { to: "a@example.com", link: LINK, language: "es" },
      { apiKey: KEY, fetch },
    );
    expect(sent.length).toBe(2);
    expect(sent[0].body.subject).not.toBe(sent[1].body.subject);
    expect(sent[0].body.text).not.toBe(sent[1].body.text);
  });
});

describe("the email change mails", () => {
  const CHANGE_LINK = "https://hosted.example.com/account/email#token=abc.def";

  test("the confirmation goes to the new address, carries its link, and is not the sign-in mail", async () => {
    const { sent, fetch } = recorder(() => Response.json({ id: "x" }));
    expect(
      await sendEmailChangeMail(
        { to: "work@example.com", link: CHANGE_LINK, language: "en" },
        { apiKey: KEY, fetch },
      ),
    ).toEqual({ ok: true });
    await sendSignInMail(
      { to: "work@example.com", link: LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    const [change, signIn] = sent;
    expect(change.url).toBe("https://api.resend.com/emails");
    expect(change.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect([change.body.to].flat()).toEqual(["work@example.com"]);
    expect(String(change.body.text)).toContain(CHANGE_LINK);
    expect(String(change.body.html)).toContain(CHANGE_LINK);
    // A customer must be able to tell "change my address" from "sign in".
    expect(change.body.subject).not.toBe(signIn.body.subject);
  });

  test("the notice goes to the old address and names the new one", async () => {
    const { sent, fetch } = recorder(() => Response.json({ id: "x" }));
    expect(
      await sendEmailChangedNotice(
        {
          to: "customer.name@gmail.com",
          newEmail: "work@example.com",
          language: "en",
        },
        { apiKey: KEY, fetch },
      ),
    ).toEqual({ ok: true });
    const [notice] = sent;
    expect([notice.body.to].flat()).toEqual(["customer.name@gmail.com"]);
    expect(String(notice.body.text)).toContain("work@example.com");
  });

  test("a failed send of either is a value, not a rejection", async () => {
    captureConsole();
    const { fetch } = recorder(() => {
      throw new TypeError("fetch failed");
    });
    const change = await sendEmailChangeMail(
      { to: "work@example.com", link: CHANGE_LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    const notice = await sendEmailChangedNotice(
      { to: "old@example.com", newEmail: "work@example.com", language: "en" },
      { apiKey: KEY, fetch },
    );
    expect([change.ok, notice.ok]).toEqual([false, false]);
    expect(logged.join("\n")).not.toContain(KEY);
  });
});

describe("a send that fails", () => {
  test("a refusal from Resend is a value, and neither it nor the log carries the key", async () => {
    captureConsole();
    const { fetch } = recorder(
      () =>
        new Response(
          JSON.stringify({
            name: "rate_limit_exceeded",
            message: "daily quota",
          }),
          { status: 429 },
        ),
    );
    const result = await sendSignInMail(
      { to: "a@example.com", link: LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  test("a network failure is a value too, not a rejection", async () => {
    captureConsole();
    const { fetch } = recorder(() => {
      throw new TypeError("fetch failed");
    });
    const result = await sendSignInMail(
      { to: "a@example.com", link: LINK, language: "en" },
      { apiKey: KEY, fetch },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });
});
