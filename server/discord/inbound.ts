// Discord messages from routed channels to agents (task 7fd44c30).
//
// A message goes to the most specific live route of the bot that saw it
// (routes.ts forPlace; a thread counts as its parent channel). It is dropped
// when it is the bot's own, when its type is not DEFAULT (0) or REPLY (19),
// when a bot or a webhook wrote it and the route has no includeBots, or when
// its id is not above the channel's cursor: the larger of the stored cursor,
// the route's creation time and DISCORD_MAX_AGE_MS ago (snowflakes compared
// as BigInt). On a route with trigger "mention", a message that neither
// mentions the bot (user or managed role) nor replies to it is context: it
// goes with the next delivery, never alone, at most DISCORD_CONTEXT_MAX.
//
// Messages that count, in one channel or thread, make one delivery
// DISCORD_BURST_QUIET_MS after the last, or DISCORD_BURST_MAX_MS after the
// first, sorted by id. A message already waiting is not added twice. At the
// delivery the cursor moves to the highest delivered id.
//
// Catch-up (onReady, a fresh gateway session): for each live route of the
// bot, each covered text channel and each active thread a live route covers is read
// over REST, newest first, at most DISCORD_CATCHUP_PAGES pages, back to the
// cursor, and fed through the same path oldest first. While a channel's own
// catch-up runs its burst does not flush, so a live message cannot move the
// cursor past a message read late. A 429 waits and tries again (rest.ts). When
// the page cap or the age limit left messages unread, the delivery says so.
//
// Slice 2: each line carries the channel or thread it was posted in and its
// id, which a reply names (channelId, replyTo). A route that is not a channel
// route on a text channel needs that channelId, and its head says so. On a
// route with react, after a delivery the agent took, the bot reacts 👀 to
// the newest DISCORD_REACTIONS_MAX lines that counted, one at a time; a
// failure stops them with one log line and never touches the delivery.

import { formatMessagingSenderPrefix } from "../../shared/identity.ts";
import {
  DISCORD_APP,
  compareSnowflakes,
  isSnowflake,
  maxSnowflake,
  snowflakeFromTime,
  type DiscordChannelKind,
  type DiscordRoute,
  type DiscordRouteDead,
} from "../../shared/discord.ts";
import { buildDiscordBlock, type DiscordBlockLine } from "./block.ts";
import type { DiscordMessage } from "./protocol.ts";
import type { DiscordRest } from "./rest.ts";
import type { DiscordMessagePlace } from "./routes.ts";
import type { DiscordClock } from "./supervisor.ts";

export const DISCORD_BURST_QUIET_MS = 5_000;
export const DISCORD_BURST_MAX_MS = 30_000;
export const DISCORD_CONTEXT_MAX = 10;
export const DISCORD_MAX_AGE_MS = 24 * 60 * 60_000;
export const DISCORD_CATCHUP_PAGES = 3;
export const DISCORD_CATCHUP_PAGE_SIZE = 100;
export const DISCORD_REACTIONS_MAX = 10;
export const DISCORD_REACTION = "👀";

// What the inbound path knows of a bot from its gateway session.
export interface DiscordBotView {
  userId: string;
  // The bot's Discord user id and name.
  botUserId: string;
  botName: string;
  token: string;
  // The bot's managed roles in a guild.
  roleIds(guildId: string): string[];
  // Where a channel or thread sits: its channel (the parent for a thread),
  // that channel's category and name. Null when the bot does not know it.
  place(
    guildId: string,
    channelId: string,
  ): (DiscordMessagePlace & { channelName: string }) | null;
  // The kind of a channel the bot sees (not a thread); null when unknown.
  kindOf(guildId: string, channelId: string): DiscordChannelKind | null;
  // The text channels a route covers (a channel route: its channel when it
  // is text; a category: its text channels; a server: every text channel).
  textChannels(route: DiscordRoute): string[];
}

export interface DiscordInboundDeps {
  clock: DiscordClock;
  rest: DiscordRest;
  // The bot's view, or null when it is not connected (or not this member's).
  bot(userId: string, botId: string): DiscordBotView | null;
  forPlace(userId: string, place: DiscordMessagePlace): DiscordRoute | null;
  forBot(userId: string, botId: string): DiscordRoute[];
  check(userId: string, route: DiscordRoute): DiscordRouteDead | null;
  // Each bot's own cursors, by channel or thread id.
  readCursors(userId: string, botId: string): Record<string, string>;
  writeCursors(
    userId: string,
    botId: string,
    cursors: Record<string, string>,
  ): void;
  memberName(userId: string): string;
  // Queues the text to the route's agent; false when the agent refused it.
  deliver(userId: string, route: DiscordRoute, text: string): boolean;
}

