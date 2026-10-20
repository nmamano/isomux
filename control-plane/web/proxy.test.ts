// The proxy the storefront build compiles leaves every storefront path alone.
//
// Turbopack's root is the repository root (next.config.ts), and when this
// package has no proxy or middleware file of its own, the build compiles the one
// at that root: the marketing site's middleware.ts, which answers 406 on / to an
// Accept it does not negotiate. So the file under test is whichever the build
// takes first, in the order below; the matchers are compiled by Next itself.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NextConfig } from "next";
import * as staticInfo from "next/dist/build/analysis/get-page-static-info";
import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import nextConfig from "./next.config";

// The function the build compiles a matcher with. Next exports it at runtime
// but leaves it out of the declaration file.
const { getMiddlewareMatchers } = staticInfo as unknown as {
  getMiddlewareMatchers: (
    matcher: unknown,
    config: NextConfig,
  ) => ProxyMatcher[];
};

const turbopackRoot = nextConfig.turbopack?.root ?? "";
const CANDIDATES = [
  path.join(import.meta.dir, "proxy.ts"),
  path.join(import.meta.dir, "middleware.ts"),
  path.join(turbopackRoot, "proxy.ts"),
  path.join(turbopackRoot, "middleware.ts"),
];

const STOREFRONT_PATHS = [
  "/",
  "/docs",
  "/docs/x",
  "/signin",
  "/signup",
  "/api/session",
  "/api/auth/session",
];

function matches(matcher: unknown, pathname: string): boolean {
  return getMiddlewareMatchers(matcher, nextConfig).some((m) =>
    new RegExp(m.regexp).test(pathname),
  );
}

describe("the storefront build's proxy", () => {
  test("the instrument: Next's compiled matchers see the paths they name", () => {
    expect(turbopackRoot).not.toBe("");
    expect(matches(["/", "/docs/:path*"], "/")).toBe(true);
    expect(matches(["/", "/docs/:path*"], "/docs/x")).toBe(true);
    expect(matches(["/docs/:path*"], "/signin")).toBe(false);
  });

  test("matches no storefront path", async () => {
    const file = CANDIDATES.find((candidate) => fs.existsSync(candidate));
    expect(file).toBeDefined();
    const { config } = await import(file as string);
    // A proxy without a matcher runs on every request.
    expect(config?.matcher).toBeDefined();
    const matched = STOREFRONT_PATHS.filter((p) => matches(config.matcher, p));
    const shown = path.relative(turbopackRoot, file as string);
    expect({ file: shown, matched }).toEqual({ file: shown, matched: [] });
  });
});
