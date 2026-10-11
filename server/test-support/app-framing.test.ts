import { describe, expect, it } from "bun:test";
import { buildDownstreamHeaders } from "../app-proxy.ts";
import { buildPublicOrigin } from "../auth.ts";

describe("app framing headers", () => {
  it("replaces ancestors in every policy and preserves other directives and report-only", () => {
    const headers = new Headers({
      "Content-Security-Policy":
        "default-src 'none'; Frame-Ancestors 'none'; script-src 'self';",
      "Content-Security-Policy-Report-Only":
        "frame-ancestors https://report.example",
      "X-Frame-Options": "DENY",
    });
    headers.append(
      "Content-Security-Policy",
      "img-src data:; frame-ancestors https://other.example, , style-src 'self';",
    );
    const result = buildDownstreamHeaders(
      new Response("unchanged", { headers }),
    );
    const ancestor = `frame-ancestors 'self' ${buildPublicOrigin().origin}`;
    expect(result.get("Content-Security-Policy")?.split(", ")).toEqual([
      `default-src 'none'; script-src 'self'; ${ancestor}`,
      `img-src data:; ${ancestor}`,
      `style-src 'self'; ${ancestor}`,
    ]);
    expect(result.has("X-Frame-Options")).toBe(false);
    expect(result.get("Content-Security-Policy-Report-Only")).toBe(
      "frame-ancestors https://report.example",
    );
  });

  it("adds framing to headerless non-document and bodyless responses", () => {
    for (const status of [200, 204, 302, 404, 502]) {
      const result = buildDownstreamHeaders(new Response(null, { status }));
      expect(result.get("Content-Security-Policy")).toBe(
        `frame-ancestors 'self' ${buildPublicOrigin().origin}`,
      );
    }
  });
});
