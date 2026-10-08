import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type { Identity } from "./identity/index.ts";

export const AGENT_REFERENCE_TOPICS = {
  discovery: "Agent and member discovery",
  tasks: "Task board",
  "chat-affordances": "Files, diffs, editor, terminal, and page preview",
  browser: "Desktop browser control",
  apps: "Agent-built apps",
  webhooks: "Webhooks from outside services",
  usage: "Context and subscription readings",
  "conversation-history": "Conversation logs and sessions",
  messaging: "Inter-agent and remote-member messaging",
  "scheduled-messages": "Scheduled messages",
  "conversation-lifecycle": "New conversations and handoffs",
  cronjobs: "Cronjob inspection",
  memory: "Shared memory",
  visuals: "Inline diagrams",
  "agent-management": "Privileged agent setup and conversation driving",
  rooms: "Privileged room management",
  "cronjob-management": "Privileged cronjob management",
  "members-chat": "Privileged members-chat use",
  members: "Privileged member creation",
  pager: "Pages to your manager",
  skills: "Skills: list, read, edit and create",
} as const;

export type AgentReferenceTopic = keyof typeof AGENT_REFERENCE_TOPICS;

// Pages only a privileged agent sees.
export const PRIVILEGED_REFERENCE_TOPICS: ReadonlySet<AgentReferenceTopic> =
  new Set([
    "agent-management",
    "rooms",
    "cronjob-management",
    "members-chat",
    "members",
  ]);

// Written right after a route the OpenCode authority broker refuses, at each
// place a topic names it. The broker allowlist test checks both directions.
export const OPENCODE_UNAVAILABLE_MARK = "(not available to OpenCode agents)";

// Every office route that the prompt teaches an agent is tied to one topic.
// The route-table contract test independently verifies the method/path text in
// that topic and requires every agent-authorized route to be mapped or named in
// the explicit exemption table below.
export const AGENT_ROUTE_REFERENCE_TOPICS: Readonly<
  Record<string, AgentReferenceTopic>
> = {
  "agents.spawn": "agent-management",
  "agents.kill": "agent-management",
  "agents.revive": "agent-management",
  "agents.abort": "messaging",
  "agents.update": "agent-management",
  "agents.move": "agent-management",
  "agents.setTopic": "agent-management",
  "agents.regenerateTopic": "agent-management",
  "rooms.swapDesks": "agent-management",
  "agents.sendMessage": "messaging",
  "agents.listScheduledMessages": "scheduled-messages",
  "agents.cancelScheduledMessage": "scheduled-messages",
  "agents.editMessage": "agent-management",
  "agents.cancelQueued": "agent-management",
  "agents.sendNow": "agent-management",
  "agents.newConversation": "conversation-lifecycle",
  "agents.handoff": "conversation-lifecycle",
  "agents.resume": "agent-management",
  "agents.listSessions": "conversation-history",
  "agents.readFile": "chat-affordances",
  "agents.diff": "chat-affordances",
  "agents.editFile": "chat-affordances",
  "agents.terminalCommand": "chat-affordances",
  "agents.previewUrl": "chat-affordances",
  "agents.browser": "browser",
  "agents.contextUsage": "usage",
  "agents.subscriptionUsage": "usage",
  "agents.logs": "conversation-history",
  "membersChat.page": "members-chat",
  "membersChat.post": "members-chat",
  "membersChat.pin": "members-chat",
  "membersChat.thumbsUp": "members-chat",
  "membersChat.edit": "members-chat",
  "membersChat.delete": "members-chat",
  "membersChat.markRead": "members-chat",
  "membersChat.upload": "members-chat",
  "membersChat.getFile": "members-chat",
  "rooms.create": "rooms",
  "rooms.close": "rooms",
  "rooms.rename": "rooms",
  "rooms.getSettings": "rooms",
  "users.create": "members",
  "rooms.setSettings": "rooms",
  "apiTokenInbox.send": "messaging",
  "tasks.list": "tasks",
  "tasks.get": "tasks",
  "tasks.create": "tasks",
  "tasks.update": "tasks",
  "tasks.claim": "tasks",
  "tasks.done": "tasks",
  "tasks.delete": "tasks",
  "pager.raise": "pager",
  "pager.list": "pager",
  "pager.get": "pager",
  "pager.ack": "pager",
  "pager.resolve": "pager",
  "apps.list": "apps",
  "apps.get": "apps",
  "apps.getThumbnail": "apps",
  "apps.setThumbnail": "apps",
  "apps.register": "apps",
  "apps.update": "apps",
  "apps.delete": "apps",
  "apps.logs": "apps",
  "apps.start": "apps",
  "apps.stop": "apps",
  "apps.restart": "apps",
  "apps.archive": "apps",
  "apps.unarchive": "apps",
  "webhooks.list": "webhooks",
  "webhooks.get": "webhooks",
  "webhooks.create": "webhooks",
  "webhooks.update": "webhooks",
  "webhooks.delete": "webhooks",
  "webhooks.deliveries": "webhooks",
  "webhooks.dryRun": "webhooks",
  "memory.read": "memory",
  "memory.append": "memory",
  "memory.replace": "memory",
  "skills.catalog": "skills",
  "skills.readFile": "skills",
  "skills.saveFile": "skills",
  "skills.create": "skills",
  "cron.list": "cronjob-management",
  "cron.get": "cronjob-management",
  "cron.readSystemPrompt": "cronjob-management",
  "cron.create": "cronjob-management",
  "cron.update": "cronjob-management",
  "cron.delete": "cronjob-management",
  "cron.runNow": "cronjob-management",
  "cron.listRuns": "cronjob-management",
  "cron.listAllRuns": "cronjob-management",
  "cron.getRun": "cronjob-management",
  "cron.runMessage": "cronjob-management",
  "cron.editRunMessage": "cronjob-management",
} as const;

