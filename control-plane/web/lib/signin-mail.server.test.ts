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
import { SUPPORTED_LANGUAGES } from "./i18n/languages";
import { translatorFor } from "./i18n/translate";

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

describe("the enterprise sign-in mail", () => {
  // The buyer of Isomux for Enterprise never reads about Hosted: the mail
  // the enterprise sign-in page asks for does not carry Hosted's sentence.
  test.each(SUPPORTED_LANGUAGES.map((language) => language.code))(
    "%s: the Hosted sentence only in the Hosted mail, the link in both",
    async (language) => {
      const hostedIntro = translatorFor(language).t("signIn.mailIntro");
      const { sent, fetch } = recorder(() => Response.json({ id: "x" }));
      await sendSignInMail(
        { to: "a@example.com", link: LINK, language },
        { apiKey: KEY, fetch },
      );
      await sendSignInMail(
        { to: "a@example.com", link: LINK, language, product: "enterprise" },
        { apiKey: KEY, fetch },
      );
      expect(sent).toHaveLength(2);
      const [hosted, enterprise] = sent.map(
        (request) =>
          `${String(request.body.text)}\n${String(request.body.html)}`,
      );
      // The enabling condition: the Hosted mail carries the sentence.
      expect(hosted).toContain(hostedIntro);
      expect(enterprise).not.toContain(hostedIntro);
      expect(enterprise).toContain(LINK);
      expect(sent[1].body.subject).toBeTruthy();
    },
  );
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
});

