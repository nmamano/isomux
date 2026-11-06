// The storefront's security headers under `next dev` and under a production
// build.
//
// `next dev` serves plain http on localhost. With upgrade-insecure-requests in
// the CSP, the browser turns every same-origin redirect a fetch follows into an
// https request that the dev server cannot answer, so a form that posts and
// follows a 303 fails with "Failed to fetch" (task ba0cf699). A production build
// (NODE_ENV=production, served over https) keeps the directive, and nothing
// else in the headers depends on the mode.

import { afterEach, describe, expect, test } from "bun:test";
import nextConfig from "./next.config";

type Header = { key: string; value: string };

// Next types NODE_ENV as read-only; the test sets it as the CLI does.
const env = process.env as Record<string, string | undefined>;
const savedNodeEnv = env.NODE_ENV;

afterEach(() => {
  if (savedNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = savedNodeEnv;
});

/** The headers next.config gives every path, under one NODE_ENV. */
async function siteHeaders(
  nodeEnv: "production" | "development",
): Promise<Header[]> {
  env.NODE_ENV = nodeEnv;
  expect(env.NODE_ENV).toBe(nodeEnv);
  const rules = (await nextConfig.headers?.()) ?? [];
  const all = rules.find((r) => r.source === "/(.*)");
  if (!all) throw new Error('next.config has no headers for "/(.*)"');
  return all.headers;
}

function cspDirectives(headers: Header[]): string[] {
  const csp = headers.filter((h) => h.key === "Content-Security-Policy");
  expect(csp).toHaveLength(1);
  return csp[0].value.split(";").map((d) => d.trim());
}

describe("storefront security headers", () => {
  test("a production build tells the browser to upgrade insecure requests", async () => {
    const directives = cspDirectives(await siteHeaders("production"));
    expect(directives).toContain("upgrade-insecure-requests");
    // The policy is a real one, not only the directive under test.
    expect(directives).toContain("default-src 'self'");
  });

  test("next dev leaves the upgrade out and keeps every other header", async () => {
    const prod = await siteHeaders("production");
    const dev = await siteHeaders("development");

    const devDirectives = cspDirectives(dev);
    expect(devDirectives).not.toContain("upgrade-insecure-requests");
    expect(devDirectives).toStrictEqual(
      cspDirectives(prod).filter((d) => d !== "upgrade-insecure-requests"),
    );

    const others = (hs: Header[]) =>
      hs.filter((h) => h.key !== "Content-Security-Policy");
    expect(others(dev)).toStrictEqual(others(prod));
    expect(others(prod).length).toBeGreaterThan(0);
  });
});
