// The user, plugin and synced skills of an isolated member's agent (part
// 2d-iii-a). The office never reads the member's roots, a plugin path their
// Claude reports or their synced folder with its own files: their runner
// lists them (user-skills) and reads one at its invocation (user-skill).
// Every reply is member data and is checked here before anything uses it:
// one entry out of shape refuses the whole reply.
import type { SkillInfo } from "../shared/types.ts";
import type { AgentHost } from "./agent-host.ts";
import {
  PROJECT_SKILL_BODY_MAX,
  PROJECT_SKILL_LIST_MAX,
  PROJECT_SKILL_REPLY_MAX,
  PROJECT_SKILL_TEXT_MAX,
  type ProjectSkillMeta,
} from "./project-skill-scan.ts";
import {
  isMemberSkillName,
  type UserSkillLists,
  type UserSkillScanInput,
} from "./user-skill-scan.ts";

export type { UserSkillLists, UserSkillScanInput };

// A runner call for one entry gets this long; a runner that does not answer
// is a failed call.
export const USER_SKILL_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const META_KEYS = new Set(["name", "kind", "description"]);
const LISTS = ["user", "plugin", "synced"] as const;

function parseList(
  reply: unknown,
  kind: "user" | "plugin",
): ProjectSkillMeta[] | null {
  if (!Array.isArray(reply) || reply.length > PROJECT_SKILL_LIST_MAX)
    return null;
  const out: ProjectSkillMeta[] = [];
  for (const entry of reply) {
    if (!isRecord(entry)) return null;
    if (Object.keys(entry).some((key) => !META_KEYS.has(key))) return null;
    const { name, kind: fileKind, description } = entry;
    if (!isMemberSkillName(name, kind)) return null;
    if (fileKind !== "skill" && fileKind !== "command") return null;
    if (
      description !== undefined &&
      (typeof description !== "string" ||
        bytes(description) > PROJECT_SKILL_TEXT_MAX)
    )
      return null;
    out.push({
      name,
      kind: fileKind,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return out;
}

// The runner's lists, or null when any part is out of shape or bounds. Only
// a Claude agent has plugin and synced skills.
export function parseUserSkillLists(
  reply: unknown,
  engine: UserSkillScanInput["engine"],
): UserSkillLists | null {
  if (!isRecord(reply)) return null;
  const keys = Object.keys(reply);
  if (keys.length !== LISTS.length || !LISTS.every((k) => keys.includes(k)))
    return null;
  if (bytes(JSON.stringify(reply)) > PROJECT_SKILL_REPLY_MAX) return null;
  const user = parseList(reply.user, "user");
  const plugin = parseList(reply.plugin, "plugin");
  const synced = parseList(reply.synced, "user");
  if (!user || !plugin || !synced) return null;
  if (engine !== "claude" && (plugin.length > 0 || synced.length > 0))
    return null;
  return { user, plugin, synced };
}

// A list as the menu takes it.
export function userSkillInfos(
  list: ProjectSkillMeta[],
  origin: "user" | "plugin",
): SkillInfo[] {
  return list.map((skill) => ({
    name: skill.name,
    origin,
    ...(skill.description !== undefined
      ? { description: skill.description }
      : {}),
  }));
}

export type UserSkillRead =
  | { kind: "ok"; from: "user" | "plugin" | "synced"; prompt: string }
  | { kind: "missing" }
  | { kind: "failed" };

// The runner's answer for skill `name`, or failed when it is out of shape,
// over the bound or for another skill.
export function parseUserSkillBody(
  reply: unknown,
  name: string,
): UserSkillRead {
  if (!isRecord(reply) || reply.name !== name) return { kind: "failed" };
  const keys = Object.keys(reply).sort().join(",");
  if (keys === "missing,name")
    return reply.missing === true ? { kind: "missing" } : { kind: "failed" };
  if (keys !== "body,from,name") return { kind: "failed" };
  const { from, body } = reply;
  if (from !== "user" && from !== "plugin" && from !== "synced")
    return { kind: "failed" };
  if (typeof body !== "string" || bytes(body) > PROJECT_SKILL_BODY_MAX)
    return { kind: "failed" };
  // A plugin skill has a plugin name, any other none.
  if ((from === "plugin") !== name.includes(":")) return { kind: "failed" };
  return {
    kind: "ok",
    from,
    // As skills.ts readSkillPrompt gives it: no frontmatter, trimmed.
    prompt: body.replace(/^---\n[\s\S]*?\n---\n*/, "").trim(),
  };
}

// The member runner's lists. A failed call, a runner that does not answer
// in time or a reply out of shape gives null, and the caller logs it.
export async function fetchUserSkillLists(
  host: AgentHost,
  input: UserSkillScanInput,
): Promise<UserSkillLists | null> {
  try {
    return parseUserSkillLists(
      await host.runEntry("user-skills", input, USER_SKILL_TIMEOUT_MS),
      input.engine,
    );
  } catch {
    return null;
  }
}

// Skill `name` read now by the member runner.
export async function fetchUserSkillPrompt(
  host: AgentHost,
  input: UserSkillScanInput,
  name: string,
): Promise<UserSkillRead> {
  if (!isMemberSkillName(name, name.includes(":") ? "plugin" : "user"))
    return { kind: "missing" };
  let reply: unknown;
  try {
    reply = await host.runEntry(
      "user-skill",
      { ...input, name },
      USER_SKILL_TIMEOUT_MS,
    );
  } catch {
    return { kind: "failed" };
  }
  return parseUserSkillBody(reply, name);
}
