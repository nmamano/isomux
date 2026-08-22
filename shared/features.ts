export type Features = {
  sessions: boolean; // session picker, new conversation, resume
  terminal: boolean; // terminal open/panel
  editor: boolean; // editor side panel + /isomux-edit
  llmConnected: boolean; // false in demo - send_message produces fake response
  liveAppPreviews: boolean; // false when app URLs are synthetic demo addresses
  embed: boolean; // true when embedded in landing page - hides all chrome
};

export const PRODUCTION_FEATURES: Features = {
  sessions: true,
  terminal: true,
  editor: true,
  llmConnected: true,
  liveAppPreviews: true,
  embed: false,
};

export const DEMO_FEATURES: Features = {
  sessions: false,
  terminal: false,
  editor: false,
  llmConnected: false,
  liveAppPreviews: false,
  embed: false,
};
