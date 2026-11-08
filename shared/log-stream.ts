// Chats load when they open (task 9ebe887d slice 2). A socket that asks with
// LOGS_ON_OPEN_WS_PARAM gets no transcript replay at connect: the client sends
// open_log for each chat it shows (and for background prefetches), and the
// server replays that agent's log behind live frames, then log_open_done.
// A socket without the flag (a tab from before) keeps the connect replay.
export const LOGS_ON_OPEN_WS_PARAM = "logs";
export const LOGS_ON_OPEN_WS_VALUE = "open";

// The entries a background prefetch loads per chat: the most recent ones.
export const PREFETCH_TAIL = 100;

// The client sends log_ack when it has received this many bytes of replay
// frames since its last ack, and at each log_open_done.
export const LOG_ACK_BYTES = 16 * 1024;

// The longest open_log request id the server accepts. The server echoes the id
// in every replay frame, so it stays short.
export const MAX_LOG_REQUEST_ID_LENGTH = 64;
