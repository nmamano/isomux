// The office pages an ask can link to (task 3ea6fdb3), and the lists they
// come from: the UI's full-page views (ui/routes.ts) and the Integrations
// sidebar tabs (ui/integrations/IntegrationsView.tsx). The server checks a link
// against OFFICE_LINK_PATHS and the UI opens the page officeLinkFor names, so
// a new page or tab is a link target with no second list.
//
// A link is an office page name in path form, an agent's chat as
// /agents/<agentId> (task 9aaec0eb), or one ask as /inbox/asks/<askId>
// (task 84aadfab). The Integrations tab forms
// (/integrations/mcp) are also URL routes that the address bar accepts but
// never shows (ui/routes.ts, task df206fe3). The agent form is accepted the
// same way: it opens that chat and the address bar shows "/" (agentIdForPath,
// task 680747d8).

import type { StepAskRequest } from "./types.ts";

export const OFFICE_PAGES = [
  "tasks",
  "cronjobs",
  "apps",
  "skills",
  "integrations",
  "settings",
  "pager",
  "asks",
] as const;
export type Page = (typeof OFFICE_PAGES)[number];

export const INTEGRATIONS_TABS = [
  "providers",
  "mcp",
  "secrets",
  "variables",
  "voice",
  "browser",
  // Owners only: a room's GitHub issue link (task 7ac5ba2e).
  "github",
  // The viewer's own: where their pages go, and their personal API tokens.
  // They moved here from Settings (task db800fd8).
  "pager",
  "api-tokens",
  // The viewer's own messaging apps: WhatsApp (task d03a61d8).
  "messaging",
] as const;
export type IntegrationsTab = (typeof INTEGRATIONS_TABS)[number];

/** The canonical path for a page, or "/" for the office. */
export function pathForPage(page: Page | null): string {
  if (page === null) return "/";
  if (page === "cronjobs") return "/automations";
  if (page === "pager") return "/inbox/pages";
  if (page === "asks") return "/inbox/asks";
  return `/${page}`;
}

export interface PageLink {
  page: Page;
  tab?: IntegrationsTab;
  // The ask an /inbox/asks/<askId> link opens in the Asks tab (task 84aadfab).
  askId?: string;
  // A step ask's step, which the Integrations tab marks (task c71cb60f).
  focus?: StepAskRequest;
  // The agent the Asks tab filters to (the chat's ask stack, task 586ebfe1).
  // The UI sets it; no ask link does.
  onlyAgent?: string;
}

export interface AgentLink {
  agentId: string;
}

export type OfficeLink = PageLink | AgentLink;

const LINKS: ReadonlyArray<{ path: string; link: PageLink }> = [
  ...OFFICE_PAGES.map((page) => ({ path: pathForPage(page), link: { page } })),
  ...INTEGRATIONS_TABS.map((tab) => ({
    path: `${pathForPage("integrations")}/${tab}`,
    link: { page: "integrations" as const, tab },
  })),
];

/** Every office page path an ask's `link` accepts. */
export const OFFICE_LINK_PATHS: readonly string[] = LINKS.map((l) => l.path);

/** The page a link names, or null. Exact match only: no aliases, no trailing
 *  slash, no query. */
export function officeLinkFor(path: unknown): PageLink | null {
  const found = LINKS.find((l) => l.path === path);
  return found ? { ...found.link } : null;
}

/** The agent-chat form of an ask's link: `/agents/<agentId>`. */
export const AGENT_LINK_PREFIX = "/agents/";

/** The one-ask form of an ask's link and of the address: `/inbox/asks/<askId>`. */
export const ASK_LINK_PREFIX = "/inbox/asks/";

/** The ask id a path segment holds: lowercase hex, 8 to 64 characters, or
 *  null. The one check of the address (ui/routes.ts askIdForPath) and of an
 *  ask's link. */
export function askIdForSegment(segment: string): string | null {
  return /^[0-9a-f]{8,64}$/.test(segment) ? segment : null;
}

/** The page or agent an ask's link names, or null. The agent form takes one
 *  non-empty segment; whether the agent exists is the caller's check. */
export function askLinkFor(path: unknown): OfficeLink | null {
  if (typeof path === "string" && path.startsWith(AGENT_LINK_PREFIX)) {
    const agentId = path.slice(AGENT_LINK_PREFIX.length);
    return agentId && !agentId.includes("/") ? { agentId } : null;
  }
  if (typeof path === "string" && path.startsWith(ASK_LINK_PREFIX)) {
    const askId = askIdForSegment(path.slice(ASK_LINK_PREFIX.length));
    return askId ? { page: "asks", askId } : null;
  }
  return officeLinkFor(path);
}
