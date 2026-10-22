// The framing policy every app-host response leaves with: the office, and only
// the office, may frame an app. The relay (app-host-relay.test.ts) and the
// arm's own answers (app-auth-handshake.test.ts) pin that it is applied; this
// pins how it merges with whatever policy an app sent.
import { describe, expect, it } from "bun:test";
import { setAppFramingPolicy } from "../app-framing.ts";
import { buildPublicOrigin } from "../auth.ts";

describe("app framing headers", () => {
  it("replaces ancestors in every enforced policy and preserves other directives and report-only", () => {
    const headers = new Headers({
      "Content-Security-Policy":
        "default-src 'none'; Frame-Ancestors 'none'; script-src 'self';",
      "Content-Security-Policy-Report-Only":
        "frame-ancestors https://report.example",
      "X-Frame-Options": "DENY",
    });
    // A second policy line folds into the first with a comma; each policy is
    // enforced on its own, so each must allow the office.
    headers.append(
      "Content-Security-Policy",
      "img-src data:; frame-ancestors https://other.example, , style-src 'self';",
    );
    setAppFramingPolicy(headers);
    const ancestor = `frame-ancestors 'self' ${buildPublicOrigin().origin}`;
    expect(headers.get("Content-Security-Policy")?.split(", ")).toEqual([
      `default-src 'none'; script-src 'self'; ${ancestor}`,
      `img-src data:; ${ancestor}`,
      `style-src 'self'; ${ancestor}`,
    ]);
    expect(headers.has("X-Frame-Options")).toBe(false);
    expect(headers.get("Content-Security-Policy-Report-Only")).toBe(
      "frame-ancestors https://report.example",
    );
  });

  it("adds the policy to a response that sent none", () => {
    const headers = new Headers();
    setAppFramingPolicy(headers);
    expect(headers.get("Content-Security-Policy")).toBe(
      `frame-ancestors 'self' ${buildPublicOrigin().origin}`,
    );
  });
});
