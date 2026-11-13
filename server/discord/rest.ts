// The Discord REST calls the server makes itself (task 7fd44c30): the token
// check at connect, the catch-up reads, and (slice 2) a post as the bot and
// a reaction. Each call answers a result and
// never throws; an error text passes through `redact` before it is returned,
// so no token reaches a log.

import { normaliseApiMessage, type DiscordMessage } from "./protocol.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
// How many times a call waits out a 429 before it gives up.
export const DISCORD_RATE_LIMIT_RETRIES = 3;
// The longest retry_after a call waits; a longer one gives up.
export const DISCORD_RATE_LIMIT_WAIT_MAX_MS = 60_000;

export interface DiscordRestDeps {
  baseUrl: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep(ms: number): Promise<void>;
  redact(text: string): string;
}

export type DiscordRestFailure = {
  ok: false;
  // unauthorized: 401. rate_limited: 429 after the retries. failed: any
  // other status or a network error.
  reason: "unauthorized" | "rate_limited" | "failed";
  error: string;
};

export type DiscordMe =
  { ok: true; id: string; name: string; bot: boolean } | DiscordRestFailure;

// The newest messages of a channel or thread, newest first, at most `limit`
// (1..100), before `before` when given, in the same normalised shape the
// gateway child gives. botUserId and botRoleIds decide mentionsBot and
// replyToBot.
export type DiscordMessagesPage =
  { ok: true; messages: DiscordMessage[] } | DiscordRestFailure;

export type DiscordThreadsPage =
  | { ok: true; threads: { id: string; parentId: string }[] }
  | DiscordRestFailure;

// A post or a reaction (slice 2). unauthorized: 401 (the token is refused).
// forbidden: 403 (no permission). not_found: 404 (the channel or message is
// gone). rejected: another 4xx, for example an archived or locked thread.
// rate_limited: 429 after the retries. failed: a 5xx or a body it cannot
// read. unknown: a network error or a timeout, so the post may have gone out.
export type DiscordWriteFailure = {
  ok: false;
  reason:
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "rejected"
    | "rate_limited"
    | "failed"
    | "unknown";
  error: string;
};

export type DiscordPostResult = { ok: true; id: string } | DiscordWriteFailure;
export type DiscordReactResult = { ok: true } | DiscordWriteFailure;

// A post as the bot: allowed_mentions parse [] and replied_user false, so it
// pings nobody; the nonce with enforce_nonce, so a retry posts once within
// Discord's window. replyTo becomes a message_reference that does not fail
// when the message is gone.
export interface DiscordPostReq {
  content: string;
  replyTo?: string;
  nonce: string;
}

