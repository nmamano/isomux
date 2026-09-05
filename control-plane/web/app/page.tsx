import { HomeView } from "./home-view";

/**
 * The landing page, prerendered.
 *
 * It used to be `force-dynamic` and ask `auth()` while it rendered, which made
 * every visitor - including the ones who were never signed in - pay a round trip
 * to the origin region for a page whose signed-out body is the same for all of
 * them. Measured 2026-08-23 in task f4a8fca7: TTFB was very nearly the whole
 * response time, 0.256s to 2.227s from an EU edge to iad1.
 *
 * A page that reads the session cookie can never be held by a shared cache, so
 * the fix is not a flag: the session question moves off the render and into
 * `/api/session`, and `HomeView` asks it after this shell has painted.
 *
 * `dynamic = "error"` rather than "force-static": "force-static" would make a
 * future `cookies()` or `auth()` return empty and quietly serve a stale shell,
 * where "error" fails the build. The invariant this page now carries is worth a
 * build failure, not a silent repair.
 */
export const dynamic = "error";

export default function Home() {
  return <HomeView />;
}
