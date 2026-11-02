// Member permission packs on the office socket (task 134b8f77, part 3),
// through the real HTTP and WS server. A member with a pack gets live pushes,
// the connect snapshot and the connect replay only for the pack's areas, also
// with access to every room (the fast paths of a full member). A pack change,
// compared by value, closes the member's sockets with close code 4003 so the
// page reloads and the fresh connect gets the filtered snapshot. The table
// itself is server/ws-push-area.test.ts.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { FakeBackend } from "./fake-backend.ts";
import { getUserByName } from "../users.ts";
import type { MemberPack } from "../../shared/pack-fit.ts";
import type { AgentInfo } from "../../shared/types.ts";

// The close code of an access change (a protocol value).
const ACCESS_CHANGED = 4003;

let server: TestServer | null = null;
const sockets: TestSocket[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await server?.stop();
  server = null;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "member-pack-ws-"));
  folders.push(dir);
  return dir;
}

// Morgan owns the office; Casey and Drew are members of its only room, so
// both reach every room. Casey gets the packs, Drew stays a full member.
async function office() {
  const fakeBackend = new FakeBackend({
    storedSessionState: "durable",
    session: { onSend: (_t, _a, s) => s.completeTurn({ text: "ok" }) },
  });
  const srv = await startTestServer({ fakeBackend });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const casey = await srv.seedMember("Casey");
  const drew = await srv.seedMember("Drew");
  const o = {
    srv,
    owner: owner.rawSessionId,
    ownerName: owner.username,
    ownerId: getUserByName(owner.username)!.id,
    casey: casey.rawSessionId,
    caseyName: casey.username,
    drew: drew.rawSessionId,
    drewName: drew.username,
    room: srv.agentManager.getRooms()[0].id,
  };
  for (const name of [o.caseyName, o.drewName])
    expect(
      (
        await asOwner(o, "PUT", `/api/users/${name}/access`, {
          allowedRooms: [o.room],
        })
      ).status,
    ).toBe(200);
  expect(srv.agentManager.getRooms()).toHaveLength(1);
  return o;
}
type Office = Awaited<ReturnType<typeof office>>;

async function asOwner(
  o: { srv: TestServer; owner: string },
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await o.srv.http(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    rawSessionId: o.owner,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function packCasey(o: Office, pack: MemberPack | null): Promise<void> {
  const res = await asOwner(o, "PUT", `/api/users/${o.caseyName}/access`, {
    allowedRooms: [o.room],
    pack,
  });
  expect(res.status).toBe(200);
}

interface Socket {
  sock: TestSocket;
  closeCode: () => number | undefined;
  closed: Promise<number>;
}

// A socket whose connect snapshot and replay have arrived.
async function connect(o: Office, session: string): Promise<Socket> {
  const sock = await o.srv.connectWs(session);
  sockets.push(sock);
  let code: number | undefined;
  const closed = new Promise<number>((resolve) =>
    sock.raw.addEventListener("close", (e) => {
      code = (e as CloseEvent).code;
      resolve(code);
    }),
  );
  await sock.waitFor("log_replay_complete");
  return { sock, closeCode: () => code, closed };
}

const frames = (s: Socket) => s.sock.messages as Record<string, unknown>[];
const ofType = (s: Socket, type: string) =>
  frames(s).filter((m) => m.type === type);
const carries = (s: Socket, text: string) =>
  frames(s).some((m) => JSON.stringify(m).includes(text));

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out: ${label}`)),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function spawn(o: Office, name: string): Promise<AgentInfo> {
  const agent = await o.srv.agentManager.spawn(
    name,
    freshFolder(),
    "default",
    undefined,
    undefined,
    o.room,
    undefined,
    undefined,
    undefined,
    o.ownerName,
    "claude",
    undefined,
    o.ownerId,
  );
  if (!agent) throw new Error(`spawn failed: ${name}`);
  return agent;
}

async function waitUntil(pred: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The owner talks to an agent; its transcript gets the text.
async function talkTo(o: Office, agent: AgentInfo, text: string) {
  expect(
    (
      await asOwner(o, "POST", `/api/agents/${agent.id}/messages`, {
        text,
      })
    ).status,
  ).toBe(200);
  await waitUntil(
    () =>
      o.srv.agentManager
        .getAgentLogs(agent.id)
        .some((e) => JSON.stringify(e).includes(text)),
    `${agent.name}'s log has "${text}"`,
  );
}

// A push Casey gets with the agents area, after the pushes under test: the
// socket's frames arrive in order, so once it is here the others were sent.
async function barrier(o: Office, agent: AgentInfo, s: Socket, name: string) {
  expect(
    (await asOwner(o, "PATCH", `/api/agents/${agent.id}`, { name })).status,
  ).toBe(200);
  await withTimeout(
    (async () => {
      while (
        !ofType(s, "agent_updated").some((m) =>
          JSON.stringify(m).includes(name),
        )
      )
        await Bun.sleep(10);
    })(),
    `agent_updated with ${name}`,
  );
}

