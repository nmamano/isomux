// The office Content-Security-Policy, pinned whole. The app-host suite pins
// only how the policy changes between configurations, so a directive widened
// in every configuration at once (a scheme source such as `ws:` added back to
// connect-src) passes it. These cases compare the full string the real server
// sends, so any widening is a test change a reviewer sees.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import {
  NAVIGATION_HEADERS,
  OFFICE_HOST,
  raw,
  startFlatOffice,
} from "./app-host-test-kit.ts";
import { buildPublicOrigin } from "../auth.ts";
import { untrustedFileHeaders } from "../auth-middleware.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const HTTP_OFFICE_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'self' blob: data:",
  "img-src 'self' data: blob: https:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

const HTTPS_OFFICE_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `frame-src 'self' blob: data: https://*.${OFFICE_HOST}`,
  "img-src 'self' data: blob: https:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "upgrade-insecure-requests",
].join("; ");

async function officePageCsp(port: number, host: string): Promise<string> {
  const res = await raw(port, {
    host,
    path: "/",
    headers: { ...NAVIGATION_HEADERS, Accept: "text/html" },
  });
  expect(res.headers["content-type"]).toContain("text/html");
  return res.headers["content-security-policy"];
}

describe("office CSP", () => {
  it("is exactly the pinned policy on a plain-HTTP office", async () => {
    const srv = await startTestServer();
    server = srv;
    expect(buildPublicOrigin().isHttps).toBe(false);

    expect(await officePageCsp(srv.port, "localhost")).toBe(HTTP_OFFICE_CSP);
    expect(untrustedFileHeaders()["Content-Security-Policy"]).toBe(
      `${HTTP_OFFICE_CSP}; sandbox allow-scripts`,
    );
  });

  it("is exactly the pinned policy on an HTTPS office with app hostnames", async () => {
    const srv = await startFlatOffice((s) => (server = s));
    expect(buildPublicOrigin().isHttps).toBe(true);

    expect(await officePageCsp(srv.port, OFFICE_HOST)).toBe(HTTPS_OFFICE_CSP);
    expect(untrustedFileHeaders()["Content-Security-Policy"]).toBe(
      `${HTTPS_OFFICE_CSP}; sandbox allow-scripts`,
    );
  });
});
