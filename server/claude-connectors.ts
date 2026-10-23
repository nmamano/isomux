// The claude.ai connectors each Claude sign-in carries (integrations page,
// task 911c9bbb). A connector set up in claude.ai (Gmail, Drive, ...) belongs
// to the claude.ai account, so it reaches every Claude session that runs on
// that sign-in. Isomux cannot ask claude.ai for the list without starting a
// session, so it records what the sessions it already runs report: the SDK's
// init message lists the session's MCP servers at the start of every turn, and
// claude.ai connectors carry source "claudeai". After each turn the server
// also asks the running session for its MCP servers (no model turn), which is
// the complete list, and asks again while one is still "pending".
//
// Keyed by the resolved CLAUDE_CONFIG_DIR, which holds one claude.ai login. In
// memory only (Lead, 2026-10-13): after a restart a sign-in reads as not seen
// until its next Claude turn.

import { resolve } from "node:path";

import {
  knownMcpStatus,
  type McpServerStatus,
} from "../shared/contract-shapes.ts";

export interface InitMcpServer {
  name: string;
  status?: string;
  source?: string;
  // The server's tool count, from a status read only.
  tools?: number;
}

// A status read entry: the status, and the tool count when the server was
// connected and reported its tools.
export interface McpStatusEntry {
  name: string;
  status: McpServerStatus;
  tools?: number;
}

function toolCount(server: InitMcpServer): number | undefined {
  return typeof server.tools === "number" &&
    Number.isInteger(server.tools) &&
    server.tools >= 0
    ? server.tools
    : undefined;
}

export interface ClaudeConnectorRecord {
  names: string[];
  seenAt: number;
}

const CLAUDE_AI_PREFIX = "claude.ai ";

const records = new Map<string, ClaudeConnectorRecord>();
// Each connector's status from the last after-turn status read (A3), per
// directory. Kept apart from the record: an init report replaces the names
// but says only "pending", so it leaves these as they were.
const statusRecords = new Map<string, McpStatusEntry[]>();

function connectorName(server: InitMcpServer): string {
  return server.name.startsWith(CLAUDE_AI_PREFIX)
    ? server.name.slice(CLAUDE_AI_PREFIX.length)
    : server.name;
}
// Bumped by every clear, so a status read that started before a sign-in or
// sign-out cannot put the old account's names back when it lands.
const generations = new Map<string, number>();

export function claudeConnectorGeneration(dir: string): number {
  return generations.get(resolve(dir)) ?? 0;
}

