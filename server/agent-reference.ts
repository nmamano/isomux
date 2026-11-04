import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type { Identity } from "./identity/index.ts";

export const AGENT_REFERENCE_TOPICS = {
  discovery: "Agent and member discovery",
  tasks: "Task board",
  audit: "Office audit log",
  "chat-affordances": "Files, diffs, editor, terminal, and page preview",
  browser: "Desktop browser control",
  apps: "Agent-built apps",
  webhooks: "Webhooks from outside services",
  usage: "Context and subscription readings",
  "conversation-history": "Conversation logs and sessions",
  messaging: "Inter-agent and remote-member messaging",
  "scheduled-messages": "Scheduled messages",
  "conversation-lifecycle": "New conversations and handoffs",
  cronjobs: "Schedule inspection",
  memory: "Shared memory",
  visuals: "Inline diagrams",
  spawning: "Spawn agents and back-room workers, and kill the ones you spawned",
  "agent-management": "Privileged agent setup and conversation driving",
  rooms: "Privileged room management",
  "cronjob-management": "Schedule management",
  "members-chat": "Privileged members-chat use",
  members: "Member creation and special instructions",
  "office-settings": "Office prompt, name and member usage cap",
  pager: "Pages to your manager",
  asks: "Asks: questions a member answers later",
  skills: "Skills: list, read, edit and create",
  connections: "Your connections and their usage notes",
  "asks-history":
    "You need a closed ask, its answer, or what happened to an ask before it closed",
  "connections-settings":
    "You change a member's or the office's variables, secrets, MCP servers, voice or pager settings",
  "apps-server":
    "You write app code that messages agents, pages, opens asks, or acts for the member behind a request",
  "browser-failures":
    "A browser action fails or times out, an office page is refused, or a tab or browser goes away",
  "sudo-requests": "You need to run a command as root",
  "messaging-apps": "Replies to the member's contacts in messaging apps",
} as const;

export type AgentReferenceTopic = keyof typeof AGENT_REFERENCE_TOPICS;

// A sub-page holds part of a parent page that grew past the page cap. It is
// an ordinary topic with its parent's visibility; the parent names it with
// the situation in which to fetch it.
export const AGENT_REFERENCE_SUBPAGES: Readonly<
  Partial<Record<AgentReferenceTopic, AgentReferenceTopic>>
> = {
  "asks-history": "asks",
  "connections-settings": "connections",
  "apps-server": "apps",
  "browser-failures": "browser",
  "sudo-requests": "asks",
  "messaging-apps": "messaging",
};

// Pages only a privileged agent sees.
export const PRIVILEGED_REFERENCE_TOPICS: ReadonlySet<AgentReferenceTopic> =
  new Set([
    "audit",
    "agent-management",
    "rooms",
    "members-chat",
    "members",
    "office-settings",
  ]);

// Every office route that the prompt teaches an agent is tied to one topic.
// The route-table contract test independently verifies the method/path text in
// that topic and requires every agent-authorized route to be mapped or named in
// the explicit exemption table below.
export const AGENT_ROUTE_REFERENCE_TOPICS: Readonly<
  Record<string, AgentReferenceTopic>
