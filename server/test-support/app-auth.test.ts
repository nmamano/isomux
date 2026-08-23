// The app-host sign-in handshake, unit layer (phase 3, slice 4).
//
// Everything here is the part of server/app-auth.ts that needs no server: the
// return-path validator, the navigation predicate, the code table and the
// app-session table. The handshake driven end to end through the REAL server
// lives in app-auth-handshake.test.ts.
//
// What this freezes:
//   - `r` IS A PATH. The open-redirect surface of the whole feature is one
//     function, so its refusals are pinned individually rather than sampled.
//     Raw control characters are only testable here: by the time a request has
//     been through Bun's URL parser they are encoded or gone.
//   - SINGLE USE IS UNCONDITIONAL. A well-formed code is consumed by the act of
//     presenting it - before the expiry check, before the host check, and
//     before the rate limiter is charged. The replay test would still pass if
//     the delete happened later, so the rate-limited case is tested too: that
//     one only passes if the delete really is first.
//   - The two tables' ceilings, and the OPPOSITE failure postures of the two
//     limiters (mint refuses when full, redeem allows) - each is a deliberate
//     choice and each would be silently reversible without a test.
//   - An app session never outlives the office session it was minted from, and
//     a zero-second lifetime is a FAILURE rather than a cookie the browser
//     deletes on arrival.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  APP_CODE_TTL_MS,
  APP_COOKIE_NAME,
  APP_MINT_MAX_PER_WINDOW,
  APP_REDEEM_MAX_PER_WINDOW,
  APP_SESSION_TTL_MS,
  _testPendingCodeCount,
  _testResetAppAuth,
  appCookieClearLine,
  mayInitiateHandshake,
  mintAppCode,
  readAppCookie,
  redeemAppCode,
  startAppSession,
  validateAppSession,
  validateReturnPath,
} from "../app-auth.ts";

const HOST = "hello.office.example";
const LABEL = "hello";
const SESSION_HASH = "a".repeat(64);

function mint(
  overrides: Partial<{
    label: string;
    hostGen: number;
    appHost: string;
    officeSessionHash: string;
    returnPath: string;
  }> = {},
  now = 1_000_000,
): string {
  const res = mintAppCode(
    {
      label: LABEL,
      hostGen: 1,
      appHost: HOST,
      officeSessionHash: SESSION_HASH,
      returnPath: "/",
      ...overrides,
    },
    now,
  );
  if ("error" in res) throw new Error(`mint failed: ${res.error}`);
  return res.code;
}

function req(
  headers: Record<string, string> = {},
  method = "GET",
  url = `https://${HOST}/`,
): Request {
  return new Request(url, { method, headers });
}

beforeEach(() => {
  _testResetAppAuth();
});

