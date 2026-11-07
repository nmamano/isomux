// A privileged agent renames a member through PATCH /api/users/:username
// (task 259ec6b4; Nil, 2026-11-07: anything a member can do, an agent can do).
//
// What this file pins:
//   - an office owner's privileged agent renames any member, and the rename
//     carries to the name the member's agents report as manager (GET /agents);
//     the audit row names the agent as actor and the member as target;
//   - any privileged agent renames its own manager, as the member can, and no
//     one else;
//   - an ordinary agent and an API token rename no one;
//   - an agent sends only `name`: role, avatar or any other key is refused and
//     nothing is written.
// The human paths of users.update are pinned where they always were.
//
// Seam: startTestServer() - real auth + /api executor. Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";

import { mintApiToken } from "../api-tokens.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserById, getUserByName, updateUserById } from "../users.ts";
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

const codeOf = (r: Res) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

const idOf = (name: string): string => {
  const user = getUserByName(name);
  if (!user) throw new Error(`no member ${name}`);
  return user.id;
};

interface Row {
  operation: string;
  targets: string[];
  actor: { kind: string; id: string; ownerId?: string };
}

// Morgan owns the office; Alice and Bea are members of its first room. Each
// agent is a live agent with the token the office minted for it.
async function office() {
  const srv = await startTestServer();
  server = srv;
  const morgan = await srv.seedOwner("Morgan");
  await srv.seedMember("Alice");
  await srv.seedMember("Bea");
  const roomId = srv.agentManager.getRooms()[0].id;
  for (const name of ["Alice", "Bea"])
    expect(updateUserById(idOf(name), { allowedRooms: [roomId] }).ok).toBe(
      true,
    );
  const spawn = async (name: string, manager: string, privileged: boolean) => {
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
      manager,
      "codex",
    );
    if (!info) throw new Error(`spawn ${name} returned null`);
    if (privileged) await srv.agentManager.setPrivileged(info.id, true);
    const bearer = getAgentTokenRaw(info.id);
    if (!bearer) throw new Error(`no token for ${name}`);
    return { id: info.id, bearer };
  };
  const agents = {
    ownerPrivileged: await spawn("Owner helper", "Morgan", true),
    ownerPlain: await spawn("Owner plain", "Morgan", false),
    alicePrivileged: await spawn("Alice helper", "Alice", true),
    alicePlain: await spawn("Alice plain", "Alice", false),
    beaPlain: await spawn("Bea plain", "Bea", false),
  };
  const apiToken = async (name: string) =>
    (await mintApiToken({ userId: idOf(name), name, expiresInDays: null }))
      .token;
  return {
    srv,
    morgan,
    agents,
    apiTokens: {
      owner: await apiToken("Morgan"),
      alice: await apiToken("Alice"),
    },
  };
}
type Office = Awaited<ReturnType<typeof office>>;

const rename = (o: Office, bearer: string, username: string, body: unknown) =>
  call(o.srv, "PATCH", `/api/users/${encodeURIComponent(username)}`, {
    bearer,
    body,
  });

// GET /agents as the office owner: the manager name of each listed agent.
async function listedManagers(o: Office): Promise<Record<string, unknown>> {
  const res = await call(o.srv, "GET", "/agents", {
    session: o.morgan.rawSessionId,
  });
  expect(res.status).toBe(200);
  return Object.fromEntries(
    (res.body as { id: string; manager?: unknown }[]).map((a) => [
      a.id,
      a.manager,
    ]),
  );
}