// Only source "claudeai" counts: a server the member configured themselves
// can carry any name, including one that starts with "claude.ai ". The status
// at init is usually "pending" (connectors are still connecting), so it is not
// kept; a connector turned off in claude.ai is not offered to agents.
function claudeAiConnectorNames(servers: InitMcpServer[]): string[] {
  const names = servers
    .filter(
      (server) => server.source === "claudeai" && server.status !== "disabled",
    )
    .map(connectorName)
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function recordClaudeConnectors(
  dir: string,
  servers: InitMcpServer[],
  now = Date.now(),
): void {
  records.set(resolve(dir), {
    names: claudeAiConnectorNames(servers),
    seenAt: now,
  });
}

// Record what a Claude session reports against the sign-in it was LAUNCHED
// with (agent-manager captures the directory and the cloud flag at launch).
// Only a claude.ai login reports claude.ai connectors: a Bedrock or Vertex
// session, or one billed to an API key, would overwrite a real list with an
// empty one.
//
// Two reports feed it. The init message starts every turn, but the connector
// fetch can still be running then (seen 2026-10-13: a first init with no
// claude.ai servers, the next with all five), so an init without any only
// leaves the record as it was. The status read after each turn is complete,
// so it may record a sign-in that really has none.
export function recordClaudeConnectorsFromSession(
  launch: {
    agentType: string;
    launchedClaudeConfigDir?: string;
    launchedClaudeCloud?: boolean;
  },
  report: {
    mcpServers?: InitMcpServer[] | null;
    apiKeySource?: string;
    from: "init" | "status";
    // The directory's generation when the read started (status reads).
    generation?: number;
  },
  now = Date.now(),
): boolean {
  if (launch.agentType !== "claude" || !launch.launchedClaudeConfigDir)
    return false;
  if (
    report.generation !== undefined &&
    report.generation !==
      claudeConnectorGeneration(launch.launchedClaudeConfigDir)
  )
    return false;
  if (launch.launchedClaudeCloud || report.apiKeySource !== "none")
    return false;
  if (!report.mcpServers) return false;
  if (
    report.from === "init" &&
    !report.mcpServers.some((server) => server.source === "claudeai")
  )
    return false;
  recordClaudeConnectors(
    launch.launchedClaudeConfigDir,
    report.mcpServers,
    now,
  );
  if (report.from === "status")
    recordClaudeConnectorStatuses(
      launch.launchedClaudeConfigDir,
      report.mcpServers,
    );
  return true;
}

function recordClaudeConnectorStatuses(
  dir: string,
  servers: InitMcpServer[],
): void {
  const key = resolve(dir);
  const names = new Set(claudeAiConnectorNames(servers));
  const known = new Map(
    (statusRecords.get(key) ?? []).map((entry) => [entry.name, entry]),
  );
  const statuses = new Map<string, McpStatusEntry>();
  for (const server of servers) {
    if (server.source !== "claudeai") continue;
    const name = connectorName(server);
    const status = knownMcpStatus(server.status);
    if (!names.has(name) || !status) continue;
    // Connectors are still connecting for some seconds after a session
    // starts, so a read after a short turn, or from another agent's new
    // session, can say "pending" for one an earlier read saw connect. Such a
    // read keeps the earlier entry, its tool count included.
    const earlier = known.get(name);
    if (status === "pending" && earlier) {
      statuses.set(name, { ...earlier });
      continue;
    }
    const tools = toolCount(server);
    statuses.set(name, {
      name,
      status,
      ...(tools !== undefined ? { tools } : {}),
    });
  }
  statusRecords.set(
    key,
    [...statuses.values()].sort((a, b) => a.name.localeCompare(b.name)),
  );
}

// Empty until a status read; a name with no entry is not read yet.
export function claudeConnectorStatusesFor(dir: string): McpStatusEntry[] {
  return (statusRecords.get(resolve(dir)) ?? []).map((entry) => ({
    ...entry,
  }));
}

export function claudeConnectorsFor(dir: string): ClaudeConnectorRecord | null {
  return records.get(resolve(dir)) ?? null;
}

// A sign-in or sign-out can put a different claude.ai account in the
// directory, so its list is unknown until the next turn.
export function clearClaudeConnectors(dir: string): void {
  const key = resolve(dir);
  records.delete(key);
  statusRecords.delete(key);
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

export function resetClaudeConnectorsForTests(): void {
  records.clear();
  statusRecords.clear();
  generations.clear();
}

// The MCP servers set in Claude itself (integrations A2): user settings, a
// project's .mcp.json, or a local entry in the user settings for one folder.
// Kept per agent, with the folder it ran in and the Claude config directory
// it launched with, from the same init and status reports, whatever the
// sign-in: they do not come from claude.ai. User and local servers live in
// that directory, so they belong to its sign-in; project servers belong to
// the folder. Only the name, the source and the tool count are kept, never a
// URL, a header or an error text.
export type ClaudeEngineServerSource = "user" | "project" | "local";

const ENGINE_SOURCES: readonly string[] = ["user", "project", "local"];

interface EngineServer {
  name: string;
  source: ClaudeEngineServerSource;
  // Null until an after-turn status read (A3).
  status: McpServerStatus | null;
  // From a status read only.
  tools?: number;
}

const engineRecords = new Map<
  string,
  { cwd: string; configDir: string | null; servers: EngineServer[] }
>();

export function recordClaudeEngineServers(
  agentId: string,
  cwd: string,
  servers: InitMcpServer[] | null | undefined,
  from: "init" | "status",
  // The Claude config directory the session launched with, captured with
  // the report (a status read captures it when the read starts).
  configDir?: string | null,
): void {
  if (!servers) return;
  // An init report says "pending" for every server and has no tools: it
  // keeps the status and the tool count of the last status read for a
  // server it still lists. So does a status read that says "pending".
  const before = engineRecords.get(agentId)?.servers ?? [];
  const kept: EngineServer[] = servers
    .filter(
      (server) =>
        typeof server.name === "string" &&
        server.name.length > 0 &&
        ENGINE_SOURCES.includes(server.source ?? ""),
    )
    .map((server) => {
      const source = server.source as ClaudeEngineServerSource;
      const earlier = before.find(
        (entry) => entry.name === server.name && entry.source === source,
      );
      const status = from === "status" ? knownMcpStatus(server.status) : null;
      if ((from === "init" || status === "pending") && earlier?.status)
        return { ...earlier };
      const tools = from === "status" ? toolCount(server) : undefined;
      return {
        name: server.name,
        source,
        status: from === "status" ? status : null,
        ...(tools !== undefined ? { tools } : {}),
      };
    });
  engineRecords.set(agentId, {
    cwd: resolve(cwd),
    configDir: configDir ? resolve(configDir) : null,
    servers: kept,
  });
}

export function forgetClaudeEngineServers(agentId: string): void {
  engineRecords.delete(agentId);
}

export interface ClaudeEngineServerRow {
  engine: "claude";
  name: string;
  source: ClaudeEngineServerSource;
  folder: string | null;
  // The sign-in whose config directory holds a user or local server; null
  // for a directory that is neither current sign-in's (and for project
  // servers, which belong to the folder).
  signIn: "office" | "personal" | null;
  status: McpServerStatus | null;
  tools?: number;
}

// One row per server across the given agents; the folder only for project and
// local servers, which belong to it. `signInOf` maps a launch directory to
// the caller's sign-in that uses it now.
export function claudeEngineServersFor(
  agentIds: string[],
  signInOf: (configDir: string) => "office" | "personal" | null = () => null,
): ClaudeEngineServerRow[] {
  const rows = new Map<string, ClaudeEngineServerRow>();
  for (const agentId of agentIds) {
    const record = engineRecords.get(agentId);
    if (!record) continue;
    for (const server of record.servers) {
      const folder = server.source === "user" ? null : record.cwd;
      const signIn =
        server.source === "project" || record.configDir === null
          ? null
          : signInOf(record.configDir);
      const key = JSON.stringify([server.name, server.source, folder, signIn]);
      // Several agents can report one server: a status read beats none.
      const earlier = rows.get(key);
      const read = server.status !== null ? server : earlier;
      rows.set(key, {
        engine: "claude",
        name: server.name,
        source: server.source,
        folder,
        signIn,
        status: read?.status ?? null,
        ...(read?.tools !== undefined ? { tools: read.tools } : {}),
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.source.localeCompare(b.source) ||
      (a.folder ?? "").localeCompare(b.folder ?? "") ||
      (a.signIn ?? "").localeCompare(b.signIn ?? ""),
  );
}

export function resetClaudeEngineServersForTests(): void {
  engineRecords.clear();
}
