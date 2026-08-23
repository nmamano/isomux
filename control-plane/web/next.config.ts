import * as path from "node:path";
import type { NextConfig } from "next";

/**
 * The repository root, and it has to be this rather than the package directory.
 *
 * This app is a package inside the repository, and the code it exists to serve -
 * the signup and projection services - lives one level up in `control-plane/`.
 * Turbopack refuses to resolve anything above its root, so pointing the root at
 * this directory made every service import a "module not found". The repository
 * root is also the honest answer to the question Next asks when it finds two
 * lockfiles: this IS the workspace.
 */
const repoRoot = path.join(import.meta.dirname, "..", "..");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; base-uri 'self'; connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com; font-src 'self' https://fonts.gstatic.com; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; img-src 'self' data: https://www.google-analytics.com https://*.google-analytics.com; object-src 'none'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://va.vercel-scripts.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; upgrade-insecure-requests",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

const config: NextConfig = {
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into this directory and
  // re-creates them when they are removed. Agent instructions that appear from
  // a dependency are not something this repository carries silently, and
  // CLAUDE.md is not ours to write.
  agentRules: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
