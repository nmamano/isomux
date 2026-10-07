// The office UI's full-page views are real URLs, and this module is the
// whole mapping between a path and a page. It is pure and DOM-free on purpose
// (ruling 6 of internal-docs/url-routing-loop.md): the table is unit-tested
// here, and App's wiring is covered by the render tests instead.
//
// Agent chats and settings sections are deliberately NOT routes (ruling 3), so
// a chat, a settings section and the office all share one path, "/".

export type Page = "tasks" | "cronjobs" | "apps" | "settings" | "pager";

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
    case "/pager":
      return "pager";
    // "users" is what the settings page was called before it was renamed, and
    // the saved-spot parser still reads that name (ui/view-persistence.ts).
    // Accepted so an old link keeps working, never produced.
    case "/users":
      return "settings";
    default:
      return null;
  }
}

// The longest id the deep link accepts. Ids are 16 hex characters (8 on older
// pages); the bound only keeps a pasted URL from carrying junk into the view.
const PAGER_LINK_ID_MAX = 64;

/**
 * The page id in a Discord link, `<origin>/?pager=<id>` (server/pager-delivery.ts),
 * or null. The parameter opens the pager view on any path, so the link keeps
 * working if the office ever moves its root.
 */
export function pagerIdForSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("pager")?.trim() ?? "";
  return id.length > 0 && id.length <= PAGER_LINK_ID_MAX ? id : null;
}

/** The page the URL opens at boot: the pager link first, then the path. */
export function pageForLocation(pathname: string, search: string): Page | null {
  return pagerIdForSearch(search) !== null ? "pager" : pageForPath(pathname);
}

/** The canonical path for a page, or "/" for the office. */
export function pathForPage(page: Page | null): string {
  return page === null ? "/" : `/${page}`;
}

export interface PageFlags {
  usersOpen: boolean;
  tasksOpen: boolean;
  cronjobsOpen: boolean;
  appsOpen: boolean;
  pagerOpen: boolean;
}

/** Shared by history and the rendered page switch. Flags can overlap. */
export function pageForFlags(flags: PageFlags): Page | null {
  return flags.usersOpen
    ? "settings"
    : flags.tasksOpen
      ? "tasks"
      : flags.cronjobsOpen
        ? "cronjobs"
        : flags.appsOpen
          ? "apps"
          : flags.pagerOpen
            ? "pager"
            : null;
}

export interface PageShortcutInput {
  key: string;
  isInput?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export interface PageShortcutUpdate {
  tasksOpen?: boolean | ((open: boolean) => boolean);
  cronjobsOpen?: boolean;
  appsOpen?: boolean;
  pagerOpen?: boolean;
  usersOpen?: true;
}

/** Return only the setters the existing shortcut changes. */
export function pageShortcut(
  input: PageShortcutInput,
  flags: PageFlags,
): PageShortcutUpdate | "home" | null {
  if (
    input.isInput ||
    flags.usersOpen ||
    input.metaKey ||
    input.ctrlKey ||
    input.altKey
  )
    return null;
  if (input.key === "t") {
    // Keep a functional update: two keydowns can occur before React renders.
    // Tasks deliberately leaves the other page flags set underneath it.
    return { tasksOpen: (open) => !open };
  }
  if (input.key === "a") {
    if (flags.appsOpen && !flags.tasksOpen && !flags.cronjobsOpen)
      return "home";
    return {
      tasksOpen: false,
      cronjobsOpen: false,
      appsOpen: true,
      pagerOpen: false,
    };
  }
  // Settings only opens; leaving it must pass its own unsaved-edit guard.
  if (input.key === "s") return { usersOpen: true };
  return null;
}
