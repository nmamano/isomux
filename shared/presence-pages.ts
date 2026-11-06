// The pages whose wall item a member's ghost stands beside while the page is
// open: the Task board's corkboard, the Apps screen and the Inbox tray.
export const PRESENCE_PAGES = ["tasks", "apps", "inbox"] as const;
export type PresencePage = (typeof PRESENCE_PAGES)[number];
