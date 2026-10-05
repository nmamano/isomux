// Per-member pager settings: where a member's pages go (a Discord incoming
// webhook), who to mention, and how often an open page repeats.
//
// The webhook URL is a credential (internal-docs/pager-loop.md, ruling 3). It
// lives in its own file, STATE_ROOT/pager-settings.json (mode 0600), and NOT
// in the member's managed env file: that file is injected into every agent
// the member spawns. The only readers are the delivery module and the
// member's own settings routes, which return the masked form.
//
// Load posture, the same as pager.json:
//   - no file                 → no settings (defaults for everyone)
//   - unparsable / bad shape  → moved aside, start empty; if it cannot be
//                               moved aside, the store is unavailable
//   - unreadable (EACCES...)  → unavailable: reads throw, so a send records a
//                               failure and a save never overwrites the file
//
// LEAF: imports only the atomic writer and shared helpers.

import { readFileSync, renameSync } from "fs";
import { atomicWriteFileSync } from "./persistence.ts";
import { errMessage } from "../shared/errors.ts";
import type {
  PagerSettingsReq,
  PagerSettingsRes,
} from "../shared/contract-shapes.ts";

// The repeat interval when a member has not chosen one (ruling 4: a constant).
export const PAGER_DEFAULT_REPEAT_MINUTES = 5;
// Sanity bound: one day.
export const PAGER_REPEAT_MINUTES_MAX = 1440;

const WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
]);
const WEBHOOK_PATH = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const DISCORD_USER_ID = /^\d{15,25}$/;

export interface PagerMemberSettings {
  webhookUrl?: string;
  discordUserId?: string;
  // Minutes between repeats of an open page; null = never repeat.
  repeatMinutes: number | null;
  // Set by delivery, never by the member: no send to this webhook before
  // this time (Discord's 429 retry_after). Saved so a restart waits too.
  holdUntil?: number;
}

const DEFAULTS: PagerMemberSettings = {
  repeatMinutes: PAGER_DEFAULT_REPEAT_MINUTES,
};

// Accept only a Discord incoming-webhook URL: the server POSTs to whatever is
// saved here, so any other host is refused at save time. Returns the URL in
// canonical form, or null.
export function parseDiscordWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!WEBHOOK_HOSTS.has(url.hostname)) return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.search !== "" || url.hash !== "") return null;
  if (!WEBHOOK_PATH.test(url.pathname)) return null;
  return `https://${url.hostname}${url.pathname}`;
}

// Enough for a member to recognize their webhook: the host and the last four
// characters of the token.
export function maskWebhookUrl(url: string): string {
  const parsed = new URL(url);
  const token = parsed.pathname.split("/").pop() ?? "";
  return `https://${parsed.hostname}/api/webhooks/…${token.slice(-4)}`;
}

export function toPagerSettingsRes(
  settings: PagerMemberSettings,
): PagerSettingsRes {
  return {
    webhookUrlMasked: settings.webhookUrl
      ? maskWebhookUrl(settings.webhookUrl)
      : null,
    discordUserId: settings.discordUserId ?? null,
    repeatMinutes: settings.repeatMinutes,
  };
}

const PATCH_KEYS: ReadonlySet<string> = new Set([
  "webhookUrl",
  "discordUserId",
  "repeatMinutes",
]);

// Validate a PATCH body. An absent key keeps the saved value; null clears it
// (for repeatMinutes, null means "never repeat").
export function parsePagerSettingsPatch(
  raw: unknown,
): { ok: true; patch: PagerSettingsReq } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "body must be an object" };
  }
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, message: `unknown setting: ${unknown.join(", ")}` };
  }
  if (keys.length === 0) return { ok: false, message: "no settings to update" };
  const patch: PagerSettingsReq = {};
  if ("webhookUrl" in body) {
    const v = body.webhookUrl;
    if (v === null || v === "") {
      patch.webhookUrl = null;
    } else {
      const url = typeof v === "string" ? parseDiscordWebhookUrl(v) : null;
      if (!url) {
        return {
          ok: false,
          message:
            "webhookUrl must be a Discord webhook URL (https://discord.com/api/webhooks/...)",
        };
      }
      patch.webhookUrl = url;
    }
  }
  if ("discordUserId" in body) {
    const v = body.discordUserId;
    if (v === null || v === "") {
      patch.discordUserId = null;
    } else if (typeof v === "string" && DISCORD_USER_ID.test(v.trim())) {
      patch.discordUserId = v.trim();
    } else {
      return {
        ok: false,
        message: "discordUserId must be a Discord user ID (digits only)",
      };
    }
  }
  if ("repeatMinutes" in body) {
    const v = body.repeatMinutes;
    if (
      v !== null &&
      !(
        typeof v === "number" &&
        Number.isInteger(v) &&
        v >= 1 &&
        v <= PAGER_REPEAT_MINUTES_MAX
      )
    ) {
      return {
        ok: false,
        message: `repeatMinutes must be an integer from 1 to ${PAGER_REPEAT_MINUTES_MAX}, or null`,
      };
    }
    patch.repeatMinutes = v;
  }
  return { ok: true, patch };
}