describe("a member with a pack and every room on the office socket", () => {
  it("gets live pushes only for the pack's areas", async () => {
    const o = await office();
    const agent = await spawn(o, "Worker");
    await packCasey(o, { areas: { agents: "read" }, agentCeiling: "chat" });
    const casey = await connect(o, o.casey);
    const drew = await connect(o, o.drew);
    casey.sock.messages.splice(0);
    drew.sock.messages.splice(0);

    expect(
      (await asOwner(o, "POST", "/api/tasks", { title: "Secret task title" }))
        .status,
    ).toBe(201);
    await talkTo(o, agent, "live log line");
    await barrier(o, agent, casey, "Renamed once");
    await barrier(o, agent, drew, "Renamed once more");

    // The enabling condition: a full member got both.
    expect(ofType(drew, "task_upserted").length).toBeGreaterThan(0);
    expect(ofType(drew, "log_entry").length).toBeGreaterThan(0);
    expect({
      taskPushes: ofType(casey, "task_upserted").length,
      logPushes: ofType(casey, "log_entry").length,
      taskTitle: carries(casey, "Secret task title"),
      logText: carries(casey, "live log line"),
    }).toEqual({
      taskPushes: 0,
      logPushes: 0,
      taskTitle: false,
      logText: false,
    });
  });

  it("gets the connect snapshot and replay only for the pack's areas", async () => {
    const o = await office();
    const agent = await spawn(o, "Worker");
    await talkTo(o, agent, "logged line");
    const gone = await spawn(o, "Gone");
    expect(
      (await asOwner(o, "DELETE", `/api/agents/${gone.id}`)).status,
    ).toBeLessThan(300);
    expect(
      (await asOwner(o, "POST", "/api/tasks", { title: "Secret task title" }))
        .status,
    ).toBe(201);
    const snapshot = (s: Socket) => {
      const state = ofType(s, "full_state").at(-1) as
        | { agents?: { id: string }[]; killedAgents?: { id: string }[] }
        | undefined;
      return {
        agents: (state?.agents ?? []).some((a) => a.id === agent.id),
        killed: (state?.killedAgents ?? []).some((a) => a.id === gone.id),
        logs: ofType(s, "log_entry").length > 0,
        logText: carries(s, "logged line"),
        taskTitle: carries(s, "Secret task title"),
      };
    };

    await packCasey(o, { areas: { tasks: "read" }, agentCeiling: "chat" });
    const first = await connect(o, o.casey);
    expect(ofType(first, "full_state").length).toBeGreaterThan(0);
    expect(snapshot(first)).toEqual({
      agents: false,
      killed: false,
      logs: false,
      logText: false,
      taskTitle: true,
    });

    await packCasey(o, {
      areas: { agents: "read", agentManagement: "read", logs: "read" },
      agentCeiling: "chat",
    });
    await withTimeout(first.closed, "the pack change closed the socket");
    const second = await connect(o, o.casey);
    expect(snapshot(second)).toEqual({
      agents: true,
      killed: true,
      logs: true,
      logText: true,
      taskTitle: false,
    });
  });

  it("a pack change, by value, closes the member's sockets with the access-changed code", async () => {
    const o = await office();
    const drew = await connect(o, o.drew);
    let casey = await connect(o, o.casey);

    // A first pack on a full member.
    await packCasey(o, {
      areas: { agents: "read", tasks: "read" },
      agentCeiling: "chat",
    });
    expect(await withTimeout(casey.closed, "the first pack")).toBe(
      ACCESS_CHANGED,
    );

    // The same pack, its areas in another order: no change, no close.
    casey = await connect(o, o.casey);
    await packCasey(o, {
      areas: { tasks: "read", agents: "read" },
      agentCeiling: "chat",
    });
    await Bun.sleep(100);
    casey.sock.send({ type: "ping" });
    await casey.sock.waitFor("pong");
    expect(casey.closeCode()).toBeUndefined();

    // A ceiling change is a change.
    await packCasey(o, {
      areas: { tasks: "read", agents: "read" },
      agentCeiling: "office",
    });
    expect(await withTimeout(casey.closed, "the ceiling change")).toBe(
      ACCESS_CHANGED,
    );

    // Clearing the pack is a change.
    casey = await connect(o, o.casey);
    await packCasey(o, null);
    expect(await withTimeout(casey.closed, "the clear")).toBe(ACCESS_CHANGED);

    // Another member's socket stays open through all of it.
    drew.sock.send({ type: "ping" });
    await drew.sock.waitFor("pong");
    expect(drew.closeCode()).toBeUndefined();
  });
});
