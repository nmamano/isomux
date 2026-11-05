// A member's WhatsApp contact rows and id rings on disk (task d03a61d8,
// slice 2), in their STATE_ROOT/whatsapp/<userId>/ directory beside the
// session:
//   routes.json - the rows, and the phone they were made for: a new link
//                 with another phone drops them
//   seen.json   - the last WHATSAPP_ID_RING_MAX delivered message ids, so a
//                 redelivery after a reconnect is not delivered twice
//   sent.json   - the last WHATSAPP_ID_RING_MAX ids of messages the agents
//                 sent, so an agent's own send is not read as the member's
//                 phone text, and a reply to it counts in a group
// Files are 0600 and written atomically.

import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import {
  normaliseWhatsAppPrefix,
  type WhatsAppRoute,
} from "../../shared/whatsapp.ts";
import { ensureMemberDir, memberDir } from "./store.ts";

export const WHATSAPP_ID_RING_MAX = 500;
const ROUTES_FILE = "routes.json";

export interface RoutesFile {
  phone: string | null;
  routes: WhatsAppRoute[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
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
  const dir = ensureMemberDir(stateRoot, userId);
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

function isRoute(v: unknown): v is WhatsAppRoute {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.chat === "string" &&
    typeof r.group === "boolean" &&
    typeof r.name === "string" &&
    typeof r.agentId === "string" &&
    typeof r.createdAt === "number" &&
    (r.trigger === undefined ||
      r.trigger === "mention" ||
      r.trigger === "all") &&
    (r.dead === undefined ||
      r.dead === "agent_gone" ||
      r.dead === "agent_not_yours" ||
      r.dead === "agent_chat_only")
  );
}

// The optional fields as they are valid: sendDirect only when exactly true,
// and a prefix only when it passes normaliseWhatsAppPrefix and is not blank.
// Anything else is dropped, so a damaged file never makes a row send at once.
function cleanRoute(route: WhatsAppRoute): WhatsAppRoute {
  const { sendDirect, prefix, ...rest } = route as WhatsAppRoute &
    Record<"sendDirect" | "prefix", unknown>;
  const cleanPrefix =
    typeof prefix === "string" ? normaliseWhatsAppPrefix(prefix) : null;
  return {
    ...rest,
    ...(sendDirect === true ? { sendDirect } : {}),
    ...(cleanPrefix ? { prefix: cleanPrefix } : {}),
  };
}

// A file that does not parse reads as no rows.
export function readRoutes(stateRoot: string, userId: string): RoutesFile {
  const raw = readJson(join(memberDir(stateRoot, userId), ROUTES_FILE));
  if (typeof raw !== "object" || raw === null)
    return { phone: null, routes: [] };
  const { phone, routes } = raw as Record<string, unknown>;
  return {
    phone: typeof phone === "string" ? phone : null,
    routes: Array.isArray(routes) ? routes.filter(isRoute).map(cleanRoute) : [],
  };
}

export function writeRoutes(
  stateRoot: string,
  userId: string,
  file: RoutesFile,
): void {
  writeJson(stateRoot, userId, ROUTES_FILE, file);
}

export interface IdRing {
  has(id: string): boolean;
  // Adds the id and saves the ring; the oldest id goes past the cap.
  add(id: string): void;
}

export function openIdRing(
  stateRoot: string,
  userId: string,
  name: "seen" | "sent",
): IdRing {
  const file = `${name}.json`;
  const raw = readJson(join(memberDir(stateRoot, userId), file));
  const ids: string[] = Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string")
    : [];
  const set = new Set(ids);
  return {
    has: (id) => set.has(id),
    add(id) {
      if (set.has(id)) return;
      ids.push(id);
      set.add(id);
      while (ids.length > WHATSAPP_ID_RING_MAX) set.delete(ids.shift()!);
      writeJson(stateRoot, userId, file, ids);
    },
  };
}
