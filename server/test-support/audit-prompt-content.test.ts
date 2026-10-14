// Prompt history is kept like memory (Nil, 2026-10-14): every write to a
// surface that feeds an agent system prompt (the office prompt, a room prompt,
// an agent's custom instructions, a member's special instructions) keeps the
// stored text after the write in its audit row, for humans and agents alike.
// A restore writes an earlier row's text back through the normal route and
// gets its own row. A refused write keeps no text.

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
  const boss = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const bossId = getUserByName(boss.username)!.id;
  return {
    srv,
    boss,
    member,
    bossId,
    roomId: srv.agentManager.getRooms()[0].id,
    agent: mintAgentToken("boss-privileged", bossId, true),
  };
}
type Office = Awaited<ReturnType<typeof office>>;

async function rows(o: Office, operation: string): Promise<Row[]> {
  const res = await call(
    o.srv,
    "GET",
    `/api/audit-log?operation=${operation}`,
    { session: o.boss.rawSessionId },
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
  auth: Auth = { session: o.boss.rawSessionId },
): Promise<T> {
  const res = await call(o.srv, "GET", path, auth);
  expect(res.status).toBe(200);
  return res.body as T;
}

const officePrompt: Surface = {
  operation: "office.setSettings",
  target: () => "office",
  write: async (o, auth, text) => {
    const { version } = await bodyOf<{ version: string }>(
      o,
      "/api/office/settings",
    );
    return (
      await call(o.srv, "PUT", "/api/office/settings", {
        ...auth,
        body: { prompt: text, version },
      })
    ).status;
  },
  stored: (o) => o.srv.agentManager.getOfficeSettings().prompt,
};

const roomPrompt: Surface = {
  operation: "rooms.setSettings",
  target: (o) => o.roomId,
  write: async (o, auth, text) => {
    const path = `/api/rooms/${o.roomId}/settings`;
    const { version } = await bodyOf<{ version: string }>(o, path);
    return (
      await call(o.srv, "PUT", path, {
        ...auth,
        body: { prompt: text, version },
      })
    ).status;
  },
  stored: (o) =>
    o.srv.agentManager.getRooms().find((room) => room.id === o.roomId)!
      .prompt ?? null,
};

let targetAgentId = "";
const agentInstructions: Surface = {
  operation: "agents.update",
  target: () => targetAgentId,
  write: async (o, auth, text) => {
    const { customInstructionsVersion } = await bodyOf<{
      customInstructionsVersion: string;
    }>(o, `/api/agents/${targetAgentId}/instructions`);
    return (
      await call(o.srv, "PATCH", `/api/agents/${targetAgentId}`, {
        ...auth,
        body: { customInstructions: text, customInstructionsVersion },
      })
    ).status;
  },
  stored: (o) => o.srv.agentManager.getAgent(targetAgentId)!.customInstructions,
};

const memberPrompt: Surface = {
  operation: "users.update",
  target: (o) => getUserByName(o.member.username)!.id,
  write: async (o, auth, text) => {
    const path = `/api/users/${o.member.username}`;
    const { memberPromptVersion } = await bodyOf<{
      memberPromptVersion: string;
    }>(o, `${path}/member-prompt`);
    return (
      await call(o.srv, "PATCH", path, {
        ...auth,
        body: { memberPrompt: text, memberPromptVersion },
      })
    ).status;
  },
  stored: (o) => getUserByName(o.member.username)!.memberPrompt,
};

async function spawnTarget(o: Office): Promise<void> {
  const res = await call(o.srv, "POST", "/api/agents", {
    session: o.boss.rawSessionId,
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

describe.each([
  ["office prompt", officePrompt],
  ["room prompt", roomPrompt],
  ["agent custom instructions", agentInstructions],
  ["member special instructions", memberPrompt],
] as const)("%s", (_label, surface) => {
  it("keeps the text after each write, names the writer, and restores an earlier text", async () => {
    const o = await office();
    await spawnTarget(o);
    const asAgent = { bearer: o.agent };
    const asOwner = { session: o.boss.rawSessionId };

    expect(await surface.write(o, asAgent, "Text A")).toBeLessThan(300);
    expect(await surface.write(o, asOwner, "Text B")).toBeLessThan(300);
    expect(surface.stored(o)).toBe("Text B");

    const written = (await rows(o, surface.operation)).filter((row) =>
      row.targets.includes(surface.target(o)),
    );
    expect(written.map((row) => row.promptContent)).toEqual([
      "Text B",
      "Text A",
    ]);
    expect(written[1].actor).toEqual(
      expect.objectContaining({
        kind: "agent",
        id: "boss-privileged",
        ownerId: o.bossId,
      }),
    );
    expect(written[0].actor).toEqual(
      expect.objectContaining({ kind: "member", id: o.bossId }),
    );

    // Restore: the agent writes row A's text back through the same route.
    expect(
      await surface.write(o, asAgent, written[1].promptContent!),
    ).toBeLessThan(300);
    expect(surface.stored(o)).toBe("Text A");
    const restored = (await rows(o, surface.operation)).filter((row) =>
      row.targets.includes(surface.target(o)),
    )[0];
    expect(restored.sequence).toBeGreaterThan(written[0].sequence);
    expect(restored.promptContent).toBe("Text A");
    expect(restored.actor.kind).toBe("agent");

    // A cleared prompt keeps "".
    expect(await surface.write(o, asOwner, "")).toBeLessThan(300);
    expect(
      (await rows(o, surface.operation)).filter((row) =>
        row.targets.includes(surface.target(o)),
      )[0].promptContent,
    ).toBe("");
  });
});

describe("rows that keep no prompt text", () => {
  it("a refused write keeps no row and no text", async () => {
    const o = await office();
    expect(await officePrompt.write(o, { bearer: o.agent }, "Kept")).toBe(204);
    const before = await rows(o, "office.setSettings");
    const stale = await call(o.srv, "PUT", "/api/office/settings", {
      bearer: o.agent,
      body: { prompt: "Refused", version: "000000000000" },
    });
    expect(stale.status).toBe(409);
    const after = await rows(o, "office.setSettings");
    expect(after.map((row) => row.sequence)).toEqual(
      before.map((row) => row.sequence),
    );
    expect(after.map((row) => row.promptContent)).not.toContain("Refused");
    expect(officePrompt.stored(o)).toBe("Kept");
  });

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
          session: o.boss.rawSessionId,
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
      expect([operation, Object.keys(row).includes("promptContent")]).toEqual([
        operation,
        false,
      ]);
    }
  });

  it("a member created with special instructions keeps them, and one created without keeps no text", async () => {
    const o = await office();
    for (const body of [
      { name: "Briefed", role: "member", memberPrompt: "Member text" },
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
        id: "boss-privileged",
        ownerId: o.bossId,
      }),
    );
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
        customInstructions: "Spawn text",
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
