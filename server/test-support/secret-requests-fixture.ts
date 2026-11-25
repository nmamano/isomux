// The secret request core's test office (server/secret-requests.test.ts and
// server/secret-requests-pass-on.test.ts): a real ask store and secret store
// in a temp folder, members, apps and agents as plain maps the tests change.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAskFilePersistence,
  createAskStore,
  type AskChange,
  type AskPersistence,
} from "../asks.ts";
import { createSecretRequests } from "../secret-requests.ts";
import type { SecretScope } from "../secret-store.ts";
import type { LogMessage } from "../../shared/i18n/log-message.ts";
import { createConnectionWrites } from "../connection-writes.ts";
import { createMcpOAuth } from "../mcp-oauth.ts";
import { createMcpServerSources } from "../mcp-servers.ts";
import { serializeManagedUserEnv } from "../user-env.ts";
import type { DiscordConnectResult } from "../discord/supervisor.ts";

export const VALUE = "ghp_FAKErequestFAKErequestFAKErequest012";
export const ASK = {
  name: "GH_TOKEN",
  hosts: ["api.github.com"],
  reason: "To open the pull request.",
};

const roots: string[] = [];
// Each test file calls this in its afterEach: the temp folders setup made.
export function removeSetupRoots(): void {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}

// The asks file, with a switch that makes every write fail.
function asksFile(path: string) {
  const file = createAskFilePersistence(path);
  const control = { failWrites: false };
  const persistence: AskPersistence = {
    ...file,
    save(entries) {
      if (control.failWrites) throw new Error("disk full");
      file.save(entries);
    },
  };
  return { persistence, control };
}

// Members by username, office owners, apps by name, and who cannot reach
// the agents' room. Tests change apps and owners in place.
export const MEMBERS: Record<string, string> = {
  Nil: "u-owner",
  Dana: "u-owner2",
  Alice: "u-alice",
  Bob: "u-bob",
  Carol: "u-carol",
  Eve: "u-eve",
};
// A member removed after the agent asked: the id resolves to no name.
export const GONE = "u-gone";
export type App = { createdAt: number; userId: string | null };
export type Settled = {
  agentId: string;
  requestId: string;
  outcome: "saved" | "declined";
  line: LogMessage;
  answeredBy: string;
};

export function setup(
  agents: Record<string, string | null> = { a1: "u-alice" },
  apps: Record<string, App> = {},
) {
  const owners = new Set(["u-owner", "u-owner2"]);
  const audience = {
    isOfficeOwner: (userId: string) => owners.has(userId),
    agentRoomId: (agentId: string) =>
      Object.hasOwn(agents, agentId) ? "r1" : null,
    canSeeRoom: (userId: string) => userId !== "u-eve",
    roomHidden: () => false,
    roomMemberIds: () => [],
  };
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-requests-"));
  roots.push(root);
  // The MCP servers and the secrets they name share one store, as in the
  // office.
  const sources = createMcpServerSources(root);
  const store = sources.secrets;
  const asksPath = join(root, "asks.json");
  // The managed variables, written through the real name and value check.
  const env: {
    office: Record<string, string>;
    users: Record<string, Record<string, string>>;
  } = { office: {}, users: {} };
  // Each OpenCode push: its scope, and the variable and server names that
  // scope held when it ran.
  const pushes: {
    scope: SecretScope;
    variables: string[];
    servers: string[];
  }[] = [];
  const variablesOf = (scope: SecretScope) =>
    scope.kind === "office" ? env.office : (env.users[scope.userId] ?? {});
  const oauth = createMcpOAuth({
    servers: sources.servers,
    secrets: sources.secrets,
    fetch: () => {
      throw new Error("no network in this test");
    },
    redirectUri: () => "https://office.example.com/api/mcp-oauth/callback",
  });
  const writes = createConnectionWrites({
    setUserVariable: (userId, name, value) => {
      const next = { ...env.users[userId], [name]: value };
      serializeManagedUserEnv(next);
      env.users[userId] = next;
      return { ok: true };
    },
    setOfficeVariable: (name, value) => {
      const next = { ...env.office, [name]: value };
      serializeManagedUserEnv(next);
      env.office = next;
      return { ok: true };
    },
    oauth: () => oauth,
    pushOpenCodeSettings: (scope) =>
      pushes.push({
        scope,
        variables: Object.keys(variablesOf(scope)),
        servers: sources.servers.list(scope).map((s) => s.name),
      }),
  });
  const events: AskChange[] = [];
  const settled: Settled[] = [];
  // The Discord connect (supervisor.connect): each call, and what it answers.
  const discord: {
    calls: [string, string][];
    connect: (userId: string, token: string) => Promise<DiscordConnectResult>;
  } = {
    calls: [],
    connect: () => Promise.reject(new Error("not used")),
  };
  let changes = 0;
  // While set, the proxy push waits on it (holdChanges).
  let gate: Promise<void> | null = null;
  // A store and the requests over it, as one server boot builds them.
  function boot() {
    const { persistence, control } = asksFile(asksPath);
    const asks = createAskStore({
      persistence,
      onChange: (change) => events.push(change),
    });
    const requests = createSecretRequests({
      store,
      asks,
      audience,
      onChanged: async () => {
        changes++;
        if (gate) await gate;
      },
      agentUserId: (agentId) =>
        Object.hasOwn(agents, agentId) ? agents[agentId] : undefined,
      appFor: (name) =>
        Object.hasOwn(apps, name) ? { name, ...apps[name] } : null,
      memberByName: (name) => {
        const found = Object.keys(MEMBERS).find(
          (m) => m.toLowerCase() === name.toLowerCase(),
        );
        return found ? { id: MEMBERS[found], name: found } : null;
      },
      memberName: (userId) =>
        Object.keys(MEMBERS).find((m) => MEMBERS[m] === userId) ?? null,
      writes,
      variableExists: (scope, name) => Object.hasOwn(variablesOf(scope), name),
      connectDiscordBot: (userId, token) => {
        discord.calls.push([userId, token]);
        return discord.connect(userId, token);
      },
      mcpServerExists: (scope, name) =>
        sources.servers.list(scope).some((s) => s.name === name),
      settled: (agentId, requestId, outcome, line, answeredBy) =>
        settled.push({ agentId, requestId, outcome, line, answeredBy }),
    });
    return { asks, requests, control };
  }
  const first = boot();
  return {
    ...first,
    store,
    servers: sources.servers,
    env,
    pushes,
    asksPath,
    owners,
    audience,
    events,
    settled,
    discord,
    boot,
    changes: () => changes,
    // Hold the next proxy push until the returned function runs.
    holdChanges: () => {
      let release = () => {};
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

export function opened(
  result: ReturnType<ReturnType<typeof setup>["requests"]["open"]>,
) {
  if (!result.ok) throw new Error(`open refused: ${result.code}`);
  return result.requestId;
}

export const code = (result: { ok: boolean; code?: string }) =>
  result.ok ? "ok" : result.code;
export const failure = (result: {
  ok: boolean;
  status?: number;
  code?: string;
}) => (result.ok ? "ok" : `${result.status} ${result.code}`);
// Each outcome without its line: [agent, request, outcome, answered by].
export const outcomes = (t: { settled: Settled[] }) =>
  t.settled.map((s) => [s.agentId, s.requestId, s.outcome, s.answeredBy]);
