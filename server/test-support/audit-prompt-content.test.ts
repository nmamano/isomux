// Prompt history is kept like memory (Nil, 2026-10-14): every write to a
// surface that feeds an agent system prompt (the office prompt, a room prompt,
// an agent's custom instructions, a member's special instructions) keeps the
// stored text after the write in its audit row, for humans and agents alike,
// so a restore can write an earlier row's text back through the same route.
//
// One row per write route below; a refused write adds no row (route-executor
// "executor audit"). office.setSettings and users.update write no prompt text
// since task 744fa64a, so their rows keep none.

import { afterEach, describe, expect, it } from "bun:test";

import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

interface Row {
  sequence: number;
  operation: string;
  targets: string[];
  actor: { kind: string; id: string; ownerId?: string };
  promptContent?: string;
}

type Auth = { session?: string; bearer?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: Auth & { body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 204 has no body.
  }
  return { status: response.status, body };
}

async function office() {
  server = await startTestServer();
  const srv = server;
  const morgan = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Member");
  const morganId = getUserByName(morgan.username)!.id;
  return {
    srv,
    morgan,
    member,
    morganId,
    roomId: srv.agentManager.getRooms()[0].id,
    agent: mintAgentToken("morgan-privileged", morganId, true),
  };
}
type Office = Awaited<ReturnType<typeof office>>;

async function rows(o: Office, operation: string): Promise<Row[]> {
  const res = await call(
    o.srv,
    "GET",
    `/api/audit-log?operation=${operation}`,
    { session: o.morgan.rawSessionId },
  );
  expect(res.status).toBe(200);
  return (res.body as { items: Row[] }).items;
}

// One surface: how to write its text and how to read it back.
interface Surface {
  operation: string;
  target: (o: Office) => string;
  write: (o: Office, auth: Auth, text: string | null) => Promise<number>;
  stored: (o: Office) => string | null;
}

async function bodyOf<T>(
  o: Office,
  path: string,
  auth: Auth = { session: o.morgan.rawSessionId },
): Promise<T> {
  const res = await call(o.srv, "GET", path, auth);
  expect(res.status).toBe(200);
  return res.body as T;
}

let targetAgentId = "";
const agentInstructions: Surface = {
  operation: "agents.update",
  target: () => targetAgentId,
  write: async (o, auth, text) => {
    const { version } = await bodyOf<{ version: string }>(
      o,
      `/api/agents/${targetAgentId}/instructions`,
    );
    return (
      await call(o.srv, "PATCH", `/api/agents/${targetAgentId}`, {
        ...auth,
        body: { instructions: text, instructionsVersion: version },
      })
    ).status;
  },
  stored: (o) => o.srv.agentManager.getAgent(targetAgentId)!.customInstructions,
};

// The surfaces through their instructions routes (task 379ae5db).
function instructionsRoute(
  operation: string,
  path: (o: Office) => string,
  target: (o: Office) => string,
  stored: (o: Office) => string | null,
): Surface {
  return {
    operation,
    target,
    stored,
    write: async (o, auth, instructions) => {
      const { version } = await bodyOf<{ version: string }>(o, path(o));
      return (
        await call(o.srv, "PUT", path(o), {
          ...auth,
          body: { instructions, version },
        })
      ).status;
    },
  };
}

const officeInstructions = instructionsRoute(
  "office.setInstructions",
  () => "/api/office/instructions",
  () => "office",
  (o) => o.srv.agentManager.getOfficeSettings().prompt,
);
const roomInstructions = instructionsRoute(
  "rooms.setInstructions",
  (o) => `/api/rooms/${o.roomId}/instructions`,
  (o) => o.roomId,
  (o) =>
    o.srv.agentManager.getRooms().find((room) => room.id === o.roomId)!
      .prompt ?? null,
);
const agentInstructionsRoute = instructionsRoute(
  "agents.setInstructions",
  () => `/api/agents/${targetAgentId}/instructions`,
  agentInstructions.target,
  agentInstructions.stored,
);
const memberInstructions = instructionsRoute(
  "users.setInstructions",
  (o) => `/api/users/${o.member.username}/instructions`,
  (o) => getUserByName(o.member.username)!.id,
  (o) => getUserByName(o.member.username)!.memberPrompt,
);

