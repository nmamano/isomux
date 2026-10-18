// An ask's link to an office page (shared/office-links.ts). App provides the
// opener, which goes through the same doors as the rest of the office, so
// history and the page stack behave the same. With no opener the card draws
// no link.

import { createContext } from "react";
import type { PlainMessageKey } from "../shared/i18n/translate.ts";
import type {
  IntegrationsTab,
  OfficeLink,
  Page,
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

const TAB_LABEL: Record<IntegrationsTab, PlainMessageKey> = {
  providers: "integrations.tabs.providers",
  mcp: "integrations.tabs.mcp",
  secrets: "integrations.tabs.secrets",
  variables: "integrations.tabs.variables",
  browser: "integrations.tabs.browser",
};

/** The catalog key of the page or tab a link opens. */
export function officeLinkLabel(link: OfficeLink): PlainMessageKey {
  return link.tab ? TAB_LABEL[link.tab] : PAGE_LABEL[link.page];
}
