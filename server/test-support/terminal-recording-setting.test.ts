// The office setting "Record terminals" (task 749cb7fd, slice b): its switch
// on the office settings route, its own audit row on each change, and the
// agent manager reading it at each terminal start. Also the typist of a
// terminal frame: always the member of the socket, never a field of the frame.

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import type { AgentInfo } from "../../shared/types.ts";
import { getUserByName } from "../users.ts";
import { listTerminalRecordings } from "../terminal-recorder.ts";
import { FakeBackend } from "./fake-backend.ts";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function call(
  srv: TestServer,
  method: string,
  path: string,
  session: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    rawSessionId: session,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

interface Settings {
  version: string;
  recordTerminals?: boolean;
}

async function office() {
  server = await startTestServer({
    fakeBackend: new FakeBackend({
      session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
    }),
  });
  const srv = server;
  const morgan = await srv.seedOwner("Morgan");
  const read = async () => {
    const res = await call(
      srv,
      "GET",
      "/api/office/settings",
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);
    return res.body as Settings;
  };
  const put = async (fields: Record<string, unknown>, version?: string) =>
    (
      await call(srv, "PUT", "/api/office/settings", morgan.rawSessionId, {
        version: version ?? (await read()).version,
        ...fields,
      })
    ).status;
  const rows = async (operation: string) => {
    const res = await call(
      srv,
      "GET",
      `/api/audit-log?operation=${operation}`,
      morgan.rawSessionId,
    );
    expect(res.status).toBe(200);
    return (res.body as { items: { actor: { id: string } }[] }).items;
  };
  return {
    srv,
    morgan,
    morganId: getUserByName(morgan.username)!.id,
    read,
    put,
    rows,
  };
}

async function spawnAgent(srv: TestServer): Promise<AgentInfo> {
  const agent = await srv.agentManager.spawn(
    "Recorded",
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
  );
  if (!agent) throw new Error("spawn failed");
  return agent;
}

// A terminal sidecar that never runs: openTerminal only needs the process.
function fakeSidecars() {
  spyOn(Bun, "spawn").mockImplementation(
    () =>
      ({
        stdin: { write: () => 1 },
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: new Promise<number>(() => {}),
        pid: 123,
        kill: () => {},
      }) as unknown as ReturnType<typeof Bun.spawn>,
  );
}

describe("the Record terminals switch", () => {
  it("is off until an owner turns it on, and each change writes one audit row", async () => {
    const o = await office();
    expect((await o.read()).recordTerminals).not.toBe(true);

    expect(await o.put({ recordTerminals: true })).toBe(204);
    expect((await o.read()).recordTerminals).toBe(true);
    // The same value again is no change.
    expect(await o.put({ recordTerminals: true })).toBe(204);
    expect(await o.put({ recordTerminals: false })).toBe(204);
    expect((await o.read()).recordTerminals).toBe(false);

    const on = await o.rows("terminal.recordingOn");
    const off = await o.rows("terminal.recordingOff");
    expect(on.map((row) => row.actor.id)).toEqual([o.morganId]);
    expect(off.map((row) => row.actor.id)).toEqual([o.morganId]);
    // A PUT that leaves the switch out keeps it, and writes no row.
    expect(await o.put({ name: "Renamed" })).toBe(204);
    expect((await o.read()).recordTerminals).toBe(false);
    expect(await o.rows("terminal.recordingOff")).toHaveLength(1);
  });

  it("refuses a value that is not a boolean, and changes nothing", async () => {
    const o = await office();
    for (const value of ["yes", 1, null]) {
      expect(await o.put({ recordTerminals: value }), String(value)).toBe(400);
    }
    expect((await o.read()).recordTerminals).not.toBe(true);
    expect(await o.rows("terminal.recordingOn")).toHaveLength(0);
  });

  it("is part of the settings version: a writer who read before a change gets 409", async () => {
    const o = await office();
    const { version } = await o.read();
    expect(await o.put({ recordTerminals: true }, version)).toBe(204);
    expect(await o.put({ recordTerminals: false }, version)).toBe(409);
    expect((await o.read()).recordTerminals).toBe(true);
  });

  it("is kept across a restart of the server", async () => {
    const o = await office();
    expect(await o.put({ recordTerminals: true })).toBe(204);
    server = await o.srv.restart();
    const res = await call(
      server,
      "GET",
      "/api/office/settings",
      o.morgan.rawSessionId,
    );
    expect(res.status).toBe(200);
    expect((res.body as Settings).recordTerminals).toBe(true);
  });

  it("is read by the agent manager at each terminal start", async () => {
    const o = await office();
    const agent = await spawnAgent(o.srv);
    fakeSidecars();
    const actor = { kind: "member" as const, id: o.morganId, name: "Morgan" };
    const manager = o.srv.agentManager;

    expect(manager.openTerminal(agent.id, actor)).toBe(true);
    manager.closeTerminal(agent.id, actor);
    expect(listTerminalRecordings({ agentId: agent.id })).toHaveLength(0);

    expect(await o.put({ recordTerminals: true })).toBe(204);
    expect(manager.openTerminal(agent.id, actor)).toBe(true);
    manager.closeTerminal(agent.id, actor);
    expect(listTerminalRecordings({ agentId: agent.id })).toHaveLength(1);

    expect(await o.put({ recordTerminals: false })).toBe(204);
    expect(manager.openTerminal(agent.id, actor)).toBe(true);
    manager.closeTerminal(agent.id, actor);
    expect(listTerminalRecordings({ agentId: agent.id })).toHaveLength(1);
  });
});

describe("a terminal frame", () => {
  async function pingPong(sock: TestSocket) {
    const pongs = () =>
      sock.messages.filter((m) => (m as { type?: string }).type === "pong")
        .length;
    const before = pongs();
    sock.send({ type: "ping" });
    const deadline = Date.now() + 2000;
    while (pongs() <= before) {
      if (Date.now() > deadline) throw new Error("no pong");
      await Bun.sleep(5);
    }
  }

  it("is typed and resized by the member of the socket, whatever member the frame names", async () => {
    const o = await office();
    const agent = await spawnAgent(o.srv);
    const other = await o.srv.seedMember("Other");
    const otherId = getUserByName(other.username)!.id;
    const input = spyOn(o.srv.agentManager, "terminalInput");
    const resize = spyOn(o.srv.agentManager, "terminalResize");
    const sock = await o.srv.connectWs(o.morgan.rawSessionId);
    await sock.waitFor("presence_list");
    const forged = {
      actor: { kind: "member", id: otherId, name: "Other" },
      userId: otherId,
    };
    sock.send({
      type: "terminal_input",
      agentId: agent.id,
      data: "ls\r",
      ...forged,
    });
    sock.send({
      type: "terminal_resize",
      agentId: agent.id,
      cols: 90,
      rows: 20,
      ...forged,
    });
    await pingPong(sock);
    sock.close();

    const morgan = { kind: "member" as const, id: o.morganId, name: "Morgan" };
    expect(input.mock.calls).toEqual([[agent.id, "ls\r", morgan]]);
    expect(resize.mock.calls).toEqual([[agent.id, 90, 20, morgan]]);
  });
});