> = {
  "agents.discovery": "discovery",
  "agents.avatar": "discovery",
  "agents.spawn": "spawning",
  "agents.kill": "spawning",
  "agents.revive": "agent-management",
  "agents.abort": "messaging",
  "agents.update": "agent-management",
  "agents.readInstructions": "discovery",
  "agents.setInstructions": "agent-management",
  "agents.move": "agent-management",
  "agents.setManager": "agent-management",
  "agents.setTopic": "agent-management",
  "agents.regenerateTopic": "agent-management",
  "rooms.swapDesks": "agent-management",
  "agents.sendMessage": "messaging",
  "agents.listScheduledMessages": "scheduled-messages",
  "agents.cancelScheduledMessage": "scheduled-messages",
  "agents.editMessage": "agent-management",
  "agents.cancelQueued": "messaging",
  "agents.readQueue": "messaging",
  "agents.sendNow": "agent-management",
  "agents.newConversation": "conversation-lifecycle",
  "agents.handoff": "conversation-lifecycle",
  "agents.resume": "agent-management",
  "agents.listSessions": "conversation-history",
  "agents.terminal": "conversation-history",
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
  "floors.list": "rooms",
  "floors.add": "rooms",
  "floors.remove": "rooms",
  "rooms.close": "rooms",
  "rooms.rename": "rooms",
  "rooms.getSettings": "rooms",
  "rooms.readInstructions": "rooms",
  "rooms.setInstructions": "rooms",
  "users.create": "members",
  "users.readInstructions": "discovery",
  "users.setInstructions": "members",
  "office.getSettings": "office-settings",
  "office.getMemberUsageStatus": "office-settings",
  "office.setSettings": "office-settings",
  "office.readInstructions": "office-settings",
  "office.setInstructions": "office-settings",
  "apiTokenInbox.send": "messaging",
  "audit.list": "audit",
  "terminalRecordings.list": "audit",
  "terminalRecordings.get": "audit",
  "githubSync.get": "tasks",
  "githubSync.set": "tasks",
  "githubSync.delete": "tasks",
  "tasks.history": "tasks",
  "tasks.restore": "audit",
  "tasks.list": "tasks",
  "tasks.get": "tasks",
  "tasks.create": "tasks",
  "tasks.update": "tasks",
  "tasks.claim": "tasks",
  "tasks.done": "tasks",
  "tasks.delete": "tasks",
  "agents.createAsk": "asks",
  "agents.listAsks": "asks",
  "agents.getAsk": "asks",
  "agents.getAskFile": "asks",
  "agents.askHistory": "asks-history",
  "agents.askEvents": "asks-history",
  "agents.editAsk": "asks",
  "agents.deleteAsk": "asks",
  "agents.sudoRequest": "sudo-requests",
  "asks.get": "asks-history",
  "messaging.reply": "messaging-apps",
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
  "apps.reload": "apps",
  "apps.archive": "apps",
  "apps.unarchive": "apps",
  "webhooks.list": "webhooks",
  "webhooks.get": "webhooks",
  "webhooks.create": "webhooks",
  "webhooks.update": "webhooks",
  "webhooks.delete": "webhooks",
  "webhooks.deliveries": "webhooks",
  "webhooks.dryRun": "webhooks",
  "webhooks.rotateSecret": "webhooks",
  "memory.read": "memory",
  "memory.append": "memory",
  "memory.replace": "memory",
  "skills.catalog": "skills",
  "skills.readFile": "skills",
  "skills.saveFile": "skills",
  "skills.deleteFile": "skills",
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
  "agentConnections.list": "connections",
  "agents.secretRequest": "connections",
  "userEnv.set": "connections-settings",
  "userEnv.remove": "connections-settings",
  "userEnv.names": "connections-settings",
  "officeEnv.set": "connections-settings",
  "officeEnv.remove": "connections-settings",
  "officeEnv.names": "connections-settings",
  "secrets.list": "connections-settings",
  "secrets.create": "connections-settings",
  "secrets.rotate": "connections-settings",
  "secrets.update": "connections-settings",
  "secrets.delete": "connections-settings",
  "secrets.reissue": "connections-settings",
  "secrets.test": "connections-settings",
  "officeSecrets.list": "connections-settings",
  "officeSecrets.create": "connections-settings",
  "officeSecrets.rotate": "connections-settings",
  "officeSecrets.update": "connections-settings",
  "officeSecrets.delete": "connections-settings",
  "officeSecrets.reissue": "connections-settings",
  "officeSecrets.test": "connections-settings",
  "mcpServers.list": "connections-settings",
  "mcpServers.create": "connections-settings",
  "mcpServers.update": "connections-settings",
  "mcpServers.delete": "connections-settings",
  "mcpServers.test": "connections-settings",
  "officeMcpServers.list": "connections-settings",
  "officeMcpServers.create": "connections-settings",
  "officeMcpServers.update": "connections-settings",
  "officeMcpServers.delete": "connections-settings",
  "officeMcpServers.test": "connections-settings",
  "memberVoice.get": "connections-settings",
  "memberVoice.update": "connections-settings",
  "pagerSettings.get": "connections-settings",
  "pagerSettings.update": "connections-settings",
  "pagerSettings.test": "connections-settings",
} as const;

