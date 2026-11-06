// The office UI's full-page views are real URLs, and this module is the
// whole mapping between a path and a page. It is pure and DOM-free on purpose
// (ruling 6 of internal-docs/url-routing-loop.md): the table is unit-tested
// here, and App's wiring is covered by the render tests instead.
//
// Agent chats and settings sections are deliberately NOT routes (ruling 3), so
// a chat, a settings section and the office all share one path, "/". An
// Integrations tab path (/integrations/mcp) opens its tab but is never
// written: the address bar shows /integrations (task df206fe3). An agent's
// address (/agents/<agentId>) opens that chat the same way, and the address
// bar shows "/" (task 680747d8).

import {
  ASK_LINK_PREFIX,
  askIdForSegment,
  askLinkFor,
  officeLinkFor,
  pathForPage,
  type IntegrationsTab,
  type Page,
} from "../shared/office-links.ts";

import { topPage, type PageStack, type PageStackAction } from "./page-stack.ts";
import type { PresencePage } from "../shared/presence-pages.ts";

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
    // The Inbox (task c952e551).
    case "/inbox/asks":
      return "asks";
    // A typed /inbox. Accepted, never produced.
    case "/inbox":
      return "asks";
    // The Inbox's Pages tab until pages became asks (task 74e8fc07), and the
    // Inbox tabs as their own pages until 2026-10-18. Accepted so an old link
    // or bookmark keeps working, never produced.
    case "/inbox/pages":
    case "/pager":
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
    // One ask (/inbox/asks/<askId>, task 84aadfab) and the Integrations tab
    // paths (/integrations/mcp), from the one tab list.
    default:
      if (askIdForPath(pathname) !== null) return "asks";
      if (pathname.startsWith("/inbox/pages/")) return "asks";
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
 * The page id in a Discord or push link from before pages were asks,
 * `<origin>/?pager=<id>`, or null. The parameter opens the Inbox on the page's
 * ask (askIdForPage in ui/inbox.ts) on any path.
 */
export function pagerIdForSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("pager")?.trim() ?? "";
  return id.length > 0 && id.length <= PAGER_LINK_ID_MAX ? id : null;
}

/**
 * The agent an address names, `/agents/<agentId>` (the ask link form,
 * shared/office-links.ts), or null. The app widget links an agent's name
 * here (task 680747d8). Accepted, never produced: the office opens the chat
 * and the address bar shows "/". A trailing slash is forgiven.
 */
export function agentIdForPath(pathname: string): string | null {
  const link = askLinkFor(pathname.replace(/\/+$/, ""));
  return link && "agentId" in link ? link.agentId : null;
}

/**
 * The ask an address names, `/inbox/asks/<askId>` (task 84aadfab), or null.
 * Accepted, never produced: the Asks tab pins the ask and the address bar
 * shows /inbox/asks. A trailing slash is forgiven.
 */
export function askIdForPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "");
  return path.startsWith(ASK_LINK_PREFIX)
    ? askIdForSegment(path.slice(ASK_LINK_PREFIX.length))
    : null;
}

/** The page the URL opens at boot: the pager link first, then the path. */
export function pageForLocation(pathname: string, search: string): Page | null {
  if (pagerIdForSearch(search) !== null) return "asks";
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

/** What a page key does to the page stack, "home" when it closes the page
 *  that shows, or null when the key does nothing. */
export function pageShortcut(
  input: PageShortcutInput,
  stack: PageStack,
): PageStackAction | "home" | null {
  // Settings only opens; leaving it must pass its own unsaved-edit guard,
  // which lives in the mounted page.
  if (
    input.isInput ||
    topPage(stack) === "settings" ||
    input.metaKey ||
    input.ctrlKey ||
    input.altKey
  )
    return null;
  // Decided by the action, not by this stack: two keydowns can come before
  // React renders, and the second must read the first one's result.
  if (input.key === "t") return { type: "toggle", page: "tasks" };
  // Apps and the Inbox (task f55581c3) replace every page, and close only
  // when they show: under Tasks they come to the front.
  if (input.key === "a" || input.key === "i") {
    const page = input.key === "a" ? "apps" : "asks";
    return topPage(stack) === page ? "home" : { type: "only", page };
  }
  if (input.key === "s") return { type: "open", page: "settings" };
  return null;
}

export interface BackRoomShortcutState {
  /** The current room has a back room: it is not the lobby. */
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

/**
 * The wall item a member's ghost stands beside while this page is open, or
 * null when the page has none.
 */
export function presencePageFor(page: Page | null): PresencePage | null {
  switch (page) {
    case "tasks":
    case "apps":
    case "cronjobs":
    case "settings":
      return page;
    case "asks":
      return "inbox";
    case "skills":
    case "integrations":
    case null:
      return null;
  }
}