function isMemberSettings(v: unknown): v is PagerMemberSettings {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    (s.webhookUrl === undefined || typeof s.webhookUrl === "string") &&
    (s.discordUserId === undefined || typeof s.discordUserId === "string") &&
    (s.repeatMinutes === null || typeof s.repeatMinutes === "number") &&
    (s.holdUntil === undefined || typeof s.holdUntil === "number")
  );
}

export type PagerSettingsLoadResult =
  | { kind: "missing" }
  | { kind: "data"; value: unknown }
  | { kind: "corrupt" }
  | { kind: "unreadable" };

export interface PagerSettingsPersistence {
  load(): PagerSettingsLoadResult;
  // Durable write. MUST THROW on failure.
  save(all: Record<string, PagerMemberSettings>): void;
  quarantine(): boolean;
}

export function createPagerSettingsFilePersistence(
  path: string,
): PagerSettingsPersistence {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "missing" };
        }
        console.error(`[pager] cannot read ${path}: ${errMessage(err)}`);
        return { kind: "unreadable" };
      }
      try {
        return { kind: "data", value: JSON.parse(text) };
      } catch {
        return { kind: "corrupt" };
      }
    },
    save(all) {
      atomicWriteFileSync(path, JSON.stringify(all, null, 2), 0o600);
    },
    quarantine() {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
        console.error(`[pager] ${path} is corrupt; moved it to ${aside}`);
        return true;
      } catch (err) {
        console.error(
          `[pager] ${path} is corrupt and could not be moved aside: ${errMessage(err)}`,
        );
        return false;
      }
    },
  };
}

export class PagerSettingsUnavailableError extends Error {
  constructor() {
    super("the pager settings store is unavailable");
    this.name = "PagerSettingsUnavailableError";
  }
}

export interface PagerSettingsStore {
  // The member's settings, with defaults filled in.
  get(userId: string): PagerMemberSettings;
  update(userId: string, patch: PagerSettingsReq): PagerMemberSettings;
  setHoldUntil(userId: string, at: number): void;
}

export function createPagerSettingsStore(
  persistence: PagerSettingsPersistence,
): PagerSettingsStore {
  let all: Record<string, PagerMemberSettings> = {};
  let available = true;

  const loaded = persistence.load();
  if (loaded.kind === "unreadable") {
    available = false;
  } else if (loaded.kind === "corrupt") {
    available = persistence.quarantine();
  } else if (loaded.kind === "data") {
    const value = loaded.value;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every(isMemberSettings)
    ) {
      all = value as Record<string, PagerMemberSettings>;
    } else {
      available = persistence.quarantine();
    }
  }

  const ensureAvailable = () => {
    if (!available) throw new PagerSettingsUnavailableError();
  };

  const read = (userId: string): PagerMemberSettings => ({
    ...DEFAULTS,
    ...(Object.hasOwn(all, userId) ? all[userId] : {}),
  });

  return {
    get(userId) {
      ensureAvailable();
      return read(userId);
    },

    update(userId, patch) {
      ensureAvailable();
      const next: PagerMemberSettings = read(userId);
      if (patch.webhookUrl === null) delete next.webhookUrl;
      else if (patch.webhookUrl !== undefined) {
        next.webhookUrl = patch.webhookUrl;
      }
      if (patch.discordUserId === null) delete next.discordUserId;
      else if (patch.discordUserId !== undefined) {
        next.discordUserId = patch.discordUserId;
      }
      if (patch.repeatMinutes !== undefined) {
        next.repeatMinutes = patch.repeatMinutes;
      }
      const nextAll = { ...all, [userId]: next };
      persistence.save(nextAll);
      all = nextAll;
      return { ...next };
    },

    setHoldUntil(userId, at) {
      ensureAvailable();
      const nextAll = { ...all, [userId]: { ...read(userId), holdUntil: at } };
      persistence.save(nextAll);
      all = nextAll;
    },
  };
}
