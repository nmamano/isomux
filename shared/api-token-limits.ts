// Fine-grained limits on a personal API token: which areas of the office it
// may read or write. A token without limits has full access (every token
// minted before limits existed, and the Full access preset).

export const API_TOKEN_AREAS = [
  "office",
  "rooms",
  "agents",
  "agentManagement",
  "logs",
  "files",
  "tasks",
  "asks",
  "membersChat",
  "memory",
  "skills",
  "schedules",
  "apps",
  "webhooks",
  "pager",
  "environment",
  "voice",
] as const;

export type ApiTokenArea = (typeof API_TOKEN_AREAS)[number];

// Write includes read.
export type ApiTokenAccess = "read" | "write";

// An absent area is no access.
export type ApiTokenAreaLevels = Partial<Record<ApiTokenArea, ApiTokenAccess>>;

// At least one axis is present (no limits at all is full access). An absent
// axis does not limit: no areas = every area, no rooms = every room the member
// can access.
export interface ApiTokenLimits {
  areas?: ApiTokenAreaLevels;
  // Ordinary room ids. The token reaches a room only while the member can
  // access it too.
  rooms?: string[];
  // Agent writes only as replies: a send, an abort or a queue cancel, and only
  // to an agent that wrote to the token first. Needs agents write.
  repliesOnly?: true;
}

// A route's place in the limits. "always": every token may call it (its own
// inbox, the agent reference).
export type RouteTokenArea =
  // reply: a replies-only token may call this route on an agent (:id) that
  // wrote to it. Only on agents write routes.
  { area: ApiTokenArea; level: ApiTokenAccess; reply?: true } | "always";

// Write access to these areas lets the holder reach everything: code on the
// box, text in every agent's prompt, an agent that acts with its manager's
// rights, or a new member. Agents, agentManagement and asks write are not in
// it: a token with a pack writes only to agents that fit inside it, and its
// other messages to agents are replies marked as data (shared/pack-fit.ts).
export const FULL_ACCESS_WRITE_AREAS: ReadonlySet<ApiTokenArea> =
  new Set<ApiTokenArea>([
    "office",
    "rooms",
    "files",
    "memory",
    "skills",
    "schedules",
    "apps",
    "webhooks",
    "environment",
  ]);

// Read access to these areas can show secret values.
export const READ_SHOWS_SECRETS: ReadonlySet<ApiTokenArea> =
  new Set<ApiTokenArea>(["logs", "files", "environment"]);

const READ_ONLY: { areas: ApiTokenAreaLevels } = {
  areas: Object.fromEntries(
    API_TOKEN_AREAS.filter((area) => !READ_SHOWS_SECRETS.has(area)).map(
      (area) => [area, "read"],
    ),
  ),
};

const TALK_TO_AGENTS: { areas: ApiTokenAreaLevels } = {
  areas: { ...READ_ONLY.areas, agents: "write" },
};

export const API_TOKEN_PRESETS: {
  readOnly: { areas: ApiTokenAreaLevels };
  talkToAgents: { areas: ApiTokenAreaLevels };
  repliesOnly: { areas: ApiTokenAreaLevels; repliesOnly: true };
} = {
  readOnly: READ_ONLY,
  talkToAgents: TALK_TO_AGENTS,
  repliesOnly: { areas: TALK_TO_AGENTS.areas, repliesOnly: true },
};

// Whether write access to `area` lets the holder reach everything
// (FULL_ACCESS_WRITE_AREAS).
export function writesEqualFullAccess(area: ApiTokenArea): boolean {
  return FULL_ACCESS_WRITE_AREAS.has(area);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_AREAS: ReadonlySet<string> = new Set(API_TOKEN_AREAS);

// null: not a valid limits value (no axis, an unknown area or level, a bad or
// repeated room id, replies only other than true or without agents write, or
// extra keys). Full access is no limits at all, never an empty value.
export function parseApiTokenLimits(value: unknown): ApiTokenLimits | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (
    keys.some(
      (key) => key !== "areas" && key !== "rooms" && key !== "repliesOnly",
    )
  )
    return null;
  const out: ApiTokenLimits = {};
  if ("areas" in value) {
    const areas = value.areas;
    if (!isPlainObject(areas)) return null;
    const levels: ApiTokenAreaLevels = {};
    for (const [area, level] of Object.entries(areas)) {
      if (!KNOWN_AREAS.has(area)) return null;
      if (level !== "read" && level !== "write") return null;
      levels[area as ApiTokenArea] = level;
    }
    out.areas = levels;
  }
  if ("rooms" in value) {
    const rooms = value.rooms;
    if (!Array.isArray(rooms)) return null;
    if (!rooms.every((id) => typeof id === "string" && id.length > 0))
      return null;
    if (new Set(rooms).size !== rooms.length) return null;
    out.rooms = [...(rooms as string[])];
  }
  if ("repliesOnly" in value) {
    if (value.repliesOnly !== true) return null;
    // Absent areas is every area, agents write included.
    if (out.areas && out.areas.agents !== "write") return null;
    out.repliesOnly = true;
  }
  return out;
}

// Whether a token with `limits` may call a route declaring `tokenArea`.
// Undefined limits is full access; a limited token fails closed on a route
// without a tokenArea.
export function routeAllowedByLimits(
  limits: ApiTokenLimits | undefined,
  tokenArea: RouteTokenArea | undefined,
): boolean {
  if (!limits) return true;
  if (!tokenArea) return false;
  if (!limits.areas) return true;
  if (tokenArea === "always") return true;
  const held = Object.hasOwn(limits.areas, tokenArea.area)
    ? limits.areas[tokenArea.area]
    : undefined;
  if (held === "write") return true;
  return held === "read" && tokenArea.level === "read";
}
