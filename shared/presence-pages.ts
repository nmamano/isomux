// The pages whose wall item a member's ghost stands beside while the page is
// open: the Task board's corkboard, the Apps screen, the Inbox tray, the
// Automations clock and the Settings vent.
export const PRESENCE_PAGES = [
  "tasks",
  "apps",
  "inbox",
  "cronjobs",
  "settings",
] as const;
export type PresencePage = (typeof PRESENCE_PAGES)[number];
