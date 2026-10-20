// The office UI's full-page views are real URLs, and this module is the
// whole mapping between a path and a page. It is pure and DOM-free on purpose
// (ruling 6 of internal-docs/url-routing-loop.md): the table is unit-tested
// here, and App's wiring is covered by the render tests instead.
//
// Agent chats and settings sections are deliberately NOT routes (ruling 3), so
// a chat, a settings section and the office all share one path, "/". An
// Integrations tab path (/integrations/mcp) opens its tab but is never
// written: the address bar shows /integrations (task df206fe3).

import {
  officeLinkFor,
  pathForPage,
  type IntegrationsTab,
  type Page,
} from "../shared/office-links.ts";

// The page list lives in shared/office-links.ts, where the server reads it
// to check an ask's link.
export { pathForPage, type Page };

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
    case "/automations":
      return "cronjobs";
    case "/apps":
      return "apps";
    case "/skills":
      return "skills";
    case "/integrations":
      return "integrations";
    case "/settings":
      return "settings";
    // The Inbox (task c952e551): its two tabs are the pager and the asks.
    case "/inbox/pages":
      return "pager";
    case "/inbox/asks":
      return "asks";
    // A typed /inbox opens Pages: the boot cannot know yet whether a page is
    // open. Accepted, never produced.
    case "/inbox":
      return "pager";
    // The Inbox tabs were their own pages until 2026-10-18. Accepted so an
    // old link keeps working, never produced.
    case "/pager":
      return "pager";
    case "/asks":
      return "asks";
    // "users" is what the settings page was called before it was renamed, and
    // the saved-spot parser still reads that name (ui/view-persistence.ts).
    // Accepted so an old link keeps working, never produced.
    case "/users":
      return "settings";
    // The automations page lived at /cronjobs until 2026-10-16. Accepted so
    // an old link keeps working, never produced.
    case "/cronjobs":
      return "cronjobs";
    // The Integrations tab paths (/integrations/mcp), from the one tab list.
    default:
      return integrationsTabForPath(pathname) === null ? null : "integrations";
  }
}

/** The Integrations tab a pathname names (`/integrations/<tab>`), or null.
 *  Accepted, never produced: the page writes /integrations. */
export function integrationsTabForPath(
  pathname: string,
): IntegrationsTab | null {
  return officeLinkFor(pathname.replace(/\/+$/, ""))?.tab ?? null;
}

// The longest id the deep link accepts. Ids are 16 hex characters (8 on older
// pages); the bound only keeps a pasted URL from carrying junk into the view.
const PAGER_LINK_ID_MAX = 64;

/**
 * The page id in a Discord link, `<origin>/?pager=<id>` (server/pager-delivery.ts),
 * or null. The parameter opens the Inbox's Pages tab on any path, so the link
 * keeps working if the office ever moves its root.
 */
export function pagerIdForSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("pager")?.trim() ?? "";
  return id.length > 0 && id.length <= PAGER_LINK_ID_MAX ? id : null;
}

/** The page the URL opens at boot: the pager link first, then the path. */
export function pageForLocation(pathname: string, search: string): Page | null {
  if (pagerIdForSearch(search) !== null) return "pager";
  const page = pageForPath(pathname);
  // An MCP sign-in started before the Integrations page came back to
  // /settings; its result belongs on the Integrations page.
  if (page === "settings" && mcpSignInForSearch(search) !== null)
    return "integrations";
  return page;
}

/**
 * The result code of an MCP server sign-in that came back to the office
 * (`?mcpSignIn=<code>`, from server/routes/handlers/mcp-servers.ts), or null.
 */
export function mcpSignInForSearch(search: string): string | null {
  const code = new URLSearchParams(search).get("mcpSignIn")?.trim() ?? "";
  return code.length > 0 && code.length <= 64 ? code : null;
}

export interface PageFlags {
  usersOpen: boolean;
  tasksOpen: boolean;
  cronjobsOpen: boolean;
  appsOpen: boolean;
  skillsOpen: boolean;
  integrationsOpen: boolean;
  pagerOpen: boolean;
  asksOpen: boolean;
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
          : flags.skillsOpen
            ? "skills"
            : flags.integrationsOpen
              ? "integrations"
              : flags.pagerOpen
                ? "pager"
                : flags.asksOpen
                  ? "asks"
                  : null;
}

