// The system entries the agent-write routes put in a log are stored in
// English and carry a message each reader words in their own language (task
// c37a7365; before it, they were written in the OWNER's language, S8). Three
// surface families reach a log through addLogEntry without going near a slash
// command: the editor-open request, the read-file request, and the diff
// request. Each is proved with a Spanish owner, the case where the old
// writer put Spanish into a log an English reader also reads.

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName, updateUserById } from "../users.ts";
import type { AgentInfo, LogEntry } from "../../shared/types.ts";
import { expectWorded } from "./worded.ts";

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

function lastSystemEntry(
  srv: TestServer,
  agentId: string,
): LogEntry | undefined {
  return srv.agentManager
    .getAgentLogs(agentId)
    .filter((e: LogEntry) => e.kind === "system")
    .at(-1);
}

/**
 * An agent whose owner reads Spanish. Asserts the ENABLING CONDITION - the
 * owner's stored preference - so an owner-language writer would put Spanish
 * in `content` and fail, rather than pass by accident.
 */
async function agentOwnedBySpanishReader(srv: TestServer): Promise<AgentInfo> {
  const room = srv.agentManager.getRooms()[0];
  const owner = await srv.seedOwner("Jefa");
  setLanguage(owner.username, "es");
  expect(getUserByName(owner.username)?.language).toBe("es");
  return spawnAgent(srv, "ES", room.id, owner.username);
}

const MISSING = "/nonexistent-s8/definitely/not/here.txt";

describe("the editor-open request", () => {
  it("stores English and words the missing path for each reader", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBySpanishReader(server);
    expect(server.agentManager.emitAgentEditRequest(agent.id, MISSING)).toEqual(
      { ok: true },
    );
    expectWorded(
      lastSystemEntry(server, agent.id),
      "systemEntries.pathRefusal.notFound",
      { path: MISSING },
    );
  });
});

describe("the read-file request", () => {
  it("stores English and words the missing path for each reader", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBySpanishReader(server);
    expect(server.agentManager.emitAgentReadFile(agent.id, MISSING)).toEqual({
      ok: true,
    });
    expectWorded(
      lastSystemEntry(server, agent.id),
      "systemEntries.pathRefusal.notFound",
      { path: MISSING },
    );
  });
});

describe("the diff request", () => {
  // A fresh temp directory: it exists, so resolveDiffCwd accepts it, and it is
  // outside any working tree, so the diff lands on its not_repo branch.
  const notARepo = () => mkdtempSync(join(tmpdir(), "s8-not-a-repo-"));

  it("stores English and words the not-a-repository line for each reader", async () => {
    server = await startTestServer();
    const agent = await agentOwnedBySpanishReader(server);
    const dir = notARepo();
    expect(await server.agentManager.emitAgentDiff(agent.id, dir)).toEqual({
      ok: true,
    });
    expectWorded(
      lastSystemEntry(server, agent.id),
      "systemEntries.diffNotRepo",
      {
        path: dir,
      },
    );
  });
});