export const AGENT_ROUTE_REFERENCE_EXEMPTIONS: Readonly<
  Record<string, string>
> = {
  "agentReference.list": "Reference bootstrap route.",
  "agentReference.get": "Reference bootstrap route.",
  "agents.readSystemPrompt": "Human UI inspection route.",
  "agents.readInstructions": "Human agent-settings inspection route.",
  "agents.previewSystemPrompt": "Human UI preview route.",
  "agents.respondInteraction":
    "Harness interaction response, not an office feature call.",
  "agents.openFile": "Human editor transport route.",
  "agents.saveFile": "Human editor transport route.",
  "agents.closeFile": "Human editor transport route.",
  "agents.upload": "Human chat upload transport route.",
  "agents.getFile": "Human chat attachment transport route.",
  "sessions.logout": "Cookie-session route; agent authorization is not useful.",
  "validate.cwd": "Human form validation route.",
  "validate.env": "Human form validation route.",
  "backends.listModels": "Human agent-settings route.",
  "skills.usageCounts": "Human skills-settings route.",
  "system.backupStatus": "Human settings status route.",
  "system.version": "Human UI bootstrap route.",
  "storage.usage": "Human settings status route.",
  "usage.read": "Human settings status route.",
} as const;

const topicNames = Object.keys(AGENT_REFERENCE_TOPICS) as AgentReferenceTopic[];
// The pages live under server/ so every package that ships the server ships
// them, and a missing page fails this module load instead of a request.
const referenceDir = join(import.meta.dir, "agent-reference");
const content = new Map(
  topicNames.map((topic) => [
    topic,
    readFileSync(join(referenceDir, `${topic}.md`), "utf8"),
  ]),
);
export const AGENT_REFERENCE_VERSION = createHash("sha256")
  .update(
    topicNames.map((topic) => `${topic}\0${content.get(topic)}`).join("\0"),
  )
  .digest("hex")
  .slice(0, 12);

// Every topic whose text pins this exact `METHOD /path`. A fetch of any of
// them counts as reading that route's contract.
export function topicsPinningRoute(
  method: string,
  path: string,
): AgentReferenceTopic[] {
  const span = `\`${method} ${path}\``;
  return topicNames.filter((topic) => content.get(topic)?.includes(span));
}

export function agentReferenceTopics(identity: Identity) {
  if (identity.scope === "cron-run" || identity.scope === "app") return null;
  return topicNames
    .filter(
      (topic) =>
        !PRIVILEGED_REFERENCE_TOPICS.has(topic) ||
        (identity.scope === "agent" &&
          identity.capabilities.includes("agent:manage")),
    )
    .map((topic) => ({
      topic,
      description: AGENT_REFERENCE_TOPICS[topic],
    }));
}

export function agentReferenceContent(
  identity: Identity,
  topic: string,
): string | null | undefined {
  const visible = agentReferenceTopics(identity);
  if (!visible) return null;
  if (!visible.some((entry) => entry.topic === topic)) return undefined;
  return content.get(topic as AgentReferenceTopic);
}
