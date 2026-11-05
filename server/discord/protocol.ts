// The stdio protocol between the server and a Discord gateway child
// (server/discord/gateway.ts): one JSON object per line, commands on the
// child's stdin, events on its stdout. The token travels only in the start
// command, never in argv or the environment.

import {
  isSnowflake,
  snowflakeTime,
  type DiscordChannelSeen,
  type DiscordGuildSeen,
} from "../../shared/discord.ts";

export type GatewayCommand =
  // The first line. url is the gateway WebSocket URL (a fake one in tests).
  { op: "start"; token: string; url: string } | { op: "stop" };

// A message in a channel or thread the bot can see, as the child passes it
// on. mentionsBot: it mentions the bot user or the bot's managed role.
// replyToBot: it replies to one of the bot's messages.
export interface DiscordMessage {
  ev: "message";
  id: string;
  guildId: string;
  channelId: string;
  author: { id: string; name: string; bot: boolean };
  webhook: boolean;
  // Discord's message type: 0 (DEFAULT) and 19 (REPLY) are delivered.
  type: number;
  content: string;
  mentionsBot: boolean;
  replyToBot: boolean;
  attachments: { name: string; url: string }[];
  // The time it was sent (ms).
  ts: number;
}

export type GatewayEvent =
  // A fresh session (IDENTIFY): the server runs the catch-up.
  | { ev: "ready"; user: { id: string; name: string } }
  // A resumed session: Discord replays what was missed, no catch-up.
  | { ev: "resumed" }
  // botRoleIds: the bot's own managed roles there (a mention of one counts
  // as a mention of the bot).
  | { ev: "guild"; guild: DiscordGuildSeen; botRoleIds: string[] }
  | { ev: "guild-gone"; guildId: string }
  | { ev: "channel"; guildId: string; channel: DiscordChannelSeen }
  | { ev: "channel-gone"; guildId: string; channelId: string }
  // A thread or forum post and the channel it belongs to.
  | { ev: "thread"; guildId: string; id: string; parentId: string }
  | { ev: "thread-gone"; guildId: string; id: string }
  // The gateway closed with a code the child does not recover from. The
  // child exits after it.
  | { ev: "closed"; code: number }
  // A status line for the server log, with the token already removed.
  | { ev: "log"; text: string }
  | DiscordMessage;

// The gateway close codes the supervisor acts on: fatal, no restart.
export const GATEWAY_CLOSE = {
  authenticationFailed: 4004,
  disallowedIntents: 4014,
} as const;

