import { NextResponse } from "next/server";

/**
 * A proxy that runs on no request. It exists only to shadow another file.
 *
 * Turbopack's root is the repository root (next.config.ts), and when this
 * package has no proxy or middleware file of its own, the build compiles the
 * one at that root: the marketing site's middleware.ts, which answers 406 on /
 * to a JSON Accept and rewrites to /_agent/*.md files this app does not have.
 * With this file present, the build takes it and leaves that one alone.
 *
 * proxy.test.ts pins only this file. That the build prefers it to the root
 * middleware.ts is Turbopack behaviour (measured on Next 16.3.8, 2026-10-20),
 * so whoever upgrades Next checks that a local `next build` still compiles
 * this matcher and not the root file's "/" and "/docs/:path*": see
 * .next/server/functions-config-manifest.json and middleware-manifest.json.
 */
export function proxy(): NextResponse {
  return NextResponse.next();
}

// No route lives here, so nothing goes through the proxy.
export const config = { matcher: ["/_storefront-no-proxy"] };
