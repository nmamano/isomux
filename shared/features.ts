export type Features = {
  sessions: boolean; // session picker, new conversation, resume
  terminal: boolean; // terminal open/panel
  editor: boolean; // editor side panel + /isomux-edit
  llmConnected: boolean; // false in demo - send_message produces fake response
  embed: boolean; // true when embedded in landing page - hides all chrome
};

export const PRODUCTION_FEATURES: Features = {
  sessions: true,
  terminal: true,
  editor: true,
  llmConnected: true,
  embed: false,
};

export const DEMO_FEATURES: Features = {
  sessions: false,
  terminal: false,
  editor: false,
  llmConnected: false,
  embed: false,
};
