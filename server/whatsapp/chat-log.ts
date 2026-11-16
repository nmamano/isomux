// The recent messages of each routed WhatsApp chat on disk (task 682fd65a),
// in STATE_ROOT/whatsapp/<userId>/chats/<chat>.json: the last
// WHATSAPP_CHAT_LOG_MAX text messages, the agents' own sends too. A delivery
// (inbound.ts) takes every line not yet delivered, so the lines that did not
// wake the agent survive a restart; messaging_read (replies.ts) reads the
// last lines. Files are 0600 and written atomically; nothing is written when
// the member's directory is gone (an unlink).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { APP_MESSAGE_MAX_CHARS } from "../app-message-limits.ts";
import { cutTo } from "../messaging/block-json.ts";
import { memberDir } from "./store.ts";

export const WHATSAPP_CHAT_LOG_MAX = 100;
const CHATS_DIR = "chats";

// A contact (<digits>@s.whatsapp.net or <digits>@lid) or a group (@g.us).
// Only such an id is a file name.
export const WHATSAPP_CHAT_RE =
  /^(?:[0-9]{5,20}@(?:s\.whatsapp\.net|lid)|[0-9-]{5,40}@g\.us)$/;

export interface ChatLogLine {
  // The WhatsApp message id.
  id: string;
  ts: number;
  // The sender as a delivery names it (inbound.ts senderOf).
  from: string;
  fromMe: boolean;
  // Cut to APP_MESSAGE_MAX_CHARS at append.
  text: string;
  // Went to the agent in a delivery.
  delivered?: true;
  // An agent's own send: never delivered.
  agent?: true;
}

export interface ChatLog {
  // Oldest first.
  lines(): ChatLogLine[];
  // Adds the line and saves the log; the oldest line goes past the cap.
  // False, with no change, when the id is already logged.
  append(line: ChatLogLine): boolean;
  // Sets the flag on each logged line with one of the ids, and saves.
  mark(ids: Iterable<string>, flag: "delivered" | "agent"): void;
}

function isLine(v: unknown): v is ChatLogLine {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.id === "string" &&
    typeof l.ts === "number" &&
    typeof l.from === "string" &&
    typeof l.fromMe === "boolean" &&
    typeof l.text === "string"
  );
}

// Only the flags that are exactly true.
const cleanLine = (l: ChatLogLine): ChatLogLine => ({
  id: l.id,
  ts: l.ts,
  from: l.from,
  fromMe: l.fromMe,
  text: l.text,
  ...(l.delivered === true ? { delivered: true as const } : {}),
  ...(l.agent === true ? { agent: true as const } : {}),
});

function logFile(stateRoot: string, userId: string, chat: string): string {
  return join(memberDir(stateRoot, userId), CHATS_DIR, `${chat}.json`);
}

// Each call reads the file again: the inbound path and the replies hold
// their own handles on the same log.
export function openChatLog(
  stateRoot: string,
  userId: string,
  chat: string,
): ChatLog {
  const valid = WHATSAPP_CHAT_RE.test(chat);
  const file = valid ? logFile(stateRoot, userId, chat) : "";

  function read(): ChatLogLine[] {
    if (!valid) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(raw) ? raw.filter(isLine).map(cleanLine) : [];
    } catch {
      return [];
    }
  }

  // Writes nothing when the member's directory is gone, so a late write
  // never brings back an unlinked session.
  function write(lines: ChatLogLine[]): void {
    const dir = memberDir(stateRoot, userId);
    if (!valid || !existsSync(dir)) return;
    mkdirSync(join(dir, CHATS_DIR), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(lines) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    lines: read,
    append(line) {
      const lines = read();
      if (lines.some((l) => l.id === line.id)) return false;
      const text =
        line.text.length > APP_MESSAGE_MAX_CHARS
          ? cutTo(line.text, APP_MESSAGE_MAX_CHARS)
          : line.text;
      lines.push(cleanLine({ ...line, text }));
      while (lines.length > WHATSAPP_CHAT_LOG_MAX) lines.shift();
      write(lines);
      return true;
    },
    mark(ids, flag) {
      const want = new Set(ids);
      const lines = read();
      let changed = false;
      for (const l of lines)
        if (want.has(l.id) && l[flag] !== true) {
          l[flag] = true;
          changed = true;
        }
      if (changed) write(lines);
    },
  };
}

export function removeChatLog(
  stateRoot: string,
  userId: string,
  chat: string,
): void {
  if (!WHATSAPP_CHAT_RE.test(chat)) return;
  rmSync(logFile(stateRoot, userId, chat), { force: true });
}
