// The full pages the office UI has open, as one stack (task 3484f6c9). A door
// opens its page on top of whatever shows, and Close, Escape and Back uncover
// the page it was opened over. Pure and DOM-free, like ui/routes.ts.

import type { Page } from "../shared/office-links.ts";

/** The open pages, bottom first; the last one shows. A page is in it at most
 *  once. */
export type PageStack = readonly Page[];

export type PageStackAction =
  /** To the top; a page already in the stack moves up. */
  | { type: "open"; page: Page }
  /** Close the page when it shows, else open it. */
  | { type: "toggle"; page: Page }
  /** Remove the page wherever it is; a page not in the stack changes nothing. */
  | { type: "close"; page: Page }
  /** The stack is just this page, or empty. */
  | { type: "only"; page: Page | null };

export function pageStackAfter(
  stack: PageStack,
  action: PageStackAction,
): PageStack {
  switch (action.type) {
    case "open":
      return [...stack.filter((p) => p !== action.page), action.page];
    case "toggle":
      return pageStackAfter(stack, {
        type: topPage(stack) === action.page ? "close" : "open",
        page: action.page,
      });
    case "close":
      return stack.includes(action.page)
        ? stack.filter((p) => p !== action.page)
        : stack;
    case "only":
      return action.page === null ? [] : [action.page];
  }
}

/** The page that shows, or null when none is open. */
export function topPage(stack: PageStack): Page | null {
  return stack.at(-1) ?? null;
}

/** The page that shows when the top one closes, or null. */
export function pageUnder(stack: PageStack): Page | null {
  return stack.at(-2) ?? null;
}