export interface DiscordRest {
  me(token: string): Promise<DiscordMe>;
  postMessage(
    token: string,
    channelId: string,
    req: DiscordPostReq,
  ): Promise<DiscordPostResult>;
  // PUT /channels/:channelId/messages/:messageId/reactions/:emoji/@me.
  addReaction(
    token: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<DiscordReactResult>;
  messages(
    token: string,
    req: {
      guildId: string;
      channelId: string;
      before?: string;
      limit: number;
      botUserId: string;
      botRoleIds: string[];
    },
  ): Promise<DiscordMessagesPage>;
  activeThreads(token: string, guildId: string): Promise<DiscordThreadsPage>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createDiscordRest(deps: DiscordRestDeps): DiscordRest {
  const failure = (
    reason: DiscordRestFailure["reason"],
    error: string,
  ): DiscordRestFailure => ({ ok: false, reason, error: deps.redact(error) });

  // One GET with the bot token, a 429 waited out at most
  // DISCORD_RATE_LIMIT_RETRIES times. The parsed body, or a failure.
  async function get(
    token: string,
    path: string,
  ): Promise<{ ok: true; body: unknown } | DiscordRestFailure> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(`${deps.baseUrl}${path}`, {
          method: "GET",
          headers: { authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return failure("failed", `Discord did not answer: ${String(err)}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      if (res.status === 429) {
        const after =
          isObj(body) && typeof body.retry_after === "number"
            ? body.retry_after * 1000
            : DISCORD_RATE_LIMIT_WAIT_MAX_MS + 1;
        if (
          attempt >= DISCORD_RATE_LIMIT_RETRIES ||
          !(after >= 0) ||
          after > DISCORD_RATE_LIMIT_WAIT_MAX_MS
        )
          return failure("rate_limited", "Discord rate limit");
        await deps.sleep(Math.ceil(after));
        continue;
      }
      if (res.status === 401)
        return failure("unauthorized", "401 Unauthorized");
      if (!res.ok) {
        const message =
          isObj(body) && typeof body.message === "string" ? body.message : "";
        return failure("failed", `Discord answered ${res.status} ${message}`);
      }
      if (body === undefined)
        return failure("failed", "Discord answered with no JSON");
      return { ok: true, body };
    }
  }

  const writeFailure = (
    reason: DiscordWriteFailure["reason"],
    error: string,
  ): DiscordWriteFailure => ({ ok: false, reason, error: deps.redact(error) });

  // One POST or PUT with the bot token, a 429 waited out at most
  // DISCORD_RATE_LIMIT_RETRIES times with the same body. A thrown fetch is
  // unknown: the request may have reached Discord. The parsed body (undefined
  // when there is none), or a failure.
  async function write(
    token: string,
    method: "POST" | "PUT",
    path: string,
    json?: unknown,
  ): Promise<{ ok: true; body: unknown } | DiscordWriteFailure> {
    const body = json === undefined ? undefined : JSON.stringify(json);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(`${deps.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return writeFailure(
          "unknown",
          `Discord did not answer: ${String(err)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      if (res.status === 429) {
        const after =
          isObj(parsed) && typeof parsed.retry_after === "number"
            ? parsed.retry_after * 1000
            : DISCORD_RATE_LIMIT_WAIT_MAX_MS + 1;
        if (
          attempt >= DISCORD_RATE_LIMIT_RETRIES ||
          !(after >= 0) ||
          after > DISCORD_RATE_LIMIT_WAIT_MAX_MS
        )
          return writeFailure("rate_limited", "Discord rate limit");
        await deps.sleep(Math.ceil(after));
        continue;
      }
      if (res.ok) return { ok: true, body: parsed };
      const message =
        isObj(parsed) && typeof parsed.message === "string"
          ? parsed.message
          : "";
      const reason: DiscordWriteFailure["reason"] =
        res.status === 401
          ? "unauthorized"
          : res.status === 403
            ? "forbidden"
            : res.status === 404
              ? "not_found"
              : res.status >= 400 && res.status < 500
                ? "rejected"
                : "failed";
      return writeFailure(reason, `Discord answered ${res.status} ${message}`);
    }
  }

  return {
    async me(token) {
      const res = await get(token, "/users/@me");
      if (!res.ok) return res;
      const b = res.body;
      if (
        !isObj(b) ||
        typeof b.id !== "string" ||
        typeof b.username !== "string"
      )
        return failure("failed", "Discord answered an unknown user shape");
      return { ok: true, id: b.id, name: b.username, bot: b.bot === true };
    },

    async messages(token, req) {
      const query = new URLSearchParams({ limit: String(req.limit) });
      if (req.before !== undefined) query.set("before", req.before);
      const res = await get(
        token,
        `/channels/${encodeURIComponent(req.channelId)}/messages?${query}`,
      );
      if (!res.ok) return res;
      if (!Array.isArray(res.body))
        return failure("failed", "Discord answered an unknown page shape");
      const ctx = {
        guildId: req.guildId,
        botUserId: req.botUserId,
        botRoleIds: req.botRoleIds,
      };
      const messages: DiscordMessage[] = [];
      for (const raw of res.body) {
        const msg = normaliseApiMessage(raw, ctx);
        if (msg) messages.push(msg);
      }
      return { ok: true, messages };
    },

    async postMessage(token, channelId, req) {
      const res = await write(
        token,
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          content: req.content,
          nonce: req.nonce,
          enforce_nonce: true,
          allowed_mentions: { parse: [], replied_user: false },
          ...(req.replyTo !== undefined
            ? {
                message_reference: {
                  message_id: req.replyTo,
                  fail_if_not_exists: false,
                },
              }
            : {}),
        },
      );
      if (!res.ok) return res;
      if (!isObj(res.body) || typeof res.body.id !== "string")
        return writeFailure(
          "failed",
          "Discord answered an unknown message shape",
        );
      return { ok: true, id: res.body.id };
    },

    async addReaction(token, channelId, messageId, emoji) {
      const res = await write(
        token,
        "PUT",
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      );
      return res.ok ? { ok: true } : res;
    },

    async activeThreads(token, guildId) {
      const res = await get(
        token,
        `/guilds/${encodeURIComponent(guildId)}/threads/active`,
      );
      if (!res.ok) return res;
      const b = res.body;
      if (!isObj(b) || !Array.isArray(b.threads))
        return failure("failed", "Discord answered an unknown threads shape");
      const threads: { id: string; parentId: string }[] = [];
      for (const t of b.threads)
        if (
          isObj(t) &&
          typeof t.id === "string" &&
          typeof t.parent_id === "string"
        )
          threads.push({ id: t.id, parentId: t.parent_id });
      return { ok: true, threads };
    },
  };
}