describe("a send that fails", () => {
  test("a refusal or a network failure is a value, and neither it nor the log carries the key", async () => {
    // All three mails share one sender; each is driven through it.
    const senders = [
      (fetch: typeof globalThis.fetch) =>
        sendSignInMail(
          { to: "a@example.com", link: LINK, language: "en" },
          { apiKey: KEY, fetch },
        ),
      (fetch: typeof globalThis.fetch) =>
        sendEmailChangeMail(
          {
            to: "work@example.com",
            link: "https://hosted.example.com/account/email#token=abc.def",
            language: "en",
          },
          { apiKey: KEY, fetch },
        ),
      (fetch: typeof globalThis.fetch) =>
        sendEmailChangedNotice(
          {
            to: "old@example.com",
            newEmail: "work@example.com",
            language: "en",
          },
          { apiKey: KEY, fetch },
        ),
    ];
    const failures: [string, () => Response][] = [
      [
        "refused",
        () =>
          new Response(
            JSON.stringify({
              name: "rate_limit_exceeded",
              message: "daily quota",
            }),
            { status: 429 },
          ),
      ],
      [
        "unreachable",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];
    captureConsole();
    for (const [index, send] of senders.entries()) {
      for (const [failure, answer] of failures) {
        const { fetch } = recorder(answer);
        const result = await send(fetch);
        expect([index, failure, result.ok]).toEqual([index, failure, false]);
        expect(JSON.stringify(result)).not.toContain(KEY);
      }
    }
    expect(logged.join("\n")).not.toContain(KEY);
  });
});

describe("the log line for an accepted send", () => {
  // Support answers "the link never came" from this line: it proves the send
  // reached Resend, and its id is the one to look up there. The line carries
  // the recipient's domain only, never the address or the link.
  const ID = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
  const stdout: string[] = [];
  const stderr: string[] = [];
  function captureStreams(): void {
    stdout.length = 0;
    stderr.length = 0;
    const join = (args: unknown[]) => args.map(String).join(" ");
    console.log = (...args: unknown[]) => void stdout.push(join(args));
    console.info = (...args: unknown[]) => void stdout.push(join(args));
    console.warn = (...args: unknown[]) => void stderr.push(join(args));
    console.error = (...args: unknown[]) => void stderr.push(join(args));
  }
  const originalInfo = console.info;
  afterEach(() => {
    console.info = originalInfo;
  });

  const senders = {
    signIn: (to: string, fetch: typeof globalThis.fetch) =>
      sendSignInMail(
        { to, link: LINK, language: "en" },
        { apiKey: KEY, fetch },
      ),
    change: (to: string, fetch: typeof globalThis.fetch) =>
      sendEmailChangeMail(
        {
          to,
          link: "https://hosted.example.com/account/email#token=ghi.jkl",
          language: "en",
        },
        { apiKey: KEY, fetch },
      ),
    notice: (to: string, fetch: typeof globalThis.fetch) =>
      sendEmailChangedNotice(
        { to, newEmail: "fresh.addr@newdomain.test", language: "en" },
        { apiKey: KEY, fetch },
      ),
  };

  test("one line with the Resend id and the domain, and not the address or the link", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    const result = await senders.signIn("customer.name@gmail.com", fetch);
    expect(result).toEqual({ ok: true });
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const [line] = stdout;
    expect(line).toContain(ID);
    expect(line).toContain("@gmail.com");
    expect(line).not.toContain("customer.name");
    expect(line).not.toContain("abc.def");
    expect(line).not.toContain("token");
    expect(line).not.toContain(KEY);
  });

  test("each of the three mails logs its own kind", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    for (const send of Object.values(senders)) {
      expect(await send("customer.name@gmail.com", fetch)).toEqual({
        ok: true,
      });
    }
    expect(stderr).toEqual([]);
    // Same id and same domain for all three: only the kind can tell them apart.
    expect(stdout).toHaveLength(3);
    expect(new Set(stdout).size).toBe(3);
    for (const line of stdout) {
      expect(line).toContain(ID);
      expect(line).toContain("@gmail.com");
      expect(line).not.toContain("customer.name");
      expect(line).not.toContain("ghi.jkl");
      expect(line).not.toContain("abc.def");
      // The notice names the new address in its body, never in the log.
      expect(line).not.toContain("fresh.addr");
      expect(line).not.toContain("newdomain");
    }
  });

  test("the domain is logged in lower case", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    await senders.signIn("Someone@Example.COM", fetch);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("@example.com");
    expect(stdout[0].toLowerCase()).not.toContain("someone");
  });

  test("a local part with an @ sign: the domain is what follows the last @", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    await senders.signIn('"customer@name"@gmail.com', fetch);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain(ID);
    expect(stdout[0]).toContain("@gmail.com");
    expect(stdout[0]).not.toContain("customer");
  });

  // A 2xx means Resend took the mail. A body the sender cannot use must not
  // turn that into a failure (the route would answer 502 and the customer
  // would ask again), and its content must not reach the log.
  test.each<[string, () => Response]>([
    ["no id", () => Response.json({})],
    ["a non-string id", () => Response.json({ id: { nested: "INJECTED" } })],
    [
      "an id that writes a second line",
      () =>
        Response.json({
          id: `${ID}\nsign-in mail: Resend accepted sign-in mail INJECTED to @forged.test`,
        }),
    ],
    ["an id with spaces", () => Response.json({ id: "INJECTED id here" })],
    ["an id that is too long", () => Response.json({ id: "I".repeat(101) })],
    ["a body that is not JSON", () => new Response("INJECTED <html>")],
    ["an empty body", () => new Response(null, { status: 200 })],
  ])("%s: still ok, one line, none of the body", async (_name, answer) => {
    captureStreams();
    const { fetch } = recorder(answer);
    const result = await senders.signIn("customer.name@gmail.com", fetch);
    expect(result).toEqual({ ok: true });
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const [line] = stdout;
    // The enabling condition: the line is the accepted line, with its domain.
    expect(line).toContain("@gmail.com");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("INJECTED");
    expect(line).not.toContain("forged");
    expect(line).not.toContain("I".repeat(101));
    expect(line).not.toContain("html");
  });

  test("a recipient domain that writes a second line is not logged", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    const result = await senders.signIn(
      "customer.name@gmail.com\nsign-in mail: Resend accepted sign-in mail FORGED to forged.test",
      fetch,
    );
    expect(result).toEqual({ ok: true });
    expect(stdout).toHaveLength(1);
    const [line] = stdout;
    // The enabling condition: the line is written, with the real id.
    expect(line).toContain(ID);
    expect(line).not.toContain("\n");
    expect(line.toLowerCase()).not.toContain("forged");
  });

  test("a recipient domain with a space or a markup character is not logged", async () => {
    captureStreams();
    const { fetch } = recorder(() => Response.json({ id: ID }));
    await senders.signIn("customer.name@gmail.com INJECTED<b>", fetch);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain(ID);
    expect(stdout[0].toLowerCase()).not.toContain("injected");
  });

  test.each<[string, () => Response]>([
    ["a refusal", () => Response.json({ id: ID }, { status: 422 })],
    ["a server error", () => Response.json({ id: ID }, { status: 500 })],
    [
      "an unreachable Resend",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("%s: no accepted line", async (_name, answer) => {
    for (const send of Object.values(senders)) {
      captureStreams();
      const { fetch } = recorder(answer);
      expect((await send("customer.name@gmail.com", fetch)).ok).toBe(false);
      // The enabling condition: the failure is logged, on the error stream.
      expect(stderr).toHaveLength(1);
      expect(stdout).toEqual([]);
    }
  });
});
