// A member's Discord files (task 7fd44c30), in STATE_ROOT/discord/<userId>/:
//   bots.json    - the connected bots with their tokens (a credential store:
//                  server/credential-store-paths.ts, excluded from backups)
//   routes.json  - the routes
//   cursors.json - per bot, then per channel or thread id, the highest
//                  message id delivered, so a catch-up starts after it
// Files are 0600 and written atomically. A file that does not parse reads as
// empty.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  isSnowflake,
  normaliseDiscordPrefix,
  type DiscordRoute,
} from "../../shared/discord.ts";

export interface StoredBot {
  id: string;
  name: string;
  token: string;
  addedAt: number;
}

const BOTS_FILE = "bots.json";
const ROUTES_FILE = "routes.json";
const CURSORS_FILE = "cursors.json";

export function discordRoot(stateRoot: string): string {
  return join(stateRoot, "discord");
}

// A user id names a directory: refuse anything that could leave the root.
export function discordMemberDir(stateRoot: string, userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId))
    throw new Error("invalid user id for a Discord directory");
  return join(discordRoot(stateRoot), userId);
}

function readJson(stateRoot: string, userId: string, name: string): unknown {
  try {
    return JSON.parse(
      readFileSync(join(discordMemberDir(stateRoot, userId), name), "utf8"),
    );
  } catch {
    return null;
  }
}

function writeJson(
  stateRoot: string,
  userId: string,
  name: string,
  value: unknown,
): void {
  const dir = discordMemberDir(stateRoot, userId);
  mkdirSync(discordRoot(stateRoot), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isBot(v: unknown): v is StoredBot {
  return (
    isObj(v) &&
    isSnowflake(v.id) &&
    typeof v.name === "string" &&
    typeof v.token === "string" &&
    v.token !== "" &&
    typeof v.addedAt === "number"
  );
}

const SCOPES = new Set(["channel", "category", "server"]);
const TRIGGERS = new Set(["all", "mention"]);
const REPLY_MODES = new Set(["bot", "read", "ask"]);
const DEAD = new Set(["agent_gone", "agent_not_yours", "agent_chat_only"]);

function isRoute(v: unknown): v is DiscordRoute {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    isSnowflake(v.botId) &&
    isSnowflake(v.guildId) &&
    SCOPES.has(v.scope as string) &&
    isSnowflake(v.targetId) &&
    typeof v.name === "string" &&
    typeof v.agentId === "string" &&
    TRIGGERS.has(v.trigger as string) &&
    REPLY_MODES.has(v.replyMode as string) &&
    typeof v.createdAt === "number" &&
    (v.dead === undefined || DEAD.has(v.dead as string))
  );
}

// The optional fields as they are valid: includeBots and react only when
// exactly true, a prefix only when it passes normaliseDiscordPrefix and is not
// blank (kept as written: the routes store it trimmed).
function cleanRoute(route: DiscordRoute): DiscordRoute {
  const { prefix, includeBots, react, ...rest } = route as DiscordRoute &
    Record<"prefix" | "includeBots" | "react", unknown>;
  return {
    ...rest,
    ...(typeof prefix === "string" && normaliseDiscordPrefix(prefix)
      ? { prefix }
      : {}),
    ...(includeBots === true ? { includeBots } : {}),
    ...(react === true ? { react } : {}),
  };
}

export function readBots(stateRoot: string, userId: string): StoredBot[] {
  const raw = readJson(stateRoot, userId, BOTS_FILE);
  return Array.isArray(raw) ? raw.filter(isBot) : [];
}

export function writeBots(
  stateRoot: string,
  userId: string,
  bots: StoredBot[],
): void {
  writeJson(stateRoot, userId, BOTS_FILE, bots);
}

export function readDiscordRoutes(
  stateRoot: string,
  userId: string,
): DiscordRoute[] {
  const raw = readJson(stateRoot, userId, ROUTES_FILE);
  return Array.isArray(raw) ? raw.filter(isRoute).map(cleanRoute) : [];
}

export function writeDiscordRoutes(
  stateRoot: string,
  userId: string,
  routes: DiscordRoute[],
): void {
  writeJson(stateRoot, userId, ROUTES_FILE, routes);
}

function readAllCursors(
  stateRoot: string,
  userId: string,
): Record<string, unknown> {
  const raw = readJson(stateRoot, userId, CURSORS_FILE);
  return isObj(raw) ? raw : {};
}

// One bot's cursors: channel or thread id -> message id. Entries that are not
// snowflakes are dropped.
export function readCursors(
  stateRoot: string,
  userId: string,
  botId: string,
): Record<string, string> {
  const raw = readAllCursors(stateRoot, userId)[botId];
  const cursors: Record<string, string> = {};
  if (!isObj(raw)) return cursors;
  for (const [channel, id] of Object.entries(raw))
    if (isSnowflake(channel) && isSnowflake(id)) cursors[channel] = id;
  return cursors;
}

// Replaces one bot's cursors and keeps the other bots'.
export function writeCursors(
  stateRoot: string,
  userId: string,
  botId: string,
  cursors: Record<string, string>,
): void {
  const all = readAllCursors(stateRoot, userId);
  writeJson(stateRoot, userId, CURSORS_FILE, { ...all, [botId]: cursors });
}

export function removeCursors(
  stateRoot: string,
  userId: string,
  botId: string,
): void {
  const all = readAllCursors(stateRoot, userId);
  if (!(botId in all)) return;
  delete all[botId];
  writeJson(stateRoot, userId, CURSORS_FILE, all);
}

// The members with a Discord directory.
export function listDiscordMembers(stateRoot: string): string[] {
  const root = discordRoot(stateRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name))
    .map((e) => e.name);
}

export function removeDiscordMember(stateRoot: string, userId: string): void {
  rmSync(discordMemberDir(stateRoot, userId), { recursive: true, force: true });
}
