// The app-host sign-in handshake, unit layer (phase 3, slice 4).
//
// Everything here is the part of server/app-auth.ts that needs no server and
// that the real-server suite cannot reach: the return-path validator and the
// navigation predicate case by case, a clock, the rate limiters and the table
// ceilings. The handshake driven end to end through the REAL server, including
// single use, the return path riding the server-side record, revalidation
// against the office session and the cookie lines, lives in
// app-auth-handshake.test.ts.
//
// What this freezes:
//   - `r` IS A PATH. The open-redirect surface of the whole feature is one
//     function, so its refusals are pinned individually rather than sampled.
//     Raw control characters are only testable here: by the time a request has
//     been through Bun's URL parser they are encoded or gone.
//   - SINGLE USE IS UNCONDITIONAL. A well-formed code is consumed by the act of
//     presenting it - before the expiry check, before the host check, and
//     before the rate limiter is charged. A malformed one never reaches the
//     table or the limiter at all.
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
  _testResetAppAuth,
  mayInitiateHandshake,
  mintAppCode,
  readAppCookie,
  redeemAppCode,
  startAppSession,
  validateReturnPath,
} from "../app-auth.ts";

const HOST = "hello.office.example";
const LABEL = "hello";
const CLIENT = "203.0.113.10";
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

function mintFor(officeSessionHash: string, now: number) {
  return mintAppCode(
    {
      label: LABEL,
      hostGen: 1,
      appHost: HOST,
      officeSessionHash,
      returnPath: "/",
    },
    now,
  );
}

