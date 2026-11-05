// Discord channel (task 7fd44c30): a member connects a Discord bot, and the
// server runs one gateway child per connected bot (server/discord/). Routes
// send a channel, a category or a whole server to an agent. These are the
// wire shapes the Integrations card reads.

import {
  normaliseWhatsAppPrefix,
  normaliseWhatsAppRouteName,
} from "./whatsapp.ts";

// Discord's id among the messaging apps (shared/messaging.ts).
export const DISCORD_APP = "discord";

// Why a bot is not connected. A code, never copy: the UI words it.
//   token_invalid - Discord refused the token (gateway close 4004)
//   intent_off    - the Message Content intent is off (gateway close 4014)
//   crash_loop    - the gateway kept failing and the server gave up paging
export type DiscordBotReason = "token_invalid" | "intent_off" | "crash_loop";

export type DiscordBotStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "dead"; reason: DiscordBotReason };

// A connected bot as the member sees it. The token never leaves the server.
export interface DiscordBot {
  // The bot's Discord user id.
  id: string;
  name: string;
  addedAt: number;
  status: DiscordBotStatus;
}

export interface DiscordConnectReq {
  token: string;
}

// Why a connect failed, as the error code of POST /api/discord/bots. A
// code, never copy: the card words it.
//   token_refused - Discord refused the token (400)
//   not_a_bot     - the token is a user's, not a bot's (400)
//   check_failed  - Discord did not answer the check (400)
//   bot_taken     - another member connected this bot (409)
//   bots_max      - the member has DISCORD_BOTS_MAX bots (409)
//   disconnected  - the bot was disconnected while it connected again (409)
export type DiscordConnectCode =
  | "token_refused"
  | "not_a_bot"
  | "check_failed"
  | "bot_taken"
  | "bots_max"
  | "disconnected";

// The permissions the invite link asks for: View Channels, Send Messages,
// Send Messages in Threads, Read Message History and Add Reactions. The
// gateway intents are in server/discord/gateway.ts (DISCORD_INTENTS).
export const DISCORD_INVITE_PERMISSIONS =
  (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 16n) | (1n << 6n);

// The link that adds a bot to a server: a bot's application id is its user
// id.
export function discordInviteUrl(botId: string): string {
  const query = new URLSearchParams({
    client_id: botId,
    scope: "bot",
    permissions: String(DISCORD_INVITE_PERMISSIONS),
  });
  return `https://discord.com/oauth2/authorize?${query}`;
}

export type DiscordChannelKind = "text" | "forum" | "category";

// A channel the bot can see, for the Add form. Kept in memory only.
export interface DiscordChannelSeen {
  id: string;
  name: string;
  kind: DiscordChannelKind;
  // The category of a text or forum channel; null for a category or a
  // channel outside one.
  parentId: string | null;
}

// A server the bot is in, for the Add form. Kept in memory only.
export interface DiscordGuildSeen {
  id: string;
  name: string;
  channels: DiscordChannelSeen[];
}

export type DiscordRouteScope = "channel" | "category" | "server";
export type DiscordRouteTrigger = "all" | "mention";
// How the agent answers on a route (task 7fd44c30 design note):
//   bot  - "Read and reply as the bot": posts at once as the bot
//   read - "Read only": no reply path
//   ask  - "Replies wait for my Send": an Inbox ask, as on WhatsApp
export type DiscordReplyMode = "bot" | "read" | "ask";

// Why a route no longer delivers. The same codes as a WhatsApp row.
export type DiscordRouteDead =
  | "agent_gone"
  | "agent_not_yours"
  | "agent_chat_only";

export interface DiscordRoute {
  id: string;
  botId: string;
  guildId: string;
  scope: DiscordRouteScope;
  // The channel id, the category id, or the guild id for a server route.
  targetId: string;
  name: string;
  agentId: string;
  trigger: DiscordRouteTrigger;
  replyMode: DiscordReplyMode;
  // Text put before each message the agent sends. Absent means none.
  prefix?: string;
  // Posts by bots and webhooks reach the agent. Absent means they are
  // dropped.
  includeBots?: true;
  // The bot reacts with 👀 when a message is delivered.
  react?: true;
  createdAt: number;
  dead?: DiscordRouteDead;
}

export interface DiscordRouteCreateReq {
  botId: string;
  guildId: string;
  scope: DiscordRouteScope;
  targetId: string;
  name: string;
  agentId: string;
  trigger?: DiscordRouteTrigger;
  replyMode?: DiscordReplyMode;
  prefix?: string;
  includeBots?: boolean;
  react?: boolean;
}

// The bot, guild, scope and target cannot change: delete the route and add
// another. includeBots false, react false and prefix "" clear the field.
export interface DiscordRouteUpdateReq {
  name?: string;
  agentId?: string;
  trigger?: DiscordRouteTrigger;
  replyMode?: DiscordReplyMode;
  prefix?: string;
  includeBots?: boolean;
  react?: boolean;
}

export const DISCORD_ROUTES_MAX = 50;
export const DISCORD_BOTS_MAX = 5;

// A route name and a prefix follow the WhatsApp rules, so the two forms
// accept the same text.
export const normaliseDiscordRouteName = normaliseWhatsAppRouteName;
export const normaliseDiscordPrefix = normaliseWhatsAppPrefix;

// Discord's epoch (2015-01-01T00:00:00Z) in Unix ms.
export const DISCORD_EPOCH_MS = 1_420_070_400_000;

const SNOWFLAKE_RE = /^[0-9]{1,20}$/;

export function isSnowflake(v: unknown): v is string {
  return typeof v === "string" && SNOWFLAKE_RE.test(v);
}

function snowflake(id: string): bigint {
  if (!SNOWFLAKE_RE.test(id)) throw new Error("not a snowflake");
  return BigInt(id);
}

// Snowflakes are compared as BigInt: their lengths differ, and they pass
// 2^53. The smallest snowflake of a time (ms).
export function snowflakeFromTime(ms: number): bigint {
  const since = BigInt(Math.max(0, Math.floor(ms - DISCORD_EPOCH_MS)));
  return since << 22n;
}

// The time (ms) a snowflake was made.
export function snowflakeTime(id: string): number {
  return Number(snowflake(id) >> 22n) + DISCORD_EPOCH_MS;
}

// -1, 0 or 1, by numeric value. A string that is not a snowflake throws.
export function compareSnowflakes(a: string, b: string): number {
  const x = snowflake(a);
  const y = snowflake(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// The larger of two snowflakes.
export function maxSnowflake(a: string, b: string): string {
  return compareSnowflakes(a, b) >= 0 ? a : b;
}