export const AGENT_ROUTE_REFERENCE_EXEMPTIONS: Readonly<
  Record<string, string>
> = {
  "agentReference.list": "Reference bootstrap route.",
  "agentReference.get": "Reference bootstrap route.",
  "agents.readSystemPrompt": "Human UI inspection route.",
  "users.update": "Human record edit.",
  "agents.previewSystemPrompt": "Human UI preview route.",
  "agents.respondInteraction":
    "Harness interaction response, not an office feature call.",
  "agents.openFile": "Human editor transport route.",
  "agents.saveFile": "Human editor transport route.",
  "agents.closeFile": "Human editor transport route.",
  "agents.upload": "Human chat upload transport route.",
  "agents.getFile": "Human chat attachment transport route.",
  "chatFiles.upload": "Human chat upload transport route.",
  "chatFiles.get": "Human chat attachment transport route.",
  "chatFiles.getImage": "Human chat attachment transport route.",
  "apps.mintSignIn": "Browser sign-in redirect for app hostnames.",
  "sessions.logout": "Cookie-session route; agent authorization is not useful.",
  "validate.cwd": "Human form validation route.",
  "validate.env": "Human form validation route.",
  "backends.listModels": "Human agent-settings route.",
  "skills.usageCounts": "Human skills-settings route.",
  "system.backupStatus": "Human settings status route.",
  "system.version": "Human UI bootstrap route.",
  "floors.name": "Human elevator panel name lookup.",
  "storage.usage": "Human settings status route.",
  "usage.read": "Human settings status route.",
  "voice.status": "Human voice-settings status route.",
  "voice.transcribe": "Human composer mic transport route.",
  "voice.speak": "Human read-aloud transport route.",
} as const;

// Prettier pads route tables to align their columns; an agent pays for that
// padding in tokens. The served form drops it and keeps every cell's text.
// A cell ends at an unescaped "|"; a separator row holds only "|", "-", ":"
// and spaces. Lines in a ``` fence stay as they are.
export function compactReferenceTables(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) fenced = !fenced;
      if (fenced || !line.startsWith("|")) return line;
      const separator = /^[|:\- ]*$/.test(line) && line.includes("-");
      const cells = line.split(/(?<!\\)\|/);
      return cells
        .map((cell, i) => {
          if (i === 0 || i === cells.length - 1) return cell;
          const trimmed = cell.replace(/ {2,}$/, " ");
          return separator ? trimmed.replace(/-+/g, "---") : trimmed;
        })
        .join("|");
    })
    .join("\n");
}

const topicNames = Object.keys(AGENT_REFERENCE_TOPICS) as AgentReferenceTopic[];
// The pages live under server/ so every package that ships the server ships
// them, and a missing page fails this module load instead of a request.
const referenceDir = join(import.meta.dir, "agent-reference");
const content = new Map(
  topicNames.map((topic) => [
    topic,
    compactReferenceTables(
      readFileSync(join(referenceDir, `${topic}.md`), "utf8"),
    ),
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

// A schedule run reads the pages an ordinary agent reads: its job prompt can
// point at any of them. App code does not read the reference.
export function agentReferenceTopics(identity: Identity) {
  if (identity.scope === "app") return null;
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
