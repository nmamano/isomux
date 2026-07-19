// Per-user skill/command-use counters (task f1769b1a). Server-side so counts
// follow the user across devices (localStorage would not sync). A "use" is one
// skill OR built-in command invocation dispatched through the slash-command
// resolver (typed `/name` or picked from the Sk menu — both arrive as the same
// slash message), counted under the invoking USER's id at the dispatch site in
// command-handlers.ts. The menu ranks across skills and commands, so both
// count. Agent- or system-originated invocations resolve no user record and
// are not counted. Read-only consumer: the Sk popover surfaces the most-used
// entries first (GET /api/skill-usage).
//
// Persistence: STATE_ROOT/skill-usage.json, { [userId]: { [skillName]: count } }.
// Loaded lazily once, written through on every increment (skill uses are
// low-frequency; no debounce needed). A missing or corrupted file starts an
// empty store — counts are a convenience, never worth failing a message over.
//
// Skill names come from the FILESYSTEM (skill directory names), so the maps
// here are null-prototype throughout: a skill named "constructor" /
// "__proto__" / "toString" must be an ordinary key, never an inherited
// Object.prototype member (which would corrupt the increment's `?? 0` read).
// JSON round-trips are safe — JSON.parse creates "__proto__" as a plain own
// property, and the entries are copied key-by-key onto null-prototype maps.

import { join } from "path";
import { readFileSync } from "fs";
import { STATE_ROOT } from "./config.ts";
import { atomicWriteFileSync } from "./persistence.ts";

const SKILL_USAGE_FILE = join(STATE_ROOT, "skill-usage.json");

type SkillUsageStore = Record<string, Record<string, number>>;

const nullProto = <T>(): Record<string, T> =>
  Object.create(null) as Record<string, T>;

let store: SkillUsageStore | null = null;

// Keep only well-formed OWN entries (string -> string -> positive integer): a
// hand-edited or damaged file degrades to whatever parses, never a crash.
function sanitize(raw: unknown): SkillUsageStore {
  const out = nullProto<Record<string, number>>();
  if (raw === null || typeof raw !== "object") return out;
  for (const [userId, counts] of Object.entries(raw)) {
    if (counts === null || typeof counts !== "object") continue;
    const clean = nullProto<number>();
    let any = false;
    for (const [skill, n] of Object.entries(counts)) {
      if (typeof n === "number" && Number.isInteger(n) && n > 0) {
        clean[skill] = n;
        any = true;
      }
    }
    if (any) out[userId] = clean;
  }
  return out;
}

function load(): SkillUsageStore {
  if (store) return store;
  try {
    store = sanitize(JSON.parse(readFileSync(SKILL_USAGE_FILE, "utf-8")));
  } catch {
    // Missing file (first run) or unparseable content: start empty.
    store = nullProto<Record<string, number>>();
  }
  return store;
}

export function recordSkillUse(userId: string, skillName: string): void {
  const s = load();
  const counts = (s[userId] ??= nullProto<number>());
  counts[skillName] = (counts[skillName] ?? 0) + 1;
  try {
    atomicWriteFileSync(SKILL_USAGE_FILE, JSON.stringify(s, null, 2));
  } catch (err) {
    // Best-effort: a failed write costs one count on restart, nothing else.
    console.error("skill-usage: failed to persist counts:", err);
  }
}

// Null-prototype copy, not the live object: callers must not be able to
// mutate the store, and downstream key lookups stay inheritance-free.
export function getSkillUseCounts(userId: string): Record<string, number> {
  const out = nullProto<number>();
  const counts = load()[userId];
  if (counts) for (const [k, v] of Object.entries(counts)) out[k] = v;
  return out;
}

export function _testResetSkillUsage(): void {
  store = null;
}