describe("users.update: an agent renames a member", () => {
  it("an office owner's privileged agent renames any member; the agents' manager name follows and the audit row names the agent", async () => {
    const o = await office();
    const beaId = idOf("Bea");

    const res = await rename(o, o.agents.ownerPrivileged.bearer, "Bea", {
      name: "Bea Two",
    });
    expect(res.status).toBe(200);
    expect((res.body as { user: { id: string; name: string } }).user).toEqual(
      expect.objectContaining({ id: beaId, name: "Bea Two" }),
    );
    expect(getUserById(beaId)?.name).toBe("Bea Two");
    expect(getUserByName("Bea")).toBeUndefined();
    expect(await listedManagers(o)).toMatchObject({
      [o.agents.beaPlain.id]: "Bea Two",
      [o.agents.alicePlain.id]: "Alice",
    });

    const log = await call(
      o.srv,
      "GET",
      "/api/audit-log?operation=users.update",
      {
        session: o.morgan.rawSessionId,
      },
    );
    expect(log.status).toBe(200);
    const rows = (log.body as { items: Row[] }).items.filter((row) =>
      row.targets.includes(beaId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toEqual(
      expect.objectContaining({
        kind: "agent",
        id: o.agents.ownerPrivileged.id,
        ownerId: idOf("Morgan"),
      }),
    );
  });

  it("a member's privileged agent renames its manager and no one else", async () => {
    const o = await office();
    const aliceId = idOf("Alice");

    const own = await rename(o, o.agents.alicePrivileged.bearer, "Alice", {
      name: "Alicia",
    });
    expect(own.status).toBe(200);
    expect(getUserById(aliceId)?.name).toBe("Alicia");

    for (const target of ["Bea", "Morgan"]) {
      const before = structuredClone(getUserByName(target)!);
      const other = await rename(o, o.agents.alicePrivileged.bearer, target, {
        name: `${target} Renamed`,
      });
      expect([target, other.status, codeOf(other)]).toEqual([
        target,
        403,
        "forbidden",
      ]);
      expect(getUserByName(target)).toEqual(before);
    }
  });

  it("an ordinary agent and an API token rename no one", async () => {
    const o = await office();
    const cases: [string, string, string][] = [
      [
        "owner's ordinary agent, another member",
        o.agents.ownerPlain.bearer,
        "Bea",
      ],
      [
        "member's ordinary agent, its manager",
        o.agents.alicePlain.bearer,
        "Alice",
      ],
      ["owner's API token, another member", o.apiTokens.owner, "Bea"],
      ["member's API token, its user", o.apiTokens.alice, "Alice"],
    ];
    for (const [label, bearer, target] of cases) {
      const before = structuredClone(getUserByName(target)!);
      const r = await rename(o, bearer, target, { name: "Renamed" });
      expect([label, r.status, codeOf(r)]).toEqual([label, 403, "forbidden"]);
      expect([label, getUserByName(target)]).toEqual([label, before]);
    }
    expect(getUserByName("Renamed")).toBeUndefined();
  });

  it("an agent sends only the name: any other field is refused and nothing is written", async () => {
    const o = await office();
    const agent = o.agents.ownerPrivileged.bearer;
    const before = structuredClone(getUserByName("Bea")!);
    const cases: [unknown, number, string][] = [
      // The core reads the role of the caller's user: for an owner's agent,
      // an owner. Only the body rule keeps the promotion out.
      [{ name: "Bea Two", role: "owner" }, 403, "forbidden"],
      [{ role: "owner" }, 403, "forbidden"],
      [{ name: "Bea Two", role: null }, 403, "forbidden"],
      [{ avatarColor: "#123456" }, 403, "forbidden"],
      [{ name: "Bea Two", avatarVariant: "classic" }, 403, "forbidden"],
      [{ name: "Bea Two", allowedRooms: [] }, 403, "forbidden"],
      // No name: nothing to do.
      [{}, 422, "invalid_request"],
      // The old instruction fields answer every caller with the new route.
      [
        { memberPrompt: "Old", memberPromptVersion: "x" },
        400,
        "invalid_request",
      ],
    ];
    for (const [body, status, code] of cases) {
      const r = await rename(o, agent, "Bea", body);
      expect([body, r.status, codeOf(r)]).toEqual([body, status, code]);
    }
    expect(getUserById(before.id)).toEqual(before);
    // The same agent's own manager is no exception.
    const morganBefore = structuredClone(getUserByName("Morgan")!);
    const self = await rename(o, agent, "Morgan", {
      name: "Morgan",
      avatarColor: "#123456",
    });
    expect([self.status, codeOf(self)]).toEqual([403, "forbidden"]);
    expect(getUserByName("Morgan")).toEqual(morganBefore);

    // The agent reaches Bea, so the refusals above came from the body rule:
    // the name alone goes through and changes nothing else.
    const named = await rename(o, agent, "Bea", { name: "Bea Two" });
    expect(named.status).toBe(200);
    expect(getUserById(before.id)).toEqual({ ...before, name: "Bea Two" });
  });
});