/** The flag that holds a page open. */
export function flagForPage(page: Page): keyof PageFlags {
  switch (page) {
    case "settings":
      return "usersOpen";
    case "tasks":
      return "tasksOpen";
    case "cronjobs":
      return "cronjobsOpen";
    case "apps":
      return "appsOpen";
    case "skills":
      return "skillsOpen";
    case "integrations":
      return "integrationsOpen";
    case "pager":
      return "pagerOpen";
    case "asks":
      return "asksOpen";
  }
}

/** The page that shows when the page on top closes, or null when none is
 *  open under it (task d6c09d1c: layers close top first).
 *
 *  It reads open order from pageForFlags' precedence, which holds because
 *  every door opens its page on top: "s" sets only Settings, "t" is the only
 *  key that leaves lower flags set, and "a" and "i" clear every flag under
 *  Settings. So a stack is at most Settings over Tasks over one other page.
 *  A door that opened a page UNDER the one shown would break this; the
 *  pageShortcut test in routes.test.ts goes red on such a key. */
export function pageUnder(flags: PageFlags): Page | null {
  const top = pageForFlags(flags);
  if (top === null) return null;
  return pageForFlags({ ...flags, [flagForPage(top)]: false });
}

export interface PageShortcutInput {
  key: string;
  isInput?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Set only by the keyup path, when createLoneShiftTracker saw Shift
   *  pressed and released with no other key in between. */
  loneShift?: boolean;
}

export interface PageShortcutUpdate {
  tasksOpen?: boolean | ((open: boolean) => boolean);
  cronjobsOpen?: boolean;
  appsOpen?: boolean;
  skillsOpen?: boolean;
  integrationsOpen?: boolean;
  pagerOpen?: boolean;
  asksOpen?: boolean;
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
      skillsOpen: false,
      integrationsOpen: false,
      pagerOpen: false,
      asksOpen: false,
    };
  }
  // Integrations sets every page flag in one update, unlike "t" (task
  // f55581c3), and closes only when it is the page shown: over Tasks it
  // comes to the front.
  if (input.key === "i") {
    if (pageForFlags(flags) === "integrations") return "home";
    return {
      tasksOpen: false,
      cronjobsOpen: false,
      appsOpen: false,
      skillsOpen: false,
      integrationsOpen: true,
      pagerOpen: false,
      asksOpen: false,
    };
  }
  // Settings only opens; leaving it must pass its own unsaved-edit guard.
  if (input.key === "s") return { usersOpen: true };
  return null;
}

export interface BackRoomShortcutState {
  /** The current room has its back room setting on, and is not the lobby. */
  hasBackRoom: boolean;
  backRoomOpen: boolean;
  /** An agent's log or a page shows over the office. */
  covered: boolean;
}

/** "b" goes between a room's front and its back room (Nil, 2026-10-15),
 *  and a lone Shift or Shift+Tab goes from the back room to the front
 *  (Nil, 2026-10-20): "open" or "close" the back room, or null when the key
 *  does nothing. */
export function backRoomShortcut(
  input: PageShortcutInput,
  state: BackRoomShortcutState,
): "open" | "close" | null {
  if (
    input.isInput ||
    input.metaKey ||
    input.ctrlKey ||
    input.altKey ||
    state.covered ||
    !state.hasBackRoom
  )
    return null;
  if (input.key === "b") return state.backRoomOpen ? "close" : "open";
  const toFront =
    (input.key === "Shift" && input.loneShift === true) ||
    (input.key === "Tab" && input.shiftKey === true);
  return toFront && state.backRoomOpen ? "close" : null;
}

export interface LoneShiftTracker {
  /** repeat is KeyboardEvent.repeat: a held key's auto-repeat. */
  keydown(key: string, repeat?: boolean): void;
  /** True when this keyup ends a Shift press with no other key in it. */
  keyup(key: string): boolean;
  /** Forget a pending Shift press (a click or a window blur). */
  reset(): void;
}

export function createLoneShiftTracker(): LoneShiftTracker {
  // True from a Shift keydown until another key, a reset or Shift's keyup.
  let armed = false;
  return {
    keydown(key, repeat = false) {
      // A held key's auto-repeat changes nothing: a Shift held through a
      // click stays spoiled.
      if (!repeat) armed = key === "Shift";
    },
    keyup(key) {
      if (key !== "Shift") return false;
      const lone = armed;
      armed = false;
      return lone;
    },
    reset() {
      armed = false;
    },
  };
}
