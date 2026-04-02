export type Features = {
  sessions: boolean;     // session picker, new conversation, resume
  terminal: boolean;     // terminal open/panel
  llmConnected: boolean; // false in demo — send_message produces fake response
};

export const PRODUCTION_FEATURES: Features = {
  sessions: true,
  terminal: true,
  llmConnected: true,
};

export const DEMO_FEATURES: Features = {
  sessions: false,
  terminal: false,
  llmConnected: false,
};
