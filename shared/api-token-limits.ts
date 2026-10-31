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

export interface ApiTokenLimits {
  // An absent area is no access.
  areas: Partial<Record<ApiTokenArea, ApiTokenAccess>>;
}

// A route's place in the limits. "always": every token may call it (its own
// inbox, the agent reference).
export type RouteTokenArea =
  | { area: ApiTokenArea; level: ApiTokenAccess }
  | "always";

// Write access to these areas lets the holder reach everything: code on the
// box, text in every agent's prompt, an agent that acts with its manager's
// rights, or a new member.
export const FULL_ACCESS_WRITE_AREAS: ReadonlySet<ApiTokenArea> =
  new Set<ApiTokenArea>([
    "office",
    "rooms",
    "agents",
    "agentManagement",
    "files",
    "asks",
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

const READ_ONLY: ApiTokenLimits = {
  areas: Object.fromEntries(
    API_TOKEN_AREAS.filter((area) => !READ_SHOWS_SECRETS.has(area)).map(
      (area) => [area, "read"],
    ),
  ),
};

export const API_TOKEN_PRESETS: {
  readOnly: ApiTokenLimits;
  talkToAgents: ApiTokenLimits;
} = {
  readOnly: READ_ONLY,
  talkToAgents: { areas: { ...READ_ONLY.areas, agents: "write" } },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_AREAS: ReadonlySet<string> = new Set(API_TOKEN_AREAS);

// null: not a valid limits value (an unknown area or level, or extra keys).
export function parseApiTokenLimits(value: unknown): ApiTokenLimits | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "areas") return null;
  const areas = value.areas;
  if (!isPlainObject(areas)) return null;
  const out: Partial<Record<ApiTokenArea, ApiTokenAccess>> = {};
  for (const [area, level] of Object.entries(areas)) {
    if (!KNOWN_AREAS.has(area)) return null;
    if (level !== "read" && level !== "write") return null;
    out[area as ApiTokenArea] = level;
  }
  return { areas: out };
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
  if (tokenArea === "always") return true;
  const held = Object.hasOwn(limits.areas, tokenArea.area)
    ? limits.areas[tokenArea.area]
    : undefined;
  if (held === "write") return true;
  return held === "read" && tokenArea.level === "read";
}
