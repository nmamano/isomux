// The office pages an ask can link to (task 3ea6fdb3), and the lists they
// come from: the UI's full-page views (ui/routes.ts) and the Integrations
// tabs (ui/integrations/IntegrationsView.tsx). The server checks a link
// against OFFICE_LINK_PATHS and the UI opens the page officeLinkFor names, so
// a new page or tab is a link target with no second list.
//
// A link is an office page name in path form. The Integrations tab forms
// (/integrations/mcp) are link targets only, not URL routes: the address bar
// resolves them as the office (pageForPath).

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
  "browser",
] as const;
export type IntegrationsTab = (typeof INTEGRATIONS_TABS)[number];

/** The canonical path for a page, or "/" for the office. */
export function pathForPage(page: Page | null): string {
  if (page === null) return "/";
  return page === "cronjobs" ? "/automations" : `/${page}`;
}

export interface OfficeLink {
  page: Page;
  tab?: IntegrationsTab;
}

const LINKS: ReadonlyArray<{ path: string; link: OfficeLink }> = [
  ...OFFICE_PAGES.map((page) => ({ path: pathForPage(page), link: { page } })),
  ...INTEGRATIONS_TABS.map((tab) => ({
    path: `${pathForPage("integrations")}/${tab}`,
    link: { page: "integrations" as const, tab },
  })),
];

/** Every value an ask's `link` accepts. */
export const OFFICE_LINK_PATHS: readonly string[] = LINKS.map((l) => l.path);

/** The page a link names, or null. Exact match only: no aliases, no trailing
 *  slash, no query. */
export function officeLinkFor(path: unknown): OfficeLink | null {
  const found = LINKS.find((l) => l.path === path);
  return found ? { ...found.link } : null;
}
