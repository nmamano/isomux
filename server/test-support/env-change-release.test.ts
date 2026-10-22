// A Variables save releases the running processes of the agents it reaches,
// as a Secrets change does (agent-secrets-restart.di.test.ts covers the
// release itself: reach, turn end, the wake note). These cases drive the
// save routes, so they cover which saves call it and with which scope.

import { afterEach, describe, expect, it } from "bun:test";

import { startTestServer, type TestServer } from "./harness.ts";
import { getUserByName } from "../users.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(5);
  }
}

async function save(
  srv: TestServer,
  path: string,
  session: string,
  body: unknown,
  method = "PUT",
): Promise<number> {
  const response = await srv.http(path, {
    method,
    headers: { "Content-Type": "application/json" },
    rawSessionId: session,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

function live(srv: TestServer, id: string): boolean {
  const agent = srv.agentManager.getAgent(id);
  return (
    srv.agentManager.getCurrentSessionId(id) !== null &&
    agent?.dormant !== true &&
    (agent?.state === "idle" || agent?.state === "waiting_for_response")
  );
}

function released(srv: TestServer, id: string): boolean {
  return srv.agentManager.getAgent(id)?.dormant === true;
}

function send(srv: TestServer, id: string, text: string): void {
  const result = srv.agentManager.enqueueMessage(id, {
    sender: { kind: "user", username: "tester" },
    text,
  });
  if (!result.ok) throw new Error("enqueue failed");
}

async function spawnLive(
  srv: TestServer,
  name: string,
  userId: string,
): Promise<string> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    undefined,
    "claude",
    undefined,
    userId,
  );
  if (!info) throw new Error("spawn failed");
  await wake(srv, info.id);
  return info.id;
}

async function wake(srv: TestServer, id: string): Promise<void> {
  send(srv, id, "wake");
  await waitUntil(() => live(srv, id), "agent live");
}

async function office() {
  server = await startTestServer();
  const fake = server.fakeBackend;
  const morgan = await server.seedOwner("Morgan");
  const alice = await server.seedMember("Alice");
  const morganId = getUserByName(morgan.username)!.id;
  const aliceId = getUserByName(alice.username)!.id;
  return { srv: server, fake, morgan, alice, morganId, aliceId };
}

describe("a Variables save releases the agents it reaches", () => {
  it("a member's save releases that member's idle agent, which resumes with the new variables; another member's agent keeps its process", async () => {
    const { srv, fake, alice, morganId, aliceId } = await office();
    const aliceEnv = `/api/users/${encodeURIComponent(alice.username)}/env`;
    expect(
      await save(srv, aliceEnv, alice.rawSessionId, {
        values: { RELEASE_PROBE: "old" },
      }),
    ).toBe(204);
    const aliceAgent = await spawnLive(srv, "AliceAgent", aliceId);
    const morganAgent = await spawnLive(srv, "MorganAgent", morganId);
    const before = fake.sessionForAgent(aliceAgent)!;
    const morganSession = fake.sessionForAgent(morganAgent)!;
    const sessionId = srv.agentManager.getCurrentSessionId(aliceAgent);
    expect(before.opts.env?.RELEASE_PROBE).toBe("old");

    // A rename, as Nil's ANTHROPIC_API_KEY -> ANTHROPIC_API_KEY_OUT.
    expect(
      await save(srv, aliceEnv, alice.rawSessionId, {
        values: { RELEASE_PROBE_OUT: "old" },
      }),
    ).toBe(204);
    expect(released(srv, aliceAgent)).toBe(true);
    expect(released(srv, morganAgent)).toBe(false);
    expect(fake.sessionForAgent(morganAgent)).toBe(morganSession);

    await wake(srv, aliceAgent);
    const after = fake.sessionForAgent(aliceAgent)!;
    expect(after).not.toBe(before);
    expect(after.isResume).toBe(true);
    expect(srv.agentManager.getCurrentSessionId(aliceAgent)).toBe(sessionId);
    expect(after.opts.env?.RELEASE_PROBE).toBeUndefined();
    expect(after.opts.env?.RELEASE_PROBE_OUT).toBe("old");
  });

  it("an office save releases every member's agent", async () => {
    const { srv, morgan, morganId, aliceId } = await office();
    const aliceAgent = await spawnLive(srv, "AliceAgent", aliceId);
    const morganAgent = await spawnLive(srv, "MorganAgent", morganId);

    expect(
      await save(srv, "/api/office/env", morgan.rawSessionId, {
        values: { OFFICE_PROBE: "1" },
      }),
    ).toBe(204);
    expect(released(srv, aliceAgent)).toBe(true);
    expect(released(srv, morganAgent)).toBe(true);
  });

  it("the one-variable routes release too: an owner's set for a member, and an office removal", async () => {
    const { srv, fake, morgan, alice, morganId, aliceId } = await office();
    const aliceAgent = await spawnLive(srv, "AliceAgent", aliceId);
    const morganAgent = await spawnLive(srv, "MorganAgent", morganId);

    expect(
      await save(
        srv,
        `/api/users/${encodeURIComponent(alice.username)}/env/ONE_PROBE`,
        morgan.rawSessionId,
        { value: "set-by-owner" },
      ),
    ).toBe(204);
    expect(released(srv, aliceAgent)).toBe(true);
    expect(released(srv, morganAgent)).toBe(false);
    await wake(srv, aliceAgent);
    expect(fake.sessionForAgent(aliceAgent)!.opts.env?.ONE_PROBE).toBe(
      "set-by-owner",
    );

    expect(
      await save(srv, "/api/office/env/OFFICE_ONE", morgan.rawSessionId, {
        value: "x",
      }),
    ).toBe(204);
    for (const id of [aliceAgent, morganAgent]) {
      expect(released(srv, id)).toBe(true);
      await wake(srv, id);
    }
    expect(
      await save(
        srv,
        "/api/office/env/OFFICE_ONE",
        morgan.rawSessionId,
        undefined,
        "DELETE",
      ),
    ).toBe(204);
    expect(released(srv, aliceAgent)).toBe(true);
    expect(released(srv, morganAgent)).toBe(true);
  });

  it("a save that changes only notes, or no value at all, releases nothing", async () => {
    const { srv, fake, morgan, alice, morganId, aliceId } = await office();
    const aliceEnv = `/api/users/${encodeURIComponent(alice.username)}/env`;
    const values = { KEEP_PROBE: "same" };
    expect(await save(srv, aliceEnv, alice.rawSessionId, { values })).toBe(204);
    expect(
      await save(srv, "/api/office/env", morgan.rawSessionId, { values }),
    ).toBe(204);
    const aliceAgent = await spawnLive(srv, "AliceAgent", aliceId);
    const morganAgent = await spawnLive(srv, "MorganAgent", morganId);
    const sessions = fake.sessions.length;

    const quiet: Array<[string, string, unknown, string?]> = [
      // Notes only, whole map.
      [aliceEnv, alice.rawSessionId, { values, notes: { KEEP_PROBE: "n" } }],
      [
        "/api/office/env",
        morgan.rawSessionId,
        { values, notes: { KEEP_PROBE: "n" } },
      ],
      // The same values again.
      [aliceEnv, alice.rawSessionId, { values }],
      ["/api/office/env", morgan.rawSessionId, { values }],
      // One variable set to the value it has, with a new note.
      [
        `${aliceEnv}/KEEP_PROBE`,
        alice.rawSessionId,
        { value: "same", note: "m" },
      ],
      [
        "/api/office/env/KEEP_PROBE",
        morgan.rawSessionId,
        { value: "same", note: "m" },
      ],
    ];
    for (const [path, session, body] of quiet) {
      expect(await save(srv, path, session, body)).toBe(204);
      expect([released(srv, aliceAgent), released(srv, morganAgent)]).toEqual([
        false,
        false,
      ]);
    }
    expect(fake.sessions.length).toBe(sessions);

    // The control: a value change through the same route, on the same
    // agents, is seen as a release.
    expect(
      await save(srv, aliceEnv, alice.rawSessionId, {
        values: { KEEP_PROBE: "changed" },
      }),
    ).toBe(204);
    expect(released(srv, aliceAgent)).toBe(true);
  });
});