async function spawnTarget(o: Office): Promise<void> {
  const res = await call(o.srv, "POST", "/api/agents", {
    session: o.morgan.rawSessionId,
    body: {
      name: "Target",
      cwd: o.srv.stateRoot,
      roomId: o.roomId,
      desk: 0,
      permissionMode: "default",
    },
  });
  expect(res.status).toBe(201);
  targetAgentId = (res.body as { agent: { id: string } }).agent.id;
}

describe("rows that keep prompt text", () => {
  it("each prompt route keeps the stored text after the write, and an empty text after a clear", async () => {
    const o = await office();
    await spawnTarget(o);
    const asAgent = { bearer: o.agent };
    for (const [label, surface] of [
      ["office instructions route", officeInstructions],
      ["room instructions route", roomInstructions],
      ["agent update", agentInstructions],
      ["agent instructions route", agentInstructionsRoute],
      ["member instructions route", memberInstructions],
    ] as const) {
      const newest = async () =>
        (await rows(o, surface.operation)).find((row) =>
          row.targets.includes(surface.target(o)),
        );
      const text = `Text for ${label}`;
      expect([label, (await surface.write(o, asAgent, text)) < 300]).toEqual([
        label,
        true,
      ]);
      expect([label, surface.stored(o)]).toEqual([label, text]);
      expect([label, (await newest())?.promptContent]).toEqual([label, text]);
      const before = (await newest())!.sequence;
      expect(await surface.write(o, asAgent, "")).toBeLessThan(300);
      const cleared = await newest();
      expect([
        label,
        cleared!.sequence > before,
        cleared!.promptContent,
      ]).toEqual([label, true, ""]);
    }
  });
});

describe("rows that keep no prompt text", () => {
  it("a write that does not touch a prompt keeps no text", async () => {
    const o = await office();
    await spawnTarget(o);
    expect(
      (
        await call(o.srv, "PATCH", `/api/agents/${targetAgentId}`, {
          bearer: o.agent,
          body: { name: "Renamed" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(o.srv, "PATCH", `/api/users/${o.member.username}`, {
          session: o.morgan.rawSessionId,
          body: { avatarColor: "#336699" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(o.srv, "PATCH", `/api/rooms/${o.roomId}`, {
          bearer: o.agent,
          body: { name: "Renamed room" },
        })
      ).status,
    ).toBe(204);
    for (const operation of ["agents.update", "users.update", "rooms.rename"]) {
      const [row] = await rows(o, operation);
      // The row exists: the absence is of the text, not of the row.
      expect([operation, row?.operation]).toEqual([operation, operation]);
      expect([operation, Object.keys(row).includes("promptContent")]).toEqual([
        operation,
        false,
      ]);
    }
  });

  it("a member created with special instructions keeps them, and one created without keeps no text", async () => {
    const o = await office();
    for (const body of [
      { name: "Briefed", role: "member", instructions: "Member text" },
      { name: "Plain", role: "member" },
    ])
      expect(
        (await call(o.srv, "POST", "/api/users", { bearer: o.agent, body }))
          .status,
      ).toBe(201);
    const created = await rows(o, "users.create");
    const byName = (name: string) =>
      created.find((row) => row.targets.includes(getUserByName(name)!.id))!;
    expect(byName("Briefed").promptContent).toBe("Member text");
    expect(byName("Briefed").actor).toEqual(
      expect.objectContaining({
        kind: "agent",
        id: "morgan-privileged",
        ownerId: o.morganId,
      }),
    );
    expect(Object.keys(byName("Plain"))).toContain("operation");
    expect(Object.keys(byName("Plain"))).not.toContain("promptContent");
  });

  it("a spawn keeps the agent's stored instructions, empty when none", async () => {
    const o = await office();
    await spawnTarget(o);
    const res = await call(o.srv, "POST", "/api/agents", {
      bearer: o.agent,
      body: {
        name: "Briefed",
        cwd: o.srv.stateRoot,
        roomId: o.roomId,
        desk: 1,
        permissionMode: "default",
        instructions: "Spawn text",
      },
    });
    expect(res.status).toBe(201);
    const briefed = (res.body as { agent: { id: string } }).agent.id;
    const spawned = await rows(o, "agents.spawn");
    const byTarget = (id: string) =>
      spawned.find((row) => row.targets.includes(id));
    expect(byTarget(briefed)?.promptContent).toBe("Spawn text");
    expect(byTarget(briefed)?.actor.kind).toBe("agent");
    expect(byTarget(targetAgentId)?.promptContent).toBe("");
  });
});
