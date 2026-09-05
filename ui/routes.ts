// The office UI's four full-page views are real URLs, and this module is the
// whole mapping between a path and a page. It is pure and DOM-free on purpose
// (ruling 6 of internal-docs/url-routing-loop.md): the table is unit-tested
// here, and App's wiring is covered by the render tests instead.
//
// Agent chats and settings sections are deliberately NOT routes (ruling 3), so
// a chat, a settings section and the office all share one path, "/".

export type Page = "tasks" | "cronjobs" | "apps" | "settings";

/**
 * The page a pathname names, or null for the office.
 *
 * Trailing slashes are tolerated because a browser will follow one and the
 * route should still resolve. Matching is case-sensitive: `/Tasks` is not a
 * route, the same way it would not be on any other site.
 */
export function pageForPath(pathname: string): Page | null {
  // Only a trailing slash is forgiven. The leading slash is part of the route:
  // ruling 3 names four paths at the root, so "tasks" and "//tasks" are not
  // them. A switch rather than a lookup table, so "/constructor" cannot answer
  // with something inherited from Object.prototype.
  switch (pathname.replace(/\/+$/, "")) {
    case "/tasks":
      return "tasks";
    case "/cronjobs":
      return "cronjobs";
    case "/apps":
      return "apps";
    case "/settings":
      return "settings";
    // "users" is what the settings page was called before it was renamed, and
    // the saved-spot parser still reads that name (ui/view-persistence.ts).
    // Accepted so an old link keeps working, never produced.
    case "/users":
      return "settings";
    default:
      return null;
  }
}

/** The canonical path for a page, or "/" for the office. */
export function pathForPage(page: Page | null): string {
  return page === null ? "/" : `/${page}`;
}
