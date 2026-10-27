// Background work an idle agent's session still runs (task daa9dbef): the
// backend's background_tasks event replaces AgentInfo.backgroundTasks and
// reaches the browser, but it is never turn activity. It moves no state, writes
// no log entry and no agents.json, and does not keep the session from its idle
// release, which ends the work and clears the list.

import { afterEach, describe, expect, it } from "bun:test";
import { statSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import type { AgentInfo, BackgroundTask } from "../../shared/types.ts";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const TASKS: BackgroundTask[] = [
  { id: "b1", kind: "command", label: "npm run dev" },
  { id: "a1", kind: "agent", label: "Review the diff" },
];

describe("background work", () => {
  it("sets and clears the agent's list over the wire without turn activity, and the idle release clears it", async () => {
    const srv = (server = await startTestServer({
      fakeBackend: new FakeBackend({
        session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
      }),
    }));
    const owner = await srv.seedOwner("Morgan");
    const spawned = await srv.agentManager.spawn(
      "Worker",
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      srv.agentManager.getOrdinaryRooms()[0].id,
    );
    if (!spawned) throw new Error("spawn returned null");
    const id = spawned.id;
    const agent = () => srv.agentManager.getAgent(id) as AgentInfo;
    await srv.agentManager.sendMessage(id, "hello", "Morgan");
    await waitUntil(
      () =>
        agent().state === "waiting_for_response" &&
        srv.agentManager.getAgentLogs(id).some((e) => e.kind === "text"),
      "turn done",
    );
    const session = srv.fakeBackend.sessionForAgent(id)!;
    const sock = await srv.connectWs(owner.rawSessionId);
    await sock.waitFor("presence_list");
    const updates = () =>
      sock.messages.filter(
        (m) =>
          (m as { type?: string }).type === "agent_updated" &&
          (m as { agentId?: string }).agentId === id &&
          "backgroundTasks" in ((m as { changes?: object }).changes ?? {}),
      ) as { changes: { backgroundTasks: BackgroundTask[] | null } }[];

    const agentsFile = join(srv.stateRoot, "agents.json");
    const writtenAt = statSync(agentsFile).mtimeMs;
    const logCount = srv.agentManager.getAgentLogs(id).length;
    // Older than the idle limit below, and past the file clock's resolution.
    await sleep(80);

    session.push({ kind: "background_tasks", tasks: TASKS });
    await waitUntil(() => updates().length === 1, "list sent");
    expect(updates()[0].changes.backgroundTasks).toEqual(TASKS);
    expect(agent().backgroundTasks).toEqual(TASKS);
    expect(agent().state).toBe("waiting_for_response");

    // The same list again sends nothing; an empty one clears with an explicit
    // null, which survives JSON.
    session.push({ kind: "background_tasks", tasks: TASKS });
    session.push({ kind: "background_tasks", tasks: [] });
    await waitUntil(() => updates().length >= 2, "list cleared");
    expect(updates().map((u) => u.changes.backgroundTasks)).toEqual([
      TASKS,
      null,
    ]);
    expect(agent().backgroundTasks ?? null).toBeNull();
    expect(agent().state).toBe("waiting_for_response");
    expect(srv.agentManager.getAgentLogs(id)).toHaveLength(logCount);
    expect(statSync(agentsFile).mtimeMs).toBe(writtenAt);

    // Background work is not activity: the idle release still takes the
    // session, and its end clears the list.
    session.push({ kind: "background_tasks", tasks: TASKS });
    await waitUntil(() => updates().length === 3, "list sent again");
    expect(await srv.agentManager.sweepIdleAgents(50)).toBe(1);
    await waitUntil(() => updates().length === 4, "release cleared");
    expect(updates()[3].changes.backgroundTasks).toBeNull();
    expect(agent().backgroundTasks ?? null).toBeNull();
    sock.close();
  });
});
