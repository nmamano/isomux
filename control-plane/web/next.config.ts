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
 * lockfiles: this IS the workspace. The root also holds the marketing site's
 * middleware.ts, which the build would compile without proxy.ts here.
 */
const repoRoot = path.join(import.meta.dirname, "..", "..");

// next dev serves plain http, where upgrade-insecure-requests turns every
// redirect a fetch follows into an https request the dev server cannot answer.
// A production build bakes these headers with NODE_ENV=production, so it keeps
// the directive.
const securityHeaders = () => [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; base-uri 'self'; connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com; font-src 'self' https://fonts.gstatic.com; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; img-src 'self' data: https://www.google-analytics.com https://*.google-analytics.com; object-src 'none'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" +
      (process.env.NODE_ENV === "production"
        ? "; upgrade-insecure-requests"
        : ""),
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

// Page-data workers for one build. Only scripts/web-build.ts sets this, on the
// run after a build worker crashed; otherwise Next keeps its own count.
const workers = process.env.ISOMUX_WEB_BUILD_WORKERS ?? "";
const cpus = /^[1-9]\d*$/.test(workers) ? Number(workers) : undefined;

const config: NextConfig = {
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into this directory and
  // re-creates them when they are removed. Agent instructions that appear from
  // a dependency are not something this repository carries silently, and
  // CLAUDE.md is not ours to write.
  agentRules: false,
  turbopack: { root: repoRoot },
  ...(cpus === undefined ? {} : { experimental: { cpus } }),
  outputFileTracingRoot: repoRoot,
  // The site uses no next/image, so the image optimizer is only attack surface.
  // `unoptimized` makes /_next/image answer 404. `maximumDiskCacheSize: 0` is
  // needed as well: Next creates .next/cache/images at the first such request,
  // before it checks `unoptimized`. In the VPS image the node user cannot write
  // there, and nothing awaits that promise, so it logged an unhandled EACCES
  // rejection once per process.
  images: { unoptimized: true, maximumDiskCacheSize: 0 },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders() },
      // A customer's private status link is in the path. AFTER the entry
      // above, because the later Referrer-Policy wins.
      {
        source: "/status/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The enterprise account page shows the account's secret.
      ...["/enterprise", "/enterprise/:path*"].map((source) => ({
        source,
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      })),
    ];
  },
};

export default config;
