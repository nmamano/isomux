// Background work an idle agent's session still runs (task daa9dbef): the
// backend's background_tasks event replaces AgentInfo.backgroundTasks and
// reaches the browser, but it is never turn activity. It moves no state and
// writes no log entry. A release past the background hold ends the work and
// clears the list. The office stamps each task with the time it first saw it,
// and GET /agents shows the kind and that time, never the label (task
// e7fd8ddf). agents.json keeps the list, so it is written when the set of
// tasks changes, and only then.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import type {
  AgentInfo,
  BackgroundTask,
  ReportedBackgroundTask,
} from "../../shared/types.ts";

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

const TASKS: ReportedBackgroundTask[] = [
  { id: "b1", kind: "command", label: "npm run dev" },
  { id: "a1", kind: "agent", label: "Review the diff" },
];
// The reported fields of a list, without the office's stamp.
const reported = (list: BackgroundTask[] | null | undefined) =>
  list?.map(({ id, kind, label }) => ({ id, kind, label })) ?? null;

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
      srv.workDir,
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
    const writtenAt = () => statSync(agentsFile).mtimeMs;
    let lastWrite = writtenAt();
    const logCount = srv.agentManager.getAgentLogs(id).length;
    // Older than the idle limit below, and past the file clock's resolution.
    await sleep(80);

    const before = Date.now();
    session.push({ kind: "background_tasks", tasks: TASKS });
    await waitUntil(() => updates().length === 1, "list sent");
    const after = Date.now();
    expect(reported(updates()[0].changes.backgroundTasks)).toEqual(TASKS);
    const first = agent().backgroundTasks!;
    expect(reported(first)).toEqual(TASKS);
    for (const t of first) {
      expect(t.startedAt).toBeGreaterThanOrEqual(before);
      expect(t.startedAt).toBeLessThanOrEqual(after);
    }
    expect(agent().state).toBe("waiting_for_response");
    // A new set of tasks is written; the next boot reads it.
    expect(writtenAt()).toBeGreaterThan(lastWrite);
    lastWrite = writtenAt();

    // GET /agents shows each task's kind and start, never its label or id.
    const listed = async () => {
      const res = await srv.http("/agents", {
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(200);
      const entries = (await res.json()) as {
        id: string;
        backgroundTasks?: unknown;
      }[];
      return entries.find((e) => e.id === id)?.backgroundTasks;
    };
    expect(await listed()).toEqual(
      first.map((t) => ({ kind: t.kind, startedAt: t.startedAt })),
    );
    // The on-disk summary is a snapshot: it does not carry live work.
    const summary = JSON.parse(
      readFileSync(join(srv.stateRoot, "agents-summary.json"), "utf-8"),
    ) as { id: string }[];
    const summaryEntry = summary.find((e) => e.id === id);
    expect(summaryEntry).toBeDefined();
    expect(summaryEntry).not.toHaveProperty("backgroundTasks");

    // The same list again sends nothing and writes nothing; neither does a
    // new label for the same tasks.
    await sleep(80);
    session.push({ kind: "background_tasks", tasks: TASKS });
    session.push({
      kind: "background_tasks",
      tasks: [TASKS[0], { ...TASKS[1], label: "Review the diff again" }],
    });
    await waitUntil(
      () => agent().backgroundTasks?.[1]?.label === "Review the diff again",
      "label change applied",
    );
    expect(agent().backgroundTasks!.map((t) => t.startedAt)).toEqual(
      first.map((t) => t.startedAt),
    );
    // One update: the label change. The repeat sent nothing.
    expect(updates()).toHaveLength(2);
    expect(writtenAt()).toBe(lastWrite);

    // A task that stays keeps its start; a new one gets its own.
    await sleep(80);
    const later = Date.now();
    session.push({
      kind: "background_tasks",
      tasks: [TASKS[0], { id: "w1", kind: "workflow", label: "Ship" }],
    });
    await waitUntil(() => updates().length >= 3, "replaced");
    const [kept, added] = agent().backgroundTasks!;
    expect(kept.id).toBe("b1");
    expect(kept.startedAt).toBe(first[0].startedAt);
    expect(added.id).toBe("w1");
    expect(added.startedAt).toBeGreaterThanOrEqual(later);
    expect(writtenAt()).toBeGreaterThan(lastWrite);

    // An empty list clears with an explicit null, which survives JSON.
    session.push({ kind: "background_tasks", tasks: [] });
    await waitUntil(() => updates().length >= 4, "list cleared");
    expect(updates()).toHaveLength(4);
    expect(updates()[3].changes.backgroundTasks).toBeNull();
    expect(agent().backgroundTasks ?? null).toBeNull();
    expect(await listed()).toBeNull();
    expect(agent().state).toBe("waiting_for_response");
    expect(srv.agentManager.getAgentLogs(id)).toHaveLength(logCount);

    // A release past the background hold takes the session, and its end
    // clears the list.
    session.push({ kind: "background_tasks", tasks: TASKS });
    await waitUntil(() => updates().length >= 5, "list sent again");
    expect(await srv.agentManager.sweepIdleAgents(50, 0)).toBe(1);
    await waitUntil(() => updates().length >= 6, "release cleared");
    expect(updates()).toHaveLength(6);
    expect(updates()[5].changes.backgroundTasks).toBeNull();
    expect(agent().backgroundTasks ?? null).toBeNull();
    sock.close();
  });
});