// A presentation at the app host the code was minted for, at 1_000_050 unless
// a field says otherwise.
function present(
  code: string | null,
  ctx: Partial<{
    host: string;
    label: string;
    client: string;
    now: number;
  }> = {},
) {
  return redeemAppCode(code, {
    host: HOST,
    label: LABEL,
    client: CLIENT,
    now: 1_000_050,
    ...ctx,
  });
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
  it("keeps a real path verbatim, and defaults an absent one to /", () => {
    expect(validateReturnPath(null)).toBe("/");
    expect(validateReturnPath("/")).toBe("/");
    expect(validateReturnPath("/a/b")).toBe("/a/b");
    expect(validateReturnPath("/a/b?x=1&y=2")).toBe("/a/b?x=1&y=2");
    expect(validateReturnPath("/caf%C3%A9/men%C3%BC")).toBe(
      "/caf%C3%A9/men%C3%BC",
    );
    // A single encoded slash is a path segment, not a second leading slash.
    expect(validateReturnPath("/%2Fnot-authority")).toBe("/%2Fnot-authority");
    // A userinfo trick still needs a `//` or a scheme to work.
    expect(validateReturnPath("/@evil.example")).toBe("/@evil.example");
    // The length bound, from the accepted side.
    expect(validateReturnPath(`/${"a".repeat(2047)}`)).toBe(
      `/${"a".repeat(2047)}`,
    );
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
  });

  it("refuses an empty, over-long or dirty value that could split a Location header", () => {
    // Present but empty is not absent.
    expect(validateReturnPath("")).toBeNull();
    expect(validateReturnPath(`/${"a".repeat(2048)}`)).toBeNull();
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
});

describe("mayInitiateHandshake", () => {
  const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  it("accepts a GET with the exact navigation pair, or with no Sec-Fetch metadata at all", () => {
    expect(mayInitiateHandshake(req(NAV))).toBe(true);
    // Sec-Fetch-Site does not matter once the pair is there.
    expect(
      mayInitiateHandshake(req({ ...NAV, "sec-fetch-site": "cross-site" })),
    ).toBe(true);
    // The compatibility arm, and it is a ruling rather than an oversight: a
    // client that never sends Fetch Metadata would otherwise be unable to sign
    // in to an app at all. It is NOT a claim that such a client is safe - its
    // context simply cannot be told apart from a navigation's.
    expect(mayInitiateHandshake(req())).toBe(true);
    expect(mayInitiateHandshake(req({ accept: "text/html" }))).toBe(true);
    expect(mayInitiateHandshake(req({ cookie: "x=1" }))).toBe(true);
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

  it("refuses any other Sec-Fetch combination: another mode or destination, a partial pair, a re-cased value", () => {
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
    // ANY Sec-Fetch header means the client speaks Fetch Metadata, so the
    // exact pair becomes mandatory - a partial signal is not the compatibility
    // arm.
    const partials: Record<string, string>[] = [
      { "sec-fetch-mode": "navigate" },
      { "sec-fetch-dest": "document" },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-user": "?1" },
    ];
    for (const partial of partials) {
      expect(mayInitiateHandshake(req(partial))).toBe(false);
    }
    // Compared exactly.
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
});

describe("app sign-in codes", () => {
  it("expires", () => {
    const code = mint();
    const atExpiry = 1_000_000 + APP_CODE_TTL_MS;
    expect(present(code, { now: atExpiry })).toBeNull();
    // And a code redeemed one tick earlier would have worked.
    expect(present(mint(), { now: atExpiry - 1 })).not.toBeNull();
  });

  it("is bound to the exact app host it was minted for", () => {
    // Same label, another host: only the host check can refuse it.
    const code = mint();
    expect(present(code, { host: "other.office.example" })).toBeNull();
  });

  it("is bound to the label, so a code cannot be moved between apps", () => {
    // Same host, another label: only the label check can refuse it.
    const code = mint({ label: "other", appHost: "other.office.example" });
    expect(present(code, { host: "other.office.example" })).toBeNull();
  });

  it("refuses a malformed code before it reaches the table or the redeem budget", () => {
    const code = mint();
    const malformed = [
      null,
      "",
      "not base64url!",
      "has space",
      "a".repeat(65),
      `${code}=`,
    ];
    // Each malformed value is presented past the client's whole redeem
    // budget. Were any of them hashed and charged, the real code below would
    // be refused.
    for (let i = 0; i <= APP_REDEEM_MAX_PER_WINDOW; i++) {
      for (const bogus of malformed) expect(present(bogus)).toBeNull();
    }
    expect(present(code)?.returnPath).toBe("/");
  });

  it("charges the redeem budget per client, and consumes a code it refuses", () => {
    const noisy = "198.51.100.7";
    for (let i = 0; i < APP_REDEEM_MAX_PER_WINDOW; i++) {
      present("Zm9vYmFy", { client: noisy });
    }
    // The noisy client is over its budget, so its presentation is refused...
    const code = mint();
    expect(present(code, { client: noisy })).toBeNull();
    // ...and that refusal spent the code: DELETE comes before the limiter, so a
    // replay from a client with budget left finds nothing.
    expect(present(code)).toBeNull();
    // A different client still redeems a fresh code at the same label.
    expect(present(mint())).not.toBeNull();
  });

  it("rate-limits minting per office session", () => {
    for (let i = 0; i < APP_MINT_MAX_PER_WINDOW; i++) {
      expect(mintFor(SESSION_HASH, 1_000_000)).toHaveProperty("code");
    }
    expect(mintFor(SESSION_HASH, 1_000_000)).toEqual({ error: "rate_limited" });
    // Another session is unaffected, and the window rolls.
    expect(mintFor("b".repeat(64), 1_000_000)).toHaveProperty("code");
    expect(mintFor(SESSION_HASH, 1_000_000 + 60_000)).toHaveProperty("code");
  });

  it("refuses to mint rather than evict when the code table is full", () => {
    let lastError: string | null = null;
    for (let i = 0; i < 600; i++) {
      const res = mintFor(`s${i}`.padEnd(64, "0"), 1_000_000);
      if ("error" in res) {
        lastError = res.error;
        break;
      }
    }
    expect(lastError).toBe("no_capacity");
  });
});

describe("app sessions", () => {
  const session = (absoluteExpiresAt: number, now: number) =>
    startAppSession(
      {
        label: LABEL,
        hostGen: 1,
        officeSessionHash: SESSION_HASH,
        absoluteExpiresAt,
      },
      now,
    );

  it("caps its own lifetime by the office session's absolute expiry", () => {
    const now = 1_000_000;
    expect(session(5_000_000_000_000, now)?.maxAgeSec).toBe(
      APP_SESSION_TTL_MS / 1000,
    );
    expect(session(now + 30_000, now)?.maxAgeSec).toBe(30);
  });

  it("fails rather than issuing a cookie the browser deletes on arrival", () => {
    const now = 1_000_000;
    expect(session(now, now)).toBeNull();
    expect(session(now + 999, now)).toBeNull();
    expect(session(now - 1, now)).toBeNull();
  });
});

describe("the app cookie", () => {
  it("reads the first occurrence of its own name and nothing else", () => {
    const read = (cookie: string) =>
      readAppCookie(new Request(`https://${HOST}/`, { headers: { cookie } }));
    expect(read(`${APP_COOKIE_NAME}=abc`)).toBe("abc");
    expect(read(`other=1; ${APP_COOKIE_NAME}=abc; more=2`)).toBe("abc");
    expect(read("isomux_session=abc")).toBeNull();
    expect(read("__Host-isomux_session=abc")).toBeNull();
    expect(read("")).toBeNull();
    // PRESENT with an empty value is "" and not null: it never authenticates,
    // but it is something in the browser that has to be cleared.
    expect(read(`${APP_COOKIE_NAME}=`)).toBe("");
    // RFC 6265 has the browser send the more specific match first; a later
    // duplicate injected by anything else must not displace it.
    expect(read(`${APP_COOKIE_NAME}=real; ${APP_COOKIE_NAME}=fake`)).toBe(
      "real",
    );
  });
});
