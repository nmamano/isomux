// The system entries the agent-write routes put in a log read in the OWNER's
// language (internal-docs/i18n-loop.md, S8 sweep; PM ruling 2026-09-06). Three
// surface families reach a log through addLogEntry without going near a slash
// command: the editor-open request, the read-file request, and the diff
// request. Each is proved twice - a Spanish owner gets Spanish, and an owner
// who never chose a language gets the English bytes the office always showed.
//
// Both cases are about the LOG OWNER's stored preference, and neither is
// evidence about the CALLER's identity: the resolver never reads it, and the
// route hands these functions nothing but the agent id
// (server/routes/handlers/agent-affordances.ts:95, :106, :116). The agent-
// English rule is proved by S7's resolver tests, not here (PM ruling,
// 2026-09-06).
//
// Oracles are literal translated strings, never text read back through the
// translator (ruling 14).

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
  username: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    roomId,
    undefined,
    undefined,
    undefined,
    username,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

/** Put a seeded user on a language, or leave them on none. */
function setLanguage(username: string, language: "es" | "ca" | null): void {
  const user = getUserByName(username);
  if (!user) throw new Error(`no user record for ${username}`);
  const r = updateUserById(user.id, { language });
  if (!r.ok) throw new Error(`could not set language: ${r.error}`);
}

function systemEntries(srv: TestServer, agentId: string): string[] {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e: LogEntry) => e.kind === "system")
    .map((e: LogEntry) => e.content);
}

/**
 * One agent per language case. Asserts the ENABLING CONDITION - the owner's
 * stored preference - so a resolver that stopped reading it could not pass by
 * accident.
 */
async function agentOwnedBy(
  srv: TestServer,
  who: "spanish" | "neverChose",
): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  if (who === "spanish") {
    const owner = await srv.seedOwner("Jefa");
    setLanguage(owner.username, "es");
    expect(getUserByName(owner.username)?.language).toBe("es");
    return spawnAgent(srv, "ES", room.id, owner.username);
  }
  const member = await srv.seedMember("Sam");
  expect(getUserByName(member.username)?.language).toBeNull();
  return spawnAgent(srv, "EN", room.id, member.username);
}

const MISSING = "/nonexistent-s8/definitely/not/here.txt";

describe("the editor-open request writes in the owner's language", () => {
  it("tells a Spanish owner the path does not exist, in Spanish", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "spanish");
    expect(server.agentManager.emitAgentEditRequest(agent.id, MISSING)).toEqual(
      { ok: true },
    );
    expect(systemEntries(server, agent.id)).toContain(
      `\`${MISSING}\` no existe.`,
    );
  });

  it("keeps the English bytes for an owner who never chose", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "neverChose");
    expect(server.agentManager.emitAgentEditRequest(agent.id, MISSING)).toEqual(
      { ok: true },
    );
    expect(systemEntries(server, agent.id)).toContain(
      `\`${MISSING}\` does not exist.`,
    );
  });
});

describe("the read-file request writes in the owner's language", () => {
  it("tells a Spanish owner the path does not exist, in Spanish", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "spanish");
    expect(server.agentManager.emitAgentReadFile(agent.id, MISSING)).toEqual({
      ok: true,
    });
    expect(systemEntries(server, agent.id)).toContain(
      `\`${MISSING}\` no existe.`,
    );
  });

  it("keeps the English bytes for an owner who never chose", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "neverChose");
    expect(server.agentManager.emitAgentReadFile(agent.id, MISSING)).toEqual({
      ok: true,
    });
    expect(systemEntries(server, agent.id)).toContain(
      `\`${MISSING}\` does not exist.`,
    );
  });
});

describe("the diff request writes in the owner's language", () => {
  // A fresh temp directory: it exists, so resolveDiffCwd accepts it, and it is
  // outside any working tree, so the diff lands on its not_repo branch.
  const notARepo = () => mkdtempSync(join(tmpdir(), "s8-not-a-repo-"));

  it("tells a Spanish owner it is not a git repository, in Spanish", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "spanish");
    const dir = notARepo();
    expect(server.agentManager.emitAgentDiff(agent.id, dir)).toEqual({
      ok: true,
    });
    expect(systemEntries(server, agent.id)).toContain(
      `\`${dir}\` no es un repositorio de git.`,
    );
  });

  it("keeps the English bytes for an owner who never chose", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBy(server, "neverChose");
    const dir = notARepo();
    expect(server.agentManager.emitAgentDiff(agent.id, dir)).toEqual({
      ok: true,
    });
    expect(systemEntries(server, agent.id)).toContain(
      `\`${dir}\` is not a git repository.`,
    );
  });
});
