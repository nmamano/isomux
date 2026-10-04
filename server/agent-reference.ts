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
  usage: "Context and subscription readings",
  "conversation-history": "Conversation logs and sessions",
  messaging: "Inter-agent and remote-member messaging",
  "scheduled-messages": "Scheduled messages",
  "conversation-lifecycle": "New conversations and handoffs",
  cronjobs: "Cronjob inspection",
  memory: "Shared memory",
  visuals: "Inline diagrams",
  operator: "Privileged agent, room, cronjob, and members-chat operations",
} as const;

export type AgentReferenceTopic = keyof typeof AGENT_REFERENCE_TOPICS;

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
  "agents.spawn": "operator",
  "agents.kill": "operator",
  "agents.revive": "operator",
  "agents.abort": "messaging",
  "agents.update": "operator",
  "agents.move": "operator",
  "agents.setTopic": "operator",
  "agents.regenerateTopic": "operator",
  "rooms.swapDesks": "operator",
  "agents.sendMessage": "messaging",
  "agents.listScheduledMessages": "scheduled-messages",
  "agents.cancelScheduledMessage": "scheduled-messages",
  "agents.editMessage": "operator",
  "agents.cancelQueued": "operator",
  "agents.sendNow": "operator",
  "agents.newConversation": "conversation-lifecycle",
  "agents.handoff": "conversation-lifecycle",
  "agents.resume": "operator",
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
  "membersChat.page": "operator",
  "membersChat.post": "operator",
  "membersChat.pin": "operator",
  "membersChat.thumbsUp": "operator",
  "membersChat.edit": "operator",
  "membersChat.delete": "operator",
  "membersChat.markRead": "operator",
  "membersChat.upload": "operator",
  "membersChat.getFile": "operator",
  "rooms.create": "operator",
  "rooms.close": "operator",
  "rooms.rename": "operator",
  "rooms.getSettings": "operator",
  "users.create": "operator",
  "rooms.setSettings": "operator",
  "apiTokenInbox.send": "messaging",
  "tasks.list": "tasks",
  "tasks.get": "tasks",
  "tasks.create": "tasks",
  "tasks.update": "tasks",
  "tasks.claim": "tasks",
  "tasks.done": "tasks",
  "tasks.delete": "tasks",
  "apps.list": "apps",
  "apps.get": "apps",
  "apps.preview": "apps",
  "apps.register": "apps",
  "apps.update": "apps",
  "apps.delete": "apps",
  "apps.logs": "apps",
  "apps.start": "apps",
  "apps.stop": "apps",
  "apps.restart": "apps",
  "memory.read": "memory",
  "memory.append": "memory",
  "memory.replace": "memory",
  "cron.list": "operator",
  "cron.get": "operator",
  "cron.readSystemPrompt": "operator",
  "cron.create": "operator",
  "cron.update": "operator",
  "cron.delete": "operator",
  "cron.runNow": "operator",
  "cron.listRuns": "operator",
  "cron.listAllRuns": "operator",
  "cron.getRun": "operator",
  "cron.runMessage": "operator",
  "cron.editRunMessage": "operator",
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
        topic !== "operator" ||
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
