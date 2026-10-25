// An ask's link to an office page or an agent's chat (shared/office-links.ts).
// App provides the opener, which goes through the same doors as the rest of
// the office, so history and the page stack behave the same. With no opener
// the card draws no link.

import { createContext } from "react";
import type { PlainMessageKey } from "../shared/i18n/translate.ts";
import type {
  IntegrationsTab,
  OfficeLink,
  Page,
  PageLink,
} from "../shared/office-links.ts";

export const OfficeLinkOpener = createContext<
  ((link: OfficeLink) => void) | null
>(null);

const PAGE_LABEL: Record<Page, PlainMessageKey> = {
  tasks: "common.tasks",
  cronjobs: "common.automations",
  apps: "common.apps",
  skills: "common.skills",
  integrations: "common.integrations",
  settings: "common.settings",
  pager: "inbox.tab.pages",
  asks: "asks.title",
};

// Also the Integrations page's sidebar rows.
export const TAB_LABEL: Record<IntegrationsTab, PlainMessageKey> = {
  providers: "integrations.tabs.providers",
  mcp: "integrations.tabs.mcp",
  secrets: "integrations.tabs.secrets",
  variables: "integrations.tabs.variables",
  voice: "integrations.tabs.voice",
  browser: "integrations.tabs.browser",
  github: "integrations.tabs.github",
  pager: "settings.sidebar.pager",
  "api-tokens": "settings.sidebar.apiTokens",
};

/** The catalog key of the page or tab a link opens. */
export function officeLinkLabel(link: PageLink): PlainMessageKey {
  return link.tab ? TAB_LABEL[link.tab] : PAGE_LABEL[link.page];
}