export function encodeGatewayCommand(cmd: GatewayCommand): string {
  return JSON.stringify(cmd) + "\n";
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function parseJson(line: string): Obj | null {
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const CHANNEL_KINDS = new Set<DiscordChannelSeen["kind"]>([
  "text",
  "forum",
  "category",
]);

function parseChannel(v: unknown): DiscordChannelSeen | null {
  if (!isObj(v)) return null;
  const { id, name, kind, parentId } = v;
  if (!isStr(id) || !isStr(name)) return null;
  if (!CHANNEL_KINDS.has(kind as DiscordChannelSeen["kind"])) return null;
  if (parentId !== null && !isStr(parentId)) return null;
  return {
    id,
    name,
    kind: kind as DiscordChannelSeen["kind"],
    parentId,
  };
}

function parseGuild(v: unknown): DiscordGuildSeen | null {
  if (!isObj(v)) return null;
  const { id, name, channels } = v;
  if (!isStr(id) || !isStr(name) || !Array.isArray(channels)) return null;
  const parsed: DiscordChannelSeen[] = [];
  for (const c of channels) {
    const channel = parseChannel(c);
    if (!channel) return null;
    parsed.push(channel);
  }
  return { id, name, channels: parsed };
}

function parseMessage(e: Obj): DiscordMessage | null {
  const {
    id,
    guildId,
    channelId,
    author,
    webhook,
    type,
    content,
    mentionsBot,
    replyToBot,
    attachments,
    ts,
  } = e;
  if (
    !isStr(id) ||
    !isStr(guildId) ||
    !isStr(channelId) ||
    !isObj(author) ||
    !isStr(author.id) ||
    !isStr(author.name) ||
    !isBool(author.bot) ||
    !isBool(webhook) ||
    !isNum(type) ||
    !isStr(content) ||
    !isBool(mentionsBot) ||
    !isBool(replyToBot) ||
    !Array.isArray(attachments) ||
    !isNum(ts)
  )
    return null;
  const files: { name: string; url: string }[] = [];
  for (const a of attachments) {
    if (!isObj(a) || !isStr(a.name) || !isStr(a.url)) return null;
    files.push({ name: a.name, url: a.url });
  }
  return {
    ev: "message",
    id,
    guildId,
    channelId,
    author: { id: author.id, name: author.name, bot: author.bot },
    webhook,
    type,
    content,
    mentionsBot,
    replyToBot,
    attachments: files,
    ts,
  };
}

// One stdout line to an event; null for a line that is not a valid event.
export function parseGatewayEvent(line: string): GatewayEvent | null {
  const e = parseJson(line);
  if (!e) return null;
  switch (e.ev) {
    case "ready": {
      const user = e.user;
      return isObj(user) && isStr(user.id) && isStr(user.name)
        ? { ev: "ready", user: { id: user.id, name: user.name } }
        : null;
    }
    case "resumed":
      return { ev: "resumed" };
    case "guild": {
      const guild = parseGuild(e.guild);
      if (!guild || !Array.isArray(e.botRoleIds)) return null;
      if (!e.botRoleIds.every(isStr)) return null;
      return { ev: "guild", guild, botRoleIds: e.botRoleIds };
    }
    case "guild-gone":
      return isStr(e.guildId) ? { ev: "guild-gone", guildId: e.guildId } : null;
    case "channel": {
      const channel = parseChannel(e.channel);
      return channel && isStr(e.guildId)
        ? { ev: "channel", guildId: e.guildId, channel }
        : null;
    }
    case "channel-gone":
      return isStr(e.guildId) && isStr(e.channelId)
        ? { ev: "channel-gone", guildId: e.guildId, channelId: e.channelId }
        : null;
    case "thread":
      return isStr(e.guildId) && isStr(e.id) && isStr(e.parentId)
        ? { ev: "thread", guildId: e.guildId, id: e.id, parentId: e.parentId }
        : null;
    case "thread-gone":
      return isStr(e.guildId) && isStr(e.id)
        ? { ev: "thread-gone", guildId: e.guildId, id: e.id }
        : null;
    case "closed":
      return isNum(e.code) ? { ev: "closed", code: e.code } : null;
    case "log":
      return isStr(e.text) ? { ev: "log", text: e.text } : null;
    case "message":
      return parseMessage(e);
    default:
      return null;
  }
}

// One stdin line to a command; null for a line that is not a valid command.
export function parseGatewayCommand(line: string): GatewayCommand | null {
  const c = parseJson(line);
  if (!c) return null;
  if (c.op === "stop") return { op: "stop" };
  if (c.op === "start" && isStr(c.token) && c.token !== "" && isStr(c.url))
    return { op: "start", token: c.token, url: c.url };
  return null;
}

// A message as Discord's REST API or a MESSAGE_CREATE dispatch gives it, in
// the shape the server reads. Null when a field it needs is missing. guildId
// comes from the caller: REST messages carry none.
export function normaliseApiMessage(
  raw: unknown,
  ctx: { guildId: string; botUserId: string; botRoleIds: readonly string[] },
): DiscordMessage | null {
  if (!isObj(raw)) return null;
  const { id, channel_id, type, content, author, timestamp } = raw;
  if (!isStr(id) || !isStr(channel_id) || !isNum(type) || !isObj(author))
    return null;
  if (!isStr(author.id) || !isStr(author.username)) return null;
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  const roles = Array.isArray(raw.mention_roles) ? raw.mention_roles : [];
  const mentionsBot =
    mentions.some((m) => isObj(m) && m.id === ctx.botUserId) ||
    roles.some((r) => isStr(r) && ctx.botRoleIds.includes(r));
  const ref = raw.referenced_message;
  const replyToBot =
    isObj(ref) && isObj(ref.author) && ref.author.id === ctx.botUserId;
  const attachments: { name: string; url: string }[] = [];
  if (Array.isArray(raw.attachments))
    for (const a of raw.attachments)
      if (isObj(a) && isStr(a.filename) && isStr(a.url))
        attachments.push({ name: a.filename, url: a.url });
  const parsed = isStr(timestamp) ? Date.parse(timestamp) : NaN;
  return {
    ev: "message",
    id,
    guildId: ctx.guildId,
    channelId: channel_id,
    author: { id: author.id, name: author.username, bot: author.bot === true },
    webhook: isStr(raw.webhook_id),
    type,
    content: isStr(content) ? content : "",
    mentionsBot,
    replyToBot,
    attachments,
    ts: Number.isFinite(parsed)
      ? parsed
      : isSnowflake(id)
        ? snowflakeTime(id)
        : 0,
  };
}

// Discord channel types to the kinds the server keeps; null for the others
// (voice, stage, threads, DMs).
export function channelKind(type: unknown): DiscordChannelSeen["kind"] | null {
  if (type === 0 || type === 5) return "text";
  if (type === 15) return "forum";
  if (type === 4) return "category";
  return null;
}
