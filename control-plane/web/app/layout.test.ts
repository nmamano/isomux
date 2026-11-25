import { describe, expect, test } from "bun:test";
import type { Metadata } from "next";
import { resolveAlternates } from "next/dist/lib/metadata/resolvers/resolve-basics";
import config from "../next.config";
import { metadata } from "./layout";

/**
 * THE CANONICAL URL every storefront page declares.
 *
 * Search Console reported https://cloud.isomux.com/?landing_path=/hosted as a
 * duplicate of `/` with no canonical the site chose. The root layout declares
 * one for every page: the page's own path on the storefront origin.
 *
 * The layout's metadata goes through Next's own resolver for `alternates`, with
 * the trailing-slash setting of next.config.ts, so the URL here is the one Next
 * writes into `<link rel="canonical">`. Next gives that resolver the request
 * PATHNAME, never the query string; that is how a query-string variant gets the
 * canonical of its page. The rendered HTML itself is not checked here.
 */
async function canonicalFor(pathname: string): Promise<string | undefined> {
  const root: Metadata = metadata;
  const resolved = await resolveAlternates(
    root.alternates,
    root.metadataBase ? new URL(root.metadataBase) : null,
    Promise.resolve(pathname),
    {
      trailingSlash: config.trailingSlash ?? false,
      isStaticMetadataRouteFile: false,
    },
  );
  const url = resolved?.canonical?.url;
  return url === undefined ? undefined : String(url);
}

describe("each page names itself as canonical, on the storefront origin", () => {
  test("the landing page is the bare origin", async () => {
    expect(await canonicalFor("/")).toBe("https://cloud.isomux.com");
  });

  test("a page is its own path, not the landing page", async () => {
    expect(await canonicalFor("/signin")).toBe(
      "https://cloud.isomux.com/signin",
    );
    expect(await canonicalFor("/status/abc/2")).toBe(
      "https://cloud.isomux.com/status/abc/2",
    );
  });
});