export interface DiscordInbound {
  onMessage(userId: string, botId: string, msg: DiscordMessage): void;
  // A fresh gateway session: runs the catch-up. Never rejects.
  onReady(userId: string, botId: string): Promise<void>;
  // The office stops: every pending burst is delivered now.
  flushAll(): void;
  // The bot is gone: its pending bursts are dropped.
  dropBot(userId: string, botId: string): void;
}

// Discord's message types that carry a member's text: DEFAULT and REPLY.
const TEXT_TYPES = new Set([0, 19]);

interface PendingLine {
  id: string;
  line: DiscordBlockLine;
}

// One channel's or thread's lines since its last delivery.
interface Pending {
  userId: string;
  botId: string;
  guildId: string;
  // The id the messages were posted in: the cursor key.
  channelId: string;
  lines: PendingLine[];
  ids: Set<string>;
  // Set from the first line that counts until the delivery.
  firstAt: number | null;
  quietTimer: unknown;
  maxTimer: unknown;
  // Catch-ups running for this channel: no delivery meanwhile.
  holds: number;
  // The next delivery says that messages went unread.
  gap: boolean;
}

export function createDiscordInbound(deps: DiscordInboundDeps): DiscordInbound {
  const { clock } = deps;
  const pending = new Map<string, Pending>();
  // Bumped by dropBot, so a catch-up that runs on stops feeding.
  const gens = new Map<string, number>();
  const botKey = (userId: string, botId: string) => `${userId}\n${botId}`;
  const keyOf = (userId: string, botId: string, channelId: string) =>
    `${userId}\n${botId}\n${channelId}`;

  function pendingFor(
    userId: string,
    botId: string,
    guildId: string,
    channelId: string,
  ): Pending {
    const key = keyOf(userId, botId, channelId);
    let p = pending.get(key);
    if (!p) {
      p = {
        userId,
        botId,
        guildId,
        channelId,
        lines: [],
        ids: new Set(),
        firstAt: null,
        quietTimer: null,
        maxTimer: null,
        holds: 0,
        gap: false,
      };
      pending.set(key, p);
    }
    return p;
  }

  function clearTimers(p: Pending): void {
    clock.clearTimeout(p.quietTimer);
    clock.clearTimeout(p.maxTimer);
    p.quietTimer = null;
    p.maxTimer = null;
  }

  // The ids below the floors: the stored cursor of the channel, the route's
  // creation and the age limit. Each a snowflake compared as BigInt.
  function floors(
    userId: string,
    botId: string,
    channelId: string,
    route: DiscordRoute,
  ) {
    const stored = deps.readCursors(userId, botId)[channelId];
    const created = (snowflakeFromTime(route.createdAt) - 1n).toString();
    const aged = (
      snowflakeFromTime(clock.now() - DISCORD_MAX_AGE_MS) - 1n
    ).toString();
    const cursor =
      stored && isSnowflake(stored) ? maxSnowflake(stored, created) : created;
    return { cursor, all: maxSnowflake(cursor, aged) };
  }

  // One reaction at a time, after the delivery. The first failure ends
  // them with one log line that carries no error text (it may hold the
  // token).
  async function react(
    token: string,
    channelId: string,
    messageIds: string[],
  ): Promise<void> {
    for (const messageId of messageIds) {
      let failed: string | null = null;
      try {
        const res = await deps.rest.addReaction(
          token,
          channelId,
          messageId,
          DISCORD_REACTION,
        );
        if (!res.ok) failed = res.reason;
      } catch {
        failed = "error";
      }
      if (failed !== null) {
        console.warn(`[discord] a reaction was not added (${failed})`);
        return;
      }
    }
  }

  function schedule(key: string, p: Pending): void {
    if (p.firstAt === null) {
      p.firstAt = clock.now();
      p.maxTimer = clock.setTimeout(() => flush(key), DISCORD_BURST_MAX_MS);
    }
    clock.clearTimeout(p.quietTimer);
    p.quietTimer = clock.setTimeout(() => flush(key), DISCORD_BURST_QUIET_MS);
  }

  function take(userId: string, botId: string, msg: DiscordMessage): void {
    const view = deps.bot(userId, botId);
    if (!view) return;
    if (msg.author.id === view.botUserId) return;
    if (!TEXT_TYPES.has(msg.type)) return;
    if (!isSnowflake(msg.id)) return;
    const where = view.place(msg.guildId, msg.channelId);
    if (!where) return;
    const { channelName, ...place } = where;
    const route = deps.forPlace(userId, { ...place, botId });
    if (!route) return;
    if ((msg.author.bot || msg.webhook) && route.includeBots !== true) return;
    if (
      compareSnowflakes(
        msg.id,
        floors(userId, botId, msg.channelId, route).all,
      ) <= 0
    )
      return;
    const key = keyOf(userId, botId, msg.channelId);
    const p = pendingFor(userId, botId, msg.guildId, msg.channelId);
    if (p.ids.has(msg.id)) return;
    const counted =
      route.trigger === "all" || msg.mentionsBot || msg.replyToBot;
    p.ids.add(msg.id);
    p.lines.push({
      id: msg.id,
      line: {
        from: msg.author.name,
        authorId: msg.author.id,
        channel: channelName,
        channelId: msg.channelId,
        messageId: msg.id,
        link: `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`,
        text: msg.content,
        attachments: msg.attachments,
        ...(counted ? {} : { context: true as const }),
      },
    });
    if (!counted) {
      // Context alone waits for the next line that counts; the cap keeps
      // memory bounded meanwhile.
      const context = p.lines.filter((l) => l.line.context);
      if (context.length > DISCORD_CONTEXT_MAX) {
        const oldest = context.reduce((a, b) =>
          compareSnowflakes(a.id, b.id) <= 0 ? a : b,
        );
        p.lines.splice(p.lines.indexOf(oldest), 1);
        p.ids.delete(oldest.id);
      }
      return;
    }
    schedule(key, p);
  }

  function flush(key: string, force = false): void {
    const p = pending.get(key);
    if (!p) return;
    clearTimers(p);
    if (p.holds > 0 && !force) return;
    try {
      if (!p.lines.some((l) => !l.line.context)) {
        // Nothing counts: the context waits for the next line that does.
        p.firstAt = null;
        if (p.lines.length === 0 && !p.gap) pending.delete(key);
        return;
      }
      pending.delete(key);
      const view = deps.bot(p.userId, p.botId);
      const where = view?.place(p.guildId, p.channelId);
      if (!where) return;
      const { channelName: _name, ...place } = where;
      void _name;
      const route = deps.forPlace(p.userId, { ...place, botId: p.botId });
      if (!route || deps.check(p.userId, route) !== null) return;
      const sorted = [...p.lines].sort((a, b) => compareSnowflakes(a.id, b.id));
      // The context cap keeps the newest.
      const context = sorted.filter((l) => l.line.context);
      const drop = new Set(
        context.slice(0, Math.max(0, context.length - DISCORD_CONTEXT_MAX)),
      );
      const lines = sorted.filter((l) => !drop.has(l));
      const channelRequired = !(
        route.scope === "channel" &&
        view?.kindOf(route.guildId, route.targetId) === "text"
      );
      const text = buildDiscordBlock({
        routeId: route.id,
        routeName: route.name,
        memberName: deps.memberName(p.userId),
        replyMode: route.replyMode,
        ...(p.gap ? { gap: true } : {}),
        ...(channelRequired ? { channelRequired: true } : {}),
        lines: lines.map((l) => l.line),
        reservedChars:
          formatMessagingSenderPrefix(DISCORD_APP, route.name).length + 1,
      });
      if (!deps.deliver(p.userId, route, text)) {
        console.warn("[discord] an agent did not take a Discord delivery");
        return;
      }
      const cursors = deps.readCursors(p.userId, p.botId);
      const newest = lines[lines.length - 1].id;
      const stored = cursors[p.channelId];
      cursors[p.channelId] =
        stored && isSnowflake(stored) ? maxSnowflake(stored, newest) : newest;
      deps.writeCursors(p.userId, p.botId, cursors);
      if (route.react === true && view) {
        const counted = lines
          .filter((l) => !l.line.context)
          .slice(-DISCORD_REACTIONS_MAX)
          .map((l) => l.id);
        void react(view.token, p.channelId, counted);
      }
    } catch {
      console.error("[discord] a Discord delivery failed");
    }
  }

  // Reads one channel or thread back to its floors, newest first, and feeds
  // what it finds oldest first. True when messages above the cursor went
  // unread (the page cap, the age limit or a failed read).
  async function catchUp(
    userId: string,
    botId: string,
    view: DiscordBotView,
    guildId: string,
    channelId: string,
    gen: number,
  ): Promise<boolean> {
    const where = view.place(guildId, channelId);
    if (!where) return false;
    const { channelName: _name, ...place } = where;
    void _name;
    const route = deps.forPlace(userId, { ...place, botId });
    if (!route) return false;
    const { cursor, all } = floors(userId, botId, channelId, route);
    const found: DiscordMessage[] = [];
    let gap = false;
    let before: string | undefined;
    let reached = false;
    for (let page = 0; page < DISCORD_CATCHUP_PAGES && !reached; page++) {
      const res = await deps.rest.messages(view.token, {
        guildId,
        channelId,
        ...(before ? { before } : {}),
        limit: DISCORD_CATCHUP_PAGE_SIZE,
        botUserId: view.botUserId,
        botRoleIds: view.roleIds(guildId),
      });
      if (!res.ok) return true;
      for (const m of res.messages) {
        if (!isSnowflake(m.id)) continue;
        if (compareSnowflakes(m.id, cursor) <= 0) {
          reached = true;
          continue;
        }
        if (compareSnowflakes(m.id, all) <= 0) {
          // Above the cursor and the route, but over the age limit.
          gap = true;
          reached = true;
          continue;
        }
        found.push(m);
        if (!before || compareSnowflakes(m.id, before) < 0) before = m.id;
      }
      if (res.messages.length < DISCORD_CATCHUP_PAGE_SIZE) reached = true;
    }
    if (!reached) gap = true;
    if (gens.get(botKey(userId, botId)) !== gen) return false;
    found.sort((a, b) => compareSnowflakes(a.id, b.id));
    for (const m of found) take(userId, botId, { ...m, channelId });
    return gap;
  }

  return {
    onMessage(userId, botId, msg) {
      try {
        take(userId, botId, msg);
      } catch {
        console.error("[discord] a Discord message could not be read");
      }
    },

    async onReady(userId, botId) {
      // The holds not yet released: each one goes when its channel's own
      // catch-up ends, the rest in finally.
      const held = new Set<Pending>();
      const release = (p: Pending) => {
        if (!held.delete(p)) return;
        p.holds--;
        const key = keyOf(p.userId, p.botId, p.channelId);
        if (p.holds > 0 || pending.get(key) !== p) return;
        if (p.lines.some((l) => !l.line.context)) schedule(key, p);
        else if (p.lines.length === 0 && !p.gap) pending.delete(key);
      };
      try {
        const view = deps.bot(userId, botId);
        if (!view) return;
        const gen = gens.get(botKey(userId, botId)) ?? 0;
        gens.set(botKey(userId, botId), gen);
        // The channels the live routes cover, by server.
        const byGuild = new Map<string, Set<string>>();
        for (const route of deps.forBot(userId, botId)) {
          const set = byGuild.get(route.guildId) ?? new Set<string>();
          for (const id of view.textChannels(route)) set.add(id);
          byGuild.set(route.guildId, set);
        }
        const hold = (guildId: string, channelId: string) => {
          const p = pendingFor(userId, botId, guildId, channelId);
          // A channel listed twice is held once.
          if (held.has(p)) return p;
          p.holds++;
          held.add(p);
          return p;
        };
        const work: { guildId: string; channelId: string; p: Pending }[] = [];
        for (const [guildId, channels] of byGuild)
          for (const channelId of channels)
            work.push({ guildId, channelId, p: hold(guildId, channelId) });
        for (const [guildId, channels] of byGuild) {
          try {
            const res = await deps.rest.activeThreads(view.token, guildId);
            if (!res.ok) continue;
            // A thread is read when a live route covers it: also a forum
            // post, whose forum has no messages of its own to read.
            for (const t of res.threads) {
              const where = view.place(guildId, t.id);
              if (!where || channels.has(t.id)) continue;
              const { channelName: _name, ...place } = where;
              void _name;
              if (deps.forPlace(userId, { ...place, botId }))
                work.push({ guildId, channelId: t.id, p: hold(guildId, t.id) });
            }
          } catch {
            console.warn("[discord] the active threads could not be read");
          }
        }
        for (const { guildId, channelId, p } of work) {
          let gap: boolean;
          try {
            gap = await catchUp(userId, botId, view, guildId, channelId, gen);
          } catch {
            gap = true;
          }
          if (gap) p.gap = true;
          release(p);
        }
      } catch {
        console.error("[discord] a Discord catch-up failed");
      } finally {
        for (const p of [...held]) release(p);
      }
    },

    flushAll() {
      for (const key of [...pending.keys()]) flush(key, true);
    },

    dropBot(userId, botId) {
      const k = botKey(userId, botId);
      gens.set(k, (gens.get(k) ?? 0) + 1);
      for (const [key, p] of pending)
        if (p.userId === userId && p.botId === botId) {
          clearTimers(p);
          pending.delete(key);
        }
    },
  };
}
