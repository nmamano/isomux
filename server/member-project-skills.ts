// The project skills of an isolated member's agent (part 2b-ii, C5 and D5).
// The office cannot read the member's folder, so their runner scans it
// (project-skills: names and descriptions, no paths) and reads one skill at
// its invocation (project-skill: the current file). Every reply is member
// data: it is checked here before anything uses it, and a path is never
// part of it, so the office never reads a member's skill file.
import type { SkillInfo } from "../shared/types.ts";
import type { SkillEngine } from "../shared/contract-shapes.ts";
import type { AgentHost } from "./agent-host.ts";
import {
  PROJECT_SKILL_BODY_MAX,
  PROJECT_SKILL_LIST_MAX,
  PROJECT_SKILL_REPLY_MAX,
  PROJECT_SKILL_TEXT_MAX,
  SKILL_NAME,
  type ProjectSkillMeta,
} from "./project-skill-scan.ts";

export {
  PROJECT_SKILL_BODY_MAX,
  PROJECT_SKILL_LIST_MAX,
  PROJECT_SKILL_TEXT_MAX,
  type ProjectSkillMeta,
};

// A runner call for one entry gets this long.
const PROJECT_SKILL_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function optionalText(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && bytes(value) <= PROJECT_SKILL_TEXT_MAX)
  );
}

const META_KEYS = new Set(["name", "kind", "description", "aliasFor"]);

// The runner's list, or null when any part of it is out of shape or bounds.
export function parseProjectSkillList(
  reply: unknown,
): ProjectSkillMeta[] | null {
  if (!Array.isArray(reply) || reply.length > PROJECT_SKILL_LIST_MAX)
    return null;
  if (bytes(JSON.stringify(reply)) > PROJECT_SKILL_REPLY_MAX) return null;
  const out: ProjectSkillMeta[] = [];
  for (const entry of reply) {
    if (!isRecord(entry)) return null;
    if (Object.keys(entry).some((key) => !META_KEYS.has(key))) return null;
    const { name, kind, description, aliasFor } = entry;
    if (typeof name !== "string" || !SKILL_NAME.test(name)) return null;
    if (kind !== "skill" && kind !== "command") return null;
    if (!optionalText(description) || !optionalText(aliasFor)) return null;
    out.push({
      name,
      kind,
      ...(description !== undefined ? { description } : {}),
      ...(aliasFor !== undefined ? { aliasFor } : {}),
    });
  }
  return out;
}

// The body of skill `name` from the runner's reply, or null when the reply
// is out of shape, over the bound, or for another skill.
export function parseProjectSkillBody(
  reply: unknown,
  name: string,
): string | null {
  if (!isRecord(reply)) return null;
  if (Object.keys(reply).some((key) => key !== "name" && key !== "body"))
    return null;
  if (reply.name !== name || typeof reply.body !== "string") return null;
  if (bytes(reply.body) > PROJECT_SKILL_BODY_MAX) return null;
  return reply.body;
}

// The list as the menu takes it.
export function projectSkillInfos(list: ProjectSkillMeta[]): SkillInfo[] {
  return list.map((skill) => ({
    name: skill.name,
    origin: "project",
    ...(skill.description !== undefined
      ? { description: skill.description }
      : {}),
    ...(skill.aliasFor !== undefined ? { aliasFor: skill.aliasFor } : {}),
  }));
}

// The runner's answer that no folder has skill `name`: exactly
// {name, missing: true}.
export function projectSkillMissing(reply: unknown, name: string): boolean {
  return (
    isRecord(reply) &&
    Object.keys(reply).every((key) => key === "name" || key === "missing") &&
    reply.name === name &&
    reply.missing === true
  );
}

// The member runner's list for `cwd`. A failed call or a reply out of shape
// gives null, and the caller logs it.
export async function fetchProjectSkillList(
  host: AgentHost,
  cwd: string,
  engine: SkillEngine,
): Promise<ProjectSkillMeta[] | null> {
  try {
    return parseProjectSkillList(
      await host.runEntry(
        "project-skills",
        { cwd, engine },
        PROJECT_SKILL_TIMEOUT_MS,
      ),
    );
  } catch {
    return null;
  }
}

// The prompt of project skill `name`, read now: the file without its
// frontmatter, as skills.ts readSkillFile gives it. `missing` when no
// project folder has it; `failed` for a body over the bound, a reply out of
// shape, or a failed call.
export async function fetchProjectSkillPrompt(
  host: AgentHost,
  cwd: string,
  engine: SkillEngine,
  name: string,
): Promise<
  { kind: "ok"; prompt: string } | { kind: "missing" } | { kind: "failed" }
> {
  let reply: unknown;
  try {
    reply = await host.runEntry(
      "project-skill",
      { cwd, engine, name },
      PROJECT_SKILL_TIMEOUT_MS,
    );
  } catch {
    return { kind: "failed" };
  }
  if (projectSkillMissing(reply, name)) return { kind: "missing" };
  const body = parseProjectSkillBody(reply, name);
  if (body === null) return { kind: "failed" };
  return {
    kind: "ok",
    prompt: body.replace(/^---\n[\s\S]*?\n---\n*/, "").trim(),
  };
}
