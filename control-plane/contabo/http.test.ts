// The transport keeps the provider's error body in its reason, redacted and
// bounded (task 2db7c3f5), and still classifies the status as before.

import { describe, expect, test } from "bun:test";
import { ContaboHttp } from "./http.ts";
import { TokenProvider, type FetchLike } from "./auth.ts";

const TOKEN = "plain-token-value";

/** One token grant, then one reply whose json() gives `body` or throws. */
function httpOver(status: number, body: () => Promise<unknown>) {
  const queue = [
    {
      status: 200,
      json: () => Promise.resolve({ access_token: TOKEN, expires_in: 3600 }),
    },
    { status, json: body },
  ];
  const fetchImpl: FetchLike = (url) => {
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: next.json,
    });
  };
  return new ContaboHttp({
    fetchImpl,
    tokens: new TokenProvider(
      { clientId: "c", clientSecret: "s", apiUser: "u", apiPassword: "p" },
      fetchImpl,
    ),
    requestId: () => "fixed-request-id",
  });
}

const json = (value: unknown) => () => Promise.resolve(value);
const request = { productId: "V45", region: "EU", defaultUser: "root" };

describe("the provider's error body stays in the reason", () => {
  test("a 5xx stays ambiguous and keeps the provider's message", async () => {
    const r = await httpOver(
      500,
      json({
        statusCode: 500,
        message: "Internal error while creating secret",
      }),
    ).request("POST", "/v1/compute/instances", request);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.reason).toContain("500");
    expect(r.reason).toContain("Internal error while creating secret");
  });

  test("a 4xx stays a rejection with its status, and request values in the message survive", async () => {
    const r = await httpOver(
      422,
      json({ message: "productId V45 not available in region EU for root" }),
    ).request("POST", "/v1/compute/instances", request);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.status).toBe(422);
    expect(r.reason).toContain(
      "productId V45 not available in region EU for root",
    );
  });

  test("an unreadable or empty body leaves the reason as it was", async () => {
    const cases: [number, () => Promise<unknown>][] = [
      [503, () => Promise.reject(new SyntaxError("Unexpected token <"))],
      [503, json(null)],
      [404, () => Promise.reject(new SyntaxError("Unexpected token <"))],
      [404, json(null)],
    ];
    for (const [status, body] of cases) {
      const r = await httpOver(status, body).request("GET", "/v1/x");
      expect(r.kind).toBe(status === 503 ? "ambiguous" : "rejected");
      expect("reason" in r && r.reason).toMatch(new RegExp(`HTTP ${status}$`));
    }
  });

  test("the bearer token, emails and credential shapes in an echoed body are redacted", async () => {
    const long = "c".repeat(43);
    const r = await httpOver(
      500,
      json({
        message: "failed\n\trequest",
        echo: TOKEN,
        contact: "ops@example.com",
        blob: long,
      }),
    ).request("POST", "/v1/compute/instances", request);
    if (r.kind !== "ambiguous") throw new Error(`got ${r.kind}`);
    expect(r.reason).toContain("failed");
    for (const s of [TOKEN, "ops@example.com", long])
      expect(r.reason).not.toContain(s);
    expect(r.reason).not.toMatch(/[\n\r\t]/);
  });

  test("a huge body is cut to a bounded reason", async () => {
    const r = await httpOver(
      502,
      json({ message: `start ${"word ".repeat(5000)}` }),
    ).request("GET", "/v1/x");
    if (r.kind !== "ambiguous") throw new Error(`got ${r.kind}`);
    expect(r.reason).toContain("start");
    expect(Buffer.byteLength(r.reason)).toBeLessThanOrEqual(400);
  });

  test("okOrThrow carries the redacted body into its error", async () => {
    const err = await httpOver(
      500,
      json({ message: "upstream exploded", echo: TOKEN }),
    )
      .okOrThrow("GET", "/v1/x")
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err?.message).toContain("upstream exploded");
    expect(err?.message).not.toContain(TOKEN);
  });
});