describe("validateReturnPath", () => {
  it("keeps a real path verbatim, query and percent-encoding included", () => {
    expect(validateReturnPath("/")).toBe("/");
    expect(validateReturnPath("/a/b")).toBe("/a/b");
    expect(validateReturnPath("/a/b?x=1&y=2")).toBe("/a/b?x=1&y=2");
    expect(validateReturnPath("/caf%C3%A9/men%C3%BC")).toBe(
      "/caf%C3%A9/men%C3%BC",
    );
    // A single encoded slash is a path segment, not a second leading slash.
    expect(validateReturnPath("/%2Fnot-authority")).toBe("/%2Fnot-authority");
  });

  it("defaults to / when absent, and refuses an empty value", () => {
    expect(validateReturnPath(null)).toBe("/");
    expect(validateReturnPath("")).toBeNull();
  });

  it("refuses everything that could leave the app host", () => {
    // Protocol-relative: a browser reads the authority after `//`.
    expect(validateReturnPath("//evil.example")).toBeNull();
    expect(validateReturnPath("//evil.example/path")).toBeNull();
    // Absolute URLs in any shape - none of them start with a single slash.
    expect(validateReturnPath("https://evil.example")).toBeNull();
    expect(validateReturnPath("http://evil.example")).toBeNull();
    expect(validateReturnPath("evil.example")).toBeNull();
    // Backslash: historically read as an authority separator.
    expect(validateReturnPath("/\\evil.example")).toBeNull();
    expect(validateReturnPath("\\\\evil.example")).toBeNull();
    expect(validateReturnPath("/path/\\evil")).toBeNull();
    // A userinfo trick still needs a `//` or a scheme to work.
    expect(validateReturnPath("/@evil.example")).toBe("/@evil.example");
  });

  it("refuses anything that could split or dirty a Location header", () => {
    expect(validateReturnPath("/a\r\nX-Injected: 1")).toBeNull();
    expect(validateReturnPath("/a\nX")).toBeNull();
    expect(validateReturnPath("/a\rX")).toBeNull();
    expect(validateReturnPath("/a\tb")).toBeNull();
    expect(validateReturnPath("/a b")).toBeNull();
    expect(validateReturnPath("/a\u0000b")).toBeNull();
    expect(validateReturnPath("/a\u007fb")).toBeNull();
    // Non-ASCII: browsers percent-encode it, so a raw one is hand-written.
    expect(validateReturnPath("/caf\u00e9")).toBeNull();
    // A fragment never reaches a server, so one arriving here is hand-written.
    expect(validateReturnPath("/a#frag")).toBeNull();
  });

  it("refuses an over-long path", () => {
    expect(validateReturnPath(`/${"a".repeat(2047)}`)).toBeTruthy();
    expect(validateReturnPath(`/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("mayInitiateHandshake", () => {
  const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  it("accepts a GET carrying the exact navigation pair", () => {
    expect(mayInitiateHandshake(req(NAV))).toBe(true);
  });

  it("refuses every method but GET, navigation pair or not", () => {
    // HEAD is out DELIBERATELY (manager ruling): it could start the flow, but
    // the callback is GET-only, so a client that preserved the method across
    // the redirect would be stranded at the second hop instead of the first.
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(mayInitiateHandshake(req(NAV, method))).toBe(false);
      expect(mayInitiateHandshake(req({}, method))).toBe(false);
    }
  });

  it("refuses every other fetch mode and destination", () => {
    for (const mode of ["cors", "same-origin", "no-cors", "websocket"]) {
      expect(
        mayInitiateHandshake(
          req({ "sec-fetch-mode": mode, "sec-fetch-dest": "document" }),
        ),
      ).toBe(false);
    }
    for (const dest of ["", "empty", "script", "image", "iframe", "style"]) {
      expect(
        mayInitiateHandshake(
          req({ "sec-fetch-mode": "navigate", "sec-fetch-dest": dest }),
        ),
      ).toBe(false);
    }
  });

  it("refuses a partial pair - one Sec-Fetch header present is ambiguous", () => {
    expect(mayInitiateHandshake(req({ "sec-fetch-mode": "navigate" }))).toBe(
      false,
    );
    expect(mayInitiateHandshake(req({ "sec-fetch-dest": "document" }))).toBe(
      false,
    );
    expect(
      mayInitiateHandshake(req({ ...NAV, "sec-fetch-site": "cross-site" })),
    ).toBe(true);
    // Sec-Fetch metadata present but not the navigation pair, even partially:
    // this is the case the compatibility arm must NOT swallow.
    expect(mayInitiateHandshake(req({ "sec-fetch-site": "same-origin" }))).toBe(
      false,
    );
    expect(
      mayInitiateHandshake(req({ ...NAV, "sec-fetch-mode": "cors" })),
    ).toBe(false);
  });

  it("compares values exactly, so a re-cased value is refused", () => {
    expect(
      mayInitiateHandshake(
        req({ "sec-fetch-mode": "Navigate", "sec-fetch-dest": "document" }),
      ),
    ).toBe(false);
    expect(
      mayInitiateHandshake(
        req({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "DOCUMENT" }),
      ),
    ).toBe(false);
  });

  it("accepts a GET with NO Sec-Fetch metadata at all", () => {
    // The compatibility arm, and it is a ruling rather than an oversight: a
    // client that never sends Fetch Metadata would otherwise be unable to sign
    // in to an app at all. It is NOT a claim that such a client is safe - it
    // can be made to issue a cross-site request and can carry cookies; the
    // absence of the headers is exactly why its context cannot be told apart
    // from a navigation's.
    expect(mayInitiateHandshake(req())).toBe(true);
    expect(mayInitiateHandshake(req({ accept: "text/html" }))).toBe(true);
    expect(mayInitiateHandshake(req({ cookie: "x=1" }))).toBe(true);
    // But ANY Sec-Fetch header means the client speaks Fetch Metadata, so the
    // exact pair becomes mandatory - a partial signal is not the arm above.
    expect(mayInitiateHandshake(req({ "sec-fetch-user": "?1" }))).toBe(false);
    expect(mayInitiateHandshake(req({ "sec-fetch-site": "none" }))).toBe(false);
  });
});

describe("app sign-in codes", () => {
  it("redeems once, and the second attempt fails", () => {
    const code = mint();
    const first = redeemAppCode(code, {
      host: HOST,
      label: LABEL,
      now: 1_000_100,
    });
    expect(first?.returnPath).toBe("/");
    expect(
      redeemAppCode(code, { host: HOST, label: LABEL, now: 1_000_100 }),
    ).toBeNull();
  });

  it("carries the return path server-side instead of in the callback URL", () => {
    const code = mint({ returnPath: "/deep/path?x=1" });
    const record = redeemAppCode(code, {
      host: HOST,
      label: LABEL,
      now: 1_000_100,
    });
    expect(record?.returnPath).toBe("/deep/path?x=1");
    expect(record?.hostGen).toBe(1);
    expect(record?.officeSessionHash).toBe(SESSION_HASH);
  });

  it("expires", () => {
    const code = mint();
    const atExpiry = 1_000_000 + APP_CODE_TTL_MS;
    expect(
      redeemAppCode(code, { host: HOST, label: LABEL, now: atExpiry }),
    ).toBeNull();
    // And a code redeemed one tick earlier would have worked.
    const other = mint();
    expect(
      redeemAppCode(other, { host: HOST, label: LABEL, now: atExpiry - 1 }),
    ).not.toBeNull();
  });

  it("is bound to the exact app host it was minted for", () => {
    const code = mint();
    expect(
      redeemAppCode(code, {
        host: "other.office.example",
        label: LABEL,
        now: 1_000_100,
      }),
    ).toBeNull();
  });

  it("is bound to the label, so a code cannot be moved between apps", () => {
    const code = mint({ label: "other", appHost: "other.office.example" });
    expect(
      redeemAppCode(code, {
        host: "other.office.example",
        label: LABEL,
        now: 1_000_100,
      }),
    ).toBeNull();
  });

  it("refuses malformed codes without touching the table", () => {
    const code = mint();
    for (const bogus of [
      null,
      "",
      "not base64url!",
      "has space",
      "a".repeat(65),
      `${code}=`,
    ]) {
      expect(
        redeemAppCode(bogus, { host: HOST, label: LABEL, now: 1_000_100 }),
      ).toBeNull();
    }
    // The real code still works: none of the above consumed it.
    expect(
      redeemAppCode(code, { host: HOST, label: LABEL, now: 1_000_100 }),
    ).not.toBeNull();
  });

  it("consumes a valid code even when the redeem budget is spent", () => {
    // This is the test that pins DELETE-BEFORE-LIMITER, and it has to look at
    // the table to do it: both orders REFUSE the over-budget presentation, so
    // the only observable difference is whether the code is still sitting there
    // afterwards, replayable once the window rolls. (Waiting for the window is
    // not an option - by then the code has expired for an unrelated reason,
    // which is exactly how the weaker version of this test passed.)
    const code = mint();
    expect(_testPendingCodeCount()).toBe(1);
    for (let i = 0; i < APP_REDEEM_MAX_PER_WINDOW; i++) {
      redeemAppCode("Zm9vYmFy", { host: HOST, label: LABEL, now: 1_000_050 });
    }
    expect(
      redeemAppCode(code, { host: HOST, label: LABEL, now: 1_000_050 }),
    ).toBeNull();
    expect(_testPendingCodeCount()).toBe(0);
  });

  it("rate-limits minting per office session", () => {
    for (let i = 0; i < APP_MINT_MAX_PER_WINDOW; i++) {
      expect(
        mintAppCode(
          {
            label: LABEL,
            hostGen: 1,
            appHost: HOST,
            officeSessionHash: SESSION_HASH,
            returnPath: "/",
          },
          1_000_000,
        ),
      ).toHaveProperty("code");
    }
    expect(
      mintAppCode(
        {
          label: LABEL,
          hostGen: 1,
          appHost: HOST,
          officeSessionHash: SESSION_HASH,
          returnPath: "/",
        },
        1_000_000,
      ),
    ).toEqual({ error: "rate_limited" });
    // Another session is unaffected, and the window rolls.
    expect(
      mintAppCode(
        {
          label: LABEL,
          hostGen: 1,
          appHost: HOST,
          officeSessionHash: "b".repeat(64),
          returnPath: "/",
        },
        1_000_000,
      ),
    ).toHaveProperty("code");
    expect(
      mintAppCode(
        {
          label: LABEL,
          hostGen: 1,
          appHost: HOST,
          officeSessionHash: SESSION_HASH,
          returnPath: "/",
        },
        1_000_000 + 60_000,
      ),
    ).toHaveProperty("code");
  });

  it("refuses to mint rather than evict when the code table is full", () => {
    let lastError: string | null = null;
    for (let i = 0; i < 600; i++) {
      const res = mintAppCode(
        {
          label: LABEL,
          hostGen: 1,
          appHost: HOST,
          officeSessionHash: `s${i}`.padEnd(64, "0"),
          returnPath: "/",
        },
        1_000_000,
      );
      if ("error" in res) {
        lastError = res.error;
        break;
      }
    }
    expect(lastError).toBe("no_capacity");
  });
});

describe("app sessions", () => {
  const ABSOLUTE = 5_000_000_000_000;

  it("caps its own lifetime by the office session's absolute expiry", () => {
    const now = 1_000_000;
    const long = startAppSession(
      {
        label: LABEL,
        hostGen: 1,
        officeSessionHash: SESSION_HASH,
        absoluteExpiresAt: ABSOLUTE,
      },
      now,
    );
    expect(long?.maxAgeSec).toBe(APP_SESSION_TTL_MS / 1000);
    const short = startAppSession(
      {
        label: LABEL,
        hostGen: 1,
        officeSessionHash: SESSION_HASH,
        absoluteExpiresAt: now + 30_000,
      },
      now,
    );
    expect(short?.maxAgeSec).toBe(30);
  });

  it("fails rather than issuing a cookie the browser deletes on arrival", () => {
    const now = 1_000_000;
    expect(
      startAppSession(
        {
          label: LABEL,
          hostGen: 1,
          officeSessionHash: SESSION_HASH,
          absoluteExpiresAt: now,
        },
        now,
      ),
    ).toBeNull();
    expect(
      startAppSession(
        {
          label: LABEL,
          hostGen: 1,
          officeSessionHash: SESSION_HASH,
          absoluteExpiresAt: now + 999,
        },
        now,
      ),
    ).toBeNull();
    expect(
      startAppSession(
        {
          label: LABEL,
          hostGen: 1,
          officeSessionHash: SESSION_HASH,
          absoluteExpiresAt: now - 1,
        },
        now,
      ),
    ).toBeNull();
  });

  it("refuses a cookie whose office session does not exist", () => {
    // SESSION_HASH names no real session, so validation fails at the office
    // revalidation step even though every other field matches. The positive
    // path needs a real office session and lives in the handshake test.
    const started = startAppSession(
      {
        label: LABEL,
        hostGen: 1,
        officeSessionHash: SESSION_HASH,
        absoluteExpiresAt: ABSOLUTE,
      },
      1_000_000,
    );
    expect(started).not.toBeNull();
    expect(
      validateAppSession(started!.token, {
        label: LABEL,
        hostGen: 1,
        now: 1_000_100,
      }),
    ).toBeNull();
  });

  it("refuses malformed and unknown cookie values", () => {
    for (const bogus of [null, "", "not base64url!", "a".repeat(65)]) {
      expect(
        validateAppSession(bogus, { label: LABEL, hostGen: 1, now: 1_000_100 }),
      ).toBeNull();
    }
  });
});

describe("the app cookie", () => {
  it("reads its own name and ignores everything else", () => {
    const read = (cookie: string) =>
      readAppCookie(new Request(`https://${HOST}/`, { headers: { cookie } }));
    expect(read(`${APP_COOKIE_NAME}=abc`)).toBe("abc");
    expect(read(`other=1; ${APP_COOKIE_NAME}=abc; more=2`)).toBe("abc");
    expect(read("isomux_session=abc")).toBeNull();
    expect(read("__Host-isomux_session=abc")).toBeNull();
    // PRESENT with an empty value is "" and not null: it never authenticates,
    // but it is something in the browser that has to be cleared.
    expect(read(`${APP_COOKIE_NAME}=`)).toBe("");
    expect(read("")).toBeNull();
  });

  it("takes the FIRST occurrence of its name, never a later duplicate", () => {
    // RFC 6265 has the browser send the more specific match first; a later
    // duplicate injected by anything else must not displace it.
    const read = readAppCookie(
      new Request(`https://${HOST}/`, {
        headers: { cookie: `${APP_COOKIE_NAME}=real; ${APP_COOKIE_NAME}=fake` },
      }),
    );
    expect(read).toBe("real");
  });

  it("clears with the attributes the __Host- prefix requires", () => {
    expect(appCookieClearLine()).toBe(
      `${APP_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    );
  });
});
