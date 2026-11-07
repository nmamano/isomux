// Every instruction layer (office, room, agent, member, schedules) reads and
// writes its text at GET/PUT .../instructions with {instructions, version}
// (task 379ae5db). The old routes and field names stayed for one release and
// are gone (task 744fa64a).
//
// What this file pins, per layer:
//   - the read/write round trip: the PUT answers with the stored text and its
//     version, null and "" clear, and the write reaches the browsers live;
//   - a missing version is 400, a stale one 409 with the current version, and
//     neither writes;
//   - which callers read and write it.
// Then the per-layer rules: the office instructions outside the settings
// version, the member write that takes only the text, the agent and member
// fields on the agent and member routes, and what a caller of an old route or
// field name gets: a 404 for a route, a 400 that names the new field for a
// field, and nothing written.
//
// Seam: startTestServer() - real auth + /api executor + WS. Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";

import { versionOf } from "../../shared/blob-version.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, setUserRoleById, updateUserById } from "../users.ts";
import type { ApiTokenLimits } from "../../shared/api-token-limits.ts";
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

const errOf = (r: Res) =>
  (
    r.body as {
      error?: { code?: string; version?: string; message?: string };
    } | null
  )?.error;

async function office() {
  server = await startTestServer();
  const srv = server;
  const morgan = await srv.seedOwner("Morgan");
  const mia = await srv.seedMember("Mia");
  const morganId = getUserByName(morgan.username)!.id;
  const miaId = getUserByName(mia.username)!.id;
  const roomId = srv.agentManager.getRooms()[0].id;
  const spawned = await call(srv, "POST", "/api/agents", {
    session: morgan.rawSessionId,
    body: {
      name: "Target",
      cwd: srv.stateRoot,
      roomId,
      desk: 0,
      permissionMode: "default",
    },
  });
  expect(spawned.status).toBe(201);
  const agentId = (spawned.body as { agent: { id: string } }).agent.id;
  const apiToken = async (userId: string, name: string) =>
    (await mintApiToken({ userId, name, expiresInDays: null })).token;
  return {
    srv,
    morgan,
    mia,
    morganId,
    miaId,
    roomId,
    agentId,
    // Every kind of caller the routes tell apart.
    callers: {
      ownerSession: { session: morgan.rawSessionId },
      memberSession: { session: mia.rawSessionId },
      // One token per agent id: a second mint for an id replaces the first.
      ownerPrivilegedAgent: {
        bearer: mintAgentToken("morgan-privileged", morganId, true),
      },
      ownerPlainAgent: {
        bearer: mintAgentToken("morgan-plain", morganId, false),
      },
      memberPrivilegedAgent: {
        bearer: mintAgentToken("mia-privileged", miaId, true),
      },
      ownerApiToken: { bearer: await apiToken(morganId, "Morgan") },
      memberApiToken: { bearer: await apiToken(miaId, "Mia") },
    } satisfies Record<string, Auth>,
  };
}
type Office = Awaited<ReturnType<typeof office>>;

interface Layer {
  name: string;
  path: (o: Office) => string;
  stored: (o: Office) => string | null;
  // The WS event the write sends.
  event: string;
  // The callers that read and write the layer; the rest get 403. The member
  // layer's target is Mia, an ordinary member.
  allowed: (keyof Office["callers"])[];
}

const owner = (o: Office) => o.callers.ownerSession;

const OWNER_REACH = [
  "ownerSession",
  "ownerPrivilegedAgent",
  "ownerApiToken",
] as const;

const officeLayer: Layer = {
  name: "office",
  path: () => "/api/office/instructions",
  stored: (o) => o.srv.agentManager.getOfficeSettings().prompt,
  event: "office_settings_updated",
  allowed: [...OWNER_REACH],
};

const roomLayer: Layer = {
  name: "room",
  path: (o) => `/api/rooms/${o.roomId}/instructions`,
  stored: (o) =>
    o.srv.agentManager.getRooms().find((room) => room.id === o.roomId)!
      .prompt ?? null,
  event: "room_settings_updated",
  allowed: [...OWNER_REACH],
};

const agentLayer: Layer = {
  name: "agent",
  path: (o) => `/api/agents/${o.agentId}/instructions`,
  stored: (o) => o.srv.agentManager.getAgent(o.agentId)!.customInstructions,
  event: "agent_updated",
  // An ordinary agent reads an agent's instructions, and writes none.
  allowed: [...OWNER_REACH],
};

const memberLayer: Layer = {
  name: "member",
  path: () => "/api/users/Mia/instructions",
  stored: () => getUserByName("Mia")!.memberPrompt,
  // The owner's socket gets the full record; user_updated is the public one.
  event: "user_admin_updated",
  allowed: [
    ...OWNER_REACH,
    "memberSession",
    "memberPrivilegedAgent",
    "memberApiToken",
  ],
};

const cronLayer: Layer = {
  name: "schedules",
  path: () => "/api/cron-instructions",
  stored: (o) => o.srv.cronjobManager.getCronjobsPrompt(),
  event: "cronjobs_prompt_updated",
  allowed: ["ownerSession"],
};

const LAYERS = [officeLayer, roomLayer, agentLayer, memberLayer, cronLayer];

async function readNew(o: Office, layer: Layer, auth = owner(o)) {
  const r = await call(o.srv, "GET", layer.path(o), auth);
  expect([layer.name, r.status]).toEqual([layer.name, 200]);
  return r.body as { instructions: string | null; version: string };
}

function writeNew(
  o: Office,
  layer: Layer,
  body: unknown,
  auth: Auth = owner(o),
): Promise<Res> {
  return call(o.srv, "PUT", layer.path(o), { ...auth, body });
}

// Resolves once the socket holds an `event` message that carries `text`: the
// write reached the browsers with its new value.
async function eventCarrying(
  sock: TestSocket,
  event: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (
      sock.messages.some(
        (m) =>
          (m as { type?: string }).type === event &&
          JSON.stringify(m).includes(text),
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${event} carrying ${JSON.stringify(text)}`);
}

describe.each(LAYERS.map((l) => [l.name, l] as const))(
  "%s instructions",
  (_name, layer) => {
    it("reads and writes the text with its version, clears on null and empty, and reaches the browsers", async () => {
      const o = await office();
      const sock = await o.srv.connectWs(o.morgan.rawSessionId);

      const before = await readNew(o, layer);
      expect(before.instructions).toBeNull();
      expect(before.version).toBe(versionOf(""));

      const saved = await writeNew(o, layer, {
        instructions: "Text A",
        version: before.version,
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        instructions: "Text A",
        version: versionOf("Text A"),
      });
      expect(layer.stored(o)).toBe("Text A");
      const after = await readNew(o, layer);
      expect({
        instructions: after.instructions,
        version: after.version,
      }).toEqual({ instructions: "Text A", version: versionOf("Text A") });
      await eventCarrying(sock, layer.event, "Text A");

      let version = after.version;
      for (const cleared of [null, ""]) {
        expect(
          (await writeNew(o, layer, { instructions: "Text B", version }))
            .status,
        ).toBe(200);
        const r = await writeNew(o, layer, {
          instructions: cleared,
          version: versionOf("Text B"),
        });
        expect([cleared, r.status]).toEqual([cleared, 200]);
        expect(r.body).toEqual({ instructions: null, version: versionOf("") });
        expect([cleared, layer.stored(o)]).toEqual([cleared, null]);
        version = versionOf("");
      }
    });

    it("refuses a missing, malformed or stale version and a malformed text, and writes nothing", async () => {
      const o = await office();
      const { version } = await readNew(o, layer);
      expect(
        (await writeNew(o, layer, { instructions: "Kept", version })).status,
      ).toBe(200);

      for (const bad of [undefined, "", null, 7]) {
        const r = await writeNew(o, layer, {
          instructions: "Refused",
          ...(bad === undefined ? {} : { version: bad }),
        });
        expect([bad, r.status]).toEqual([bad, 400]);
        expect(errOf(r)?.code).toBe("invalid_version");
      }

      const stale = await writeNew(o, layer, {
        instructions: "Refused",
        version,
      });
      expect(stale.status).toBe(409);
      expect(errOf(stale)).toEqual(
        expect.objectContaining({
          code: "version_conflict",
          version: versionOf("Kept"),
        }),
      );

      for (const instructions of [7, ["x"], { text: "x" }, undefined]) {
        const r = await writeNew(o, layer, {
          ...(instructions === undefined ? {} : { instructions }),
          version: versionOf("Kept"),
        });
        expect(r.status >= 400 && r.status < 500, JSON.stringify(r)).toBe(true);
      }
      expect(layer.stored(o)).toBe("Kept");
    });

    it("answers only its callers, and every caller is authenticated", async () => {
      const o = await office();
      const reads: string[] = [];
      const writes: string[] = [];
      for (const [who, auth] of Object.entries(o.callers)) {
        // A stale version: an allowed write is a 409, and nothing changes.
        const write = await writeNew(
          o,
          layer,
          { instructions: "x", version: "000000000000" },
          auth,
        );
        const read = await call(o.srv, "GET", layer.path(o), auth);
        expect([who, read.status]).toEqual([
          who,
          read.status === 403 ? 403 : 200,
        ]);
        expect([who, write.status]).toEqual([
          who,
          write.status === 403 ? 403 : 409,
        ]);
        if (read.status === 200) reads.push(who);
        if (write.status === 409) writes.push(who);
      }
      const expected = [...layer.allowed].sort();
      expect(writes.sort()).toEqual(expected);
      // An agent's instructions are also read by its manager's ordinary
      // agents, and a member's by every agent of an owner (owner reach).
      expect(reads.sort()).toEqual(
        layer === agentLayer || layer === memberLayer
          ? [...expected, "ownerPlainAgent"].sort()
          : expected,
      );
      expect(layer.stored(o)).toBeNull();
    });
  },
);

describe("office instructions and office settings", () => {
  it("each version covers only its own fields, so neither write makes the other stale", async () => {
    const o = await office();
    const settings = async () =>
      (await call(o.srv, "GET", "/api/office/settings", owner(o))).body as {
        name: string | null;
        version: string;
        memberUsageShare: number;
      };

    // A name change leaves the instructions version alone.
    const i0 = (await readNew(o, officeLayer)).version;
    const s0 = await settings();
    expect(
      (
        await call(o.srv, "PUT", "/api/office/settings", {
          ...owner(o),
          body: { name: "Acme", version: s0.version },
        })
      ).status,
    ).toBe(204);
    expect((await readNew(o, officeLayer)).version).toBe(i0);

    // An instructions write changes the text and nothing else, and leaves the
    // settings version alone: a settings write from a read before it lands.
    const s1 = await settings();
    expect(
      (await writeNew(o, officeLayer, { instructions: "Rules", version: i0 }))
        .status,
    ).toBe(200);
    expect(await settings()).toEqual(s1);
    expect(
      (
        await call(o.srv, "PUT", "/api/office/settings", {
          ...owner(o),
          body: { name: "Acme 2", version: s1.version },
        })
      ).status,
    ).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt: "Rules", name: "Acme 2" }),
    );
  });
});

describe("member instructions write", () => {
  it("changes only the text, whatever else the body carries", async () => {
    const o = await office();
    const extras = {
      role: "owner",
      name: "Renamed",
      avatarColor: "#000000",
      avatarVariant: "sleepy",
      allowedRooms: [o.roomId],
      memberPrompt: "Old field",
      memberPromptVersion: versionOf(""),
    };
    // An owner's privileged agent: the executor's role check would read its
    // owner's role, so any field it passed on would act as an owner.
    for (const [who, auth] of [
      ["owner's privileged agent", o.callers.ownerPrivilegedAgent],
      ["owner's API token", o.callers.ownerApiToken],
      ["the member", o.callers.memberSession],
    ] as const) {
      const before = structuredClone(getUserByName("Mia")!);
      const text = `Text from ${who}`;
      const r = await writeNew(
        o,
        memberLayer,
        {
          instructions: text,
          version: versionOf(before.memberPrompt ?? ""),
          ...extras,
        },
        auth,
      );
      const now = getUserByName("Mia")!;
      expect([who, { ...now, memberPrompt: null }]).toEqual([
        who,
        { ...before, memberPrompt: null },
      ]);
      expect([who, r.status, now.memberPrompt]).toEqual(
        r.status === 200
          ? [who, 200, text]
          : [who, r.status, before.memberPrompt],
      );
    }
    expect(getUserByName("Renamed")).toBeUndefined();
  });

  it("reaches other members only with an owner's reach, checked live on each request", async () => {
    const o = await office();
    const path = "/api/users/Morgan/instructions";
    const writers = async () => {
      const allowed: string[] = [];
      for (const [who, auth] of Object.entries(o.callers)) {
        const write = await call(o.srv, "PUT", path, {
          ...auth,
          body: { instructions: "x", version: "000000000000" },
        });
        expect([who, write.status]).toEqual([
          who,
          write.status === 403 ? 403 : 409,
        ]);
        if (write.status === 409) allowed.push(who);
      }
      return allowed.sort();
    };
    expect(await writers()).toEqual([
      "ownerApiToken",
      "ownerPrivilegedAgent",
      "ownerSession",
    ]);
    // Mia's agent and token, demoted Morgan's: the reach goes with the role.
    // Morgan's own still reach Morgan's text.
    expect(setUserRoleById(o.miaId, "owner")).toBe(true);
    expect(setUserRoleById(o.morganId, "member")).toBe(true);
    const mias = (await writers()).filter((who) => who.startsWith("member"));
    expect(mias).toEqual([
      "memberApiToken",
      "memberPrivilegedAgent",
      "memberSession",
    ]);
    const memberWrite = await call(
      o.srv,
      "PUT",
      "/api/users/Mia/instructions",
      {
        bearer: o.callers.ownerApiToken.bearer,
        body: { instructions: "x", version: "000000000000" },
      },
    );
    expect(memberWrite.status).toBe(403);
  });
});

// Reading a member's instructions follows the rooms (task bf94d714): the
// member's own identities, owners (with every agent of theirs), and whoever
// shares a live ordinary room with the member. The lobby is not shared. The
// write stays with the member and an owner's reach (above).
describe("member instructions read", () => {
  async function rooms() {
    server = await startTestServer();
    const srv = server;
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const nora = await srv.seedMember("Nora");
    const pat = await srv.seedMember("Pat");
    const id = (name: string) => getUserByName(name)!.id;
    const roomA = srv.agentManager.createRoom("Alpha");
    const roomB = srv.agentManager.createRoom("Beta");
    srv.agentManager.ensureLobby();
    expect(updateUserById(id("Mia"), { allowedRooms: [roomA] }).ok).toBe(true);
    expect(updateUserById(id("Nora"), { allowedRooms: [roomA] }).ok).toBe(true);
    expect(updateUserById(id("Pat"), { allowedRooms: [roomB] }).ok).toBe(true);
    const mint = async (name: string, limits?: ApiTokenLimits) =>
      (
        await mintApiToken({
          userId: id(name),
          name,
          expiresInDays: null,
          ...(limits ? { limits } : {}),
        })
      ).token;
    // Mia's instructions, written by Mia.
    const path = "/api/users/Mia/instructions";
    const before = await call(srv, "GET", path, { session: mia.rawSessionId });
    const { version } = before.body as { version: string };
    expect(
      (
        await call(srv, "PUT", path, {
          session: mia.rawSessionId,
          body: { instructions: "Mia's rules", version },
        })
      ).status,
    ).toBe(200);
    return {
      srv,
      id,
      roomA,
      path,
      callers: {
        miaPlainAgent: { bearer: mintAgentToken("mia-plain", id("Mia")) },
        nora: { session: nora.rawSessionId },
        noraPlainAgent: { bearer: mintAgentToken("nora-plain", id("Nora")) },
        noraApiTokenInA: { bearer: await mint("Nora", { rooms: [roomA] }) },
        noraApiTokenNoRooms: { bearer: await mint("Nora", { rooms: [] }) },
        pat: { session: pat.rawSessionId },
        patPlainAgent: { bearer: mintAgentToken("pat-plain", id("Pat")) },
        morganPlainAgent: {
          bearer: mintAgentToken("morgan-plain", id("Morgan")),
        },
        morganApiTokenInB: { bearer: await mint("Morgan", { rooms: [roomB] }) },
      } satisfies Record<string, Auth>,
      morgan,
    };
  }

  it("reaches the member's own agents, owners' agents and whoever shares a room, with the text", async () => {
    const o = await rooms();
    const out: Record<string, string> = {};
    for (const [who, auth] of Object.entries(o.callers)) {
      const r = await call(o.srv, "GET", o.path, auth);
      const text = (r.body as { instructions?: string } | null)?.instructions;
      out[who] = r.status === 200 ? `200 ${text}` : `${r.status}`;
    }
    expect(out).toEqual({
      miaPlainAgent: "200 Mia's rules",
      nora: "200 Mia's rules",
      noraPlainAgent: "200 Mia's rules",
      noraApiTokenInA: "200 Mia's rules",
      noraApiTokenNoRooms: "403",
      // Pat reaches only room B and the lobby.
      pat: "403",
      patPlainAgent: "403",
      morganPlainAgent: "200 Mia's rules",
      // A room-limited token has no owner reach.
      morganApiTokenInB: "403",
    });
    // A reader that shares a room still writes nothing.
    const write = await call(o.srv, "PUT", o.path, {
      ...o.callers.noraPlainAgent,
      body: { instructions: "x", version: versionOf("Mia's rules") },
    });
    expect(write.status).toBe(403);
    expect(getUserByName("Mia")!.memberPrompt).toBe("Mia's rules");
  });

  it("an unknown member reads as one that shares no room, and a lost grant applies to the next read", async () => {
    const o = await rooms();
    const unknown = await call(
      o.srv,
      "GET",
      "/api/users/Nobody/instructions",
      o.callers.noraPlainAgent,
    );
    const unshared = await call(o.srv, "GET", o.path, o.callers.patPlainAgent);
    expect({ status: unknown.status, error: errOf(unknown) }).toEqual({
      status: unshared.status,
      error: errOf(unshared),
    });
    expect(unshared.status).toBe(403);

    expect(
      (await call(o.srv, "GET", o.path, o.callers.noraPlainAgent)).status,
    ).toBe(200);
    expect(updateUserById(o.id("Nora"), { allowedRooms: [] }).ok).toBe(true);
    expect(
      (await call(o.srv, "GET", o.path, o.callers.noraPlainAgent)).status,
    ).toBe(403);
  });

  it("a token without the office area reads no member's instructions", async () => {
    const o = await rooms();
    const token = (
      await mintApiToken({
        userId: o.id("Nora"),
        name: "Nora memory only",
        expiresInDays: null,
        limits: { areas: { memory: "read" }, rooms: [o.roomA] },
      })
    ).token;
    const r = await call(o.srv, "GET", o.path, { bearer: token });
    const area = (errOf(r) as { area?: string } | undefined)?.area;
    expect({ status: r.status, area }).toEqual({ status: 403, area: "office" });
  });
});

// A system prompt carries its manager's special instructions and member memory.
// A caller that may read the prompt but shares no room with the manager
// (sharesRoomWithMember: the users/:name/instructions rule) gets the prompt
// with a marker in place of those two parts (task 1f2bfac6).
describe("manager's instructions and memory in a system prompt", () => {
  const MIA_INSTR = "mia-instructions-sentinel";
  const MIA_MEMORY = "mia-member-memory-sentinel";
  const MORGAN_INSTR = "morgan-instructions-sentinel";
  const MORGAN_MEMORY = "morgan-member-memory-sentinel";
  const NORA_INSTR = "nora-instructions-sentinel";
  const OFFICE_MEMORY = "office-memory-sentinel";
  const AGENT_INSTR = "agent-instructions-sentinel";
  const AGENT_MEMORY = "agent-memory-sentinel";

  async function rooms() {
    server = await startTestServer();
    const srv = server;
    const morgan = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const nora = await srv.seedMember("Nora");
    const pat = await srv.seedMember("Pat");
    const quinn = await srv.seedMember("Quinn");
    const id = (name: string) => getUserByName(name)!.id;
    const roomA = srv.agentManager.createRoom("Alpha");
    const roomB = srv.agentManager.createRoom("Beta");
    const lobby = srv.agentManager.ensureLobby().id;
    for (const [name, allowedRooms] of [
      ["Mia", [roomA]],
      ["Nora", [roomA]],
      ["Pat", [roomB]],
      ["Quinn", []],
    ] as const)
      expect(
        updateUserById(id(name), { allowedRooms: [...allowedRooms] }).ok,
      ).toBe(true);
    const setInstructions = async (
      name: string,
      session: string,
      text: string,
    ) => {
      const path = `/api/users/${name}/instructions`;
      const { version } = (await call(srv, "GET", path, { session })).body as {
        version: string;
      };
      expect(
        (
          await call(srv, "PUT", path, {
            session,
            body: { instructions: text, version },
          })
        ).status,
      ).toBe(200);
    };
    const remember = async (session: string, body: unknown) =>
      expect(
        (await call(srv, "POST", "/api/memory", { session, body })).status,
      ).toBe(201);
    const spawn = async (
      session: string,
      name: string,
      roomId: string,
      desk?: number,
    ) => {
      const r = await call(srv, "POST", "/api/agents", {
        session,
        body: {
          name,
          cwd: srv.stateRoot,
          roomId,
          ...(desk === undefined ? {} : { desk }),
          permissionMode: "default",
          instructions: AGENT_INSTR,
        },
      });
      expect([name, r.status]).toEqual([name, 201]);
      const agentId = (r.body as { agent: { id: string } }).agent.id;
      await remember(session, {
        scope: "agent",
        scopeId: agentId,
        text: AGENT_MEMORY,
      });
      return agentId;
    };
    await setInstructions("Mia", mia.rawSessionId, MIA_INSTR);
    await setInstructions("Morgan", morgan.rawSessionId, MORGAN_INSTR);
    await setInstructions("Nora", nora.rawSessionId, NORA_INSTR);
    await remember(mia.rawSessionId, {
      scope: "member",
      scopeId: id("Mia"),
      text: MIA_MEMORY,
    });
    await remember(morgan.rawSessionId, {
      scope: "member",
      scopeId: id("Morgan"),
      text: MORGAN_MEMORY,
    });
    await remember(morgan.rawSessionId, {
      scope: "office",
      text: OFFICE_MEMORY,
    });
    // Pat has no instructions and no member memory, and never reaches room A.
    const patA = await srv.agentManager.spawn(
      "Pat alpha",
      srv.stateRoot,
      "default",
      1,
      undefined,
      roomA,
      undefined,
      undefined,
      undefined,
      "Pat",
      "claude",
      undefined,
      id("Pat"),
    );
    const agents = {
      // The lobby holds one agent: the owner's, like the default lobby agent.
      morganLobby: await spawn(morgan.rawSessionId, "Morgan lobby", lobby, 0),
      miaA: await spawn(mia.rawSessionId, "Mia alpha", roomA, 0),
      patA: patA!.id,
    };
    // Mia's agent stays in room A after she loses it.
    expect(updateUserById(id("Mia"), { allowedRooms: [roomB] }).ok).toBe(true);
    const callers = {
      mia: { session: mia.rawSessionId },
      morgan: { session: morgan.rawSessionId },
      morganLobbyItself: {
        bearer: mintAgentToken(agents.morganLobby, id("Morgan")),
      },
      // Nora reaches room A and the lobby; Mia now reaches only room B.
      nora: { session: nora.rawSessionId },
      noraPlainAgent: { bearer: mintAgentToken("nora-plain", id("Nora")) },
      pat: { session: pat.rawSessionId },
      quinn: { session: quinn.rawSessionId },
    } satisfies Record<string, Auth>;
    const prompt = async (agentId: string, auth: Auth) => {
      const r = await call(
        srv,
        "GET",
        `/api/agents/${agentId}/system-prompt`,
        auth,
      );
      return r.status === 200
        ? (r.body as { prompt: string }).prompt
        : r.status;
    };
    return { srv, id, roomA, roomB, lobby, agents, callers, prompt };
  }

  // `hidden` is `shown` with a marker line in place of the instructions body,
  // and the same marker in the memory block, between the office memory and
  // the agent memory. Everything else of the prompt stays.
  function expectRedacted(
    shown: string,
    hidden: string,
    instr: string,
    memory: string | null,
  ) {
    expect(shown).toContain(instr);
    if (memory) expect(shown).toContain(memory);
    expect(hidden).not.toContain(instr);
    if (memory) expect(hidden).not.toContain(memory);
    const prefix = shown.slice(0, shown.indexOf(instr));
    expect(hidden.startsWith(prefix)).toBe(true);
    const marker = hidden.slice(prefix.length).split("\n")[0]!;
    expect(marker.trim()).not.toBe("");
    if (memory === null) return;
    for (const kept of [OFFICE_MEMORY, AGENT_INSTR, AGENT_MEMORY])
      expect(hidden).toContain(kept);
    const office = hidden.indexOf(OFFICE_MEMORY);
    const inMemory = hidden.indexOf(marker, office);
    expect(inMemory).toBeGreaterThan(office);
    expect(inMemory).toBeLessThan(hidden.indexOf(AGENT_MEMORY));
  }

  it("hides them from a caller that shares no room with the manager, on the owner's lobby agent and on an agent in a room the manager lost", async () => {
    const o = await rooms();
    const shown = {
      morganLobby: (await o.prompt(
        o.agents.morganLobby,
        o.callers.morgan,
      )) as string,
      miaA: (await o.prompt(o.agents.miaA, o.callers.morgan)) as string,
    };
    const out: Record<string, string> = {};
    for (const [agent, instr, memory] of [
      ["morganLobby", MORGAN_INSTR, MORGAN_MEMORY],
      ["miaA", MIA_INSTR, MIA_MEMORY],
    ] as const)
      for (const [who, auth] of Object.entries(o.callers)) {
        const r = await o.prompt(o.agents[agent], auth);
        if (typeof r === "number") out[`${agent} ${who}`] = `${r}`;
        else if (r.includes(instr)) {
          out[`${agent} ${who}`] = "shown";
          expect(r).toBe(shown[agent]);
        } else {
          out[`${agent} ${who}`] = "hidden";
          expectRedacted(shown[agent], r, instr, memory);
        }
      }
    expect(out).toEqual({
      "morganLobby mia": "shown",
      "morganLobby morgan": "shown",
      // The agent itself acts for its manager.
      "morganLobby morganLobbyItself": "shown",
      "morganLobby nora": "shown",
      "morganLobby noraPlainAgent": "shown",
      "morganLobby pat": "shown",
      // Quinn reaches only the lobby, which is no shared room.
      "morganLobby quinn": "hidden",
      // Mia lost room A, so the route guard refuses her.
      "miaA mia": "403",
      "miaA morgan": "shown",
      "miaA morganLobbyItself": "shown",
      "miaA nora": "hidden",
      "miaA noraPlainAgent": "hidden",
      // No access to room A: the route guard, as before.
      "miaA pat": "403",
      "miaA quinn": "403",
    });
  });

  it("the rule is checked live on each read, and a manager with nothing private gives the same prompt to every reader", async () => {
    const o = await rooms();
    expect(await o.prompt(o.agents.miaA, o.callers.nora)).not.toContain(
      MIA_INSTR,
    );
    expect(
      updateUserById(o.id("Nora"), { allowedRooms: [o.roomA, o.roomB] }).ok,
    ).toBe(true);
    expect(await o.prompt(o.agents.miaA, o.callers.nora)).toBe(
      await o.prompt(o.agents.miaA, o.callers.morgan),
    );
    // Nora shares no room with Pat, and reads what an owner reads.
    expect(updateUserById(o.id("Nora"), { allowedRooms: [o.roomA] }).ok).toBe(
      true,
    );
    const full = await o.prompt(o.agents.patA, o.callers.morgan);
    expect(typeof full).toBe("string");
    expect(await o.prompt(o.agents.patA, o.callers.nora)).toBe(full);
  });

  it("the preview of an existing agent follows the same rule; a new agent's preview shows the caller's own", async () => {
    const o = await rooms();
    const preview = async (auth: Auth, agentId?: string) => {
      const r = await call(o.srv, "POST", "/api/agents/system-prompt-preview", {
        ...auth,
        body: {
          roomId: o.roomA,
          ...(agentId ? { agentId } : {}),
          name: "Draft",
          agentType: "claude",
          instructions: AGENT_INSTR,
          privileged: false,
          memory: AGENT_MEMORY,
        },
      });
      expect(r.status).toBe(200);
      return (r.body as { prompt: string }).prompt;
    };
    const shown = await preview(o.callers.morgan, o.agents.miaA);
    expectRedacted(
      shown,
      await preview(o.callers.nora, o.agents.miaA),
      MIA_INSTR,
      MIA_MEMORY,
    );
    expect(await preview(o.callers.nora)).toContain(NORA_INSTR);
  });

  it("a room schedule's system prompt hides its maker's instructions from a room member that shares no room with the maker; the run keeps them", async () => {
    const o = await rooms();
    const job = o.srv.cronjobManager.addCronjob({
      name: "Mia's job",
      schedule: { type: "interval", minutes: 60 },
      prompt: "p",
      cwd: o.srv.stateRoot,
      agentType: "claude",
      username: "Mia",
      userId: o.id("Mia"),
      roomId: o.roomA,
    });
    const read = async (auth: Auth) => {
      const r = await call(
        o.srv,
        "GET",
        `/api/cronjobs/${job.id}/system-prompt`,
        auth,
      );
      expect(r.status).toBe(200);
      return (r.body as { systemPrompt: string }).systemPrompt;
    };
    const shown = await read(o.callers.mia);
    expect(await read(o.callers.morgan)).toBe(shown);
    expectRedacted(shown, await read(o.callers.nora), MIA_INSTR, null);
    // The run's session prompt is built for the maker, not for a reader.
    expect(o.srv.cronjobManager.buildCronjobSystemPrompt(job)).toContain(
      MIA_INSTR,
    );
  });
});

describe("schedule instructions", () => {
  it("stay with the office owner's own session", async () => {
    const o = await office();
    const allowed: string[] = [];
    for (const [who, auth] of Object.entries(o.callers)) {
      const read = await call(o.srv, "GET", "/api/cron-instructions", auth);
      expect([who, read.status]).not.toEqual([who, 401]);
      if (read.status !== 403) allowed.push(who);
    }
    expect(allowed).toEqual(["ownerSession"]);
  });
});

describe("agent instructions fields", () => {
  it("PATCH /api/agents/:id takes instructions with instructionsVersion", async () => {
    const o = await office();
    const patch = (body: unknown) =>
      call(o.srv, "PATCH", `/api/agents/${o.agentId}`, { ...owner(o), body });

    const missing = await patch({ instructions: "No version" });
    expect(missing.status).toBe(400);
    expect(errOf(missing)?.code).toBe("invalid_version");

    expect(
      (
        await patch({
          instructions: "Patched",
          instructionsVersion: versionOf(""),
        })
      ).status,
    ).toBe(200);
    expect(agentLayer.stored(o)).toBe("Patched");

    const stale = await patch({
      instructions: "Stale",
      instructionsVersion: versionOf(""),
    });
    expect(stale.status).toBe(409);
    expect(agentLayer.stored(o)).toBe("Patched");
  });

  it("POST /api/agents and the system prompt preview take instructions", async () => {
    const o = await office();
    const made = await call(o.srv, "POST", "/api/agents", {
      ...owner(o),
      body: {
        name: "Spawned",
        cwd: o.srv.stateRoot,
        roomId: o.roomId,
        desk: 1,
        permissionMode: "default",
        instructions: "Spawn text",
      },
    });
    expect(made.status).toBe(201);
    const id = (made.body as { agent: { id: string } }).agent.id;
    expect(o.srv.agentManager.getAgent(id)!.customInstructions).toBe(
      "Spawn text",
    );

    const shown = await call(
      o.srv,
      "POST",
      "/api/agents/system-prompt-preview",
      {
        ...owner(o),
        body: {
          roomId: o.roomId,
          name: "Draft",
          agentType: "claude",
          privileged: false,
          instructions: "Preview sentinel 4d1c",
        },
      },
    );
    expect(shown.status).toBe(200);
    expect((shown.body as { prompt: string }).prompt).toContain(
      "Preview sentinel 4d1c",
    );
  });

  it("GET /api/agents/:id/instructions answers with the text and its version only", async () => {
    const o = await office();
    expect(
      (
        await writeNew(o, agentLayer, {
          instructions: "One name",
          version: versionOf(""),
        })
      ).status,
    ).toBe(200);
    const r = await call(
      o.srv,
      "GET",
      `/api/agents/${o.agentId}/instructions`,
      owner(o),
    );
    expect(r.body).toEqual({
      instructions: "One name",
      version: versionOf("One name"),
    });
  });
});

describe("member instructions field on create", () => {
  it("POST /api/users takes instructions", async () => {
    const o = await office();
    expect(
      (
        await call(o.srv, "POST", "/api/users", {
          ...owner(o),
          body: {
            name: "Briefed",
            role: "member",
            instructions: "Member text",
          },
        })
      ).status,
    ).toBe(201);
    expect(getUserByName("Briefed")!.memberPrompt).toBe("Member text");
  });
});

// The old names of task 379ae5db, one release later (task 744fa64a).
describe("old routes and field names", () => {
  it("the old routes answer 404 like any unknown route, and write nothing", async () => {
    const o = await office();
    for (const [method, path, body] of [
      [
        "PUT",
        `/api/rooms/${o.roomId}/settings`,
        { prompt: "Old", version: "x" },
      ],
      ["GET", "/api/users/Mia/member-prompt", undefined],
      ["PUT", "/api/cron-prompt", { value: "Old" }],
    ] as const) {
      const r = await call(o.srv, method, path, { ...owner(o), body });
      expect([method, path, r.status, errOf(r)?.code]).toEqual([
        method,
        path,
        404,
        "not_found",
      ]);
    }
    expect(roomLayer.stored(o)).toBeNull();
    expect(cronLayer.stored(o)).toBeNull();
  });

  it("the reads that carried an old field no longer carry it", async () => {
    const o = await office();
    for (const layer of [roomLayer, agentLayer])
      expect(
        (
          await writeNew(o, layer, {
            instructions: "Stored",
            version: versionOf(""),
          })
        ).status,
      ).toBe(200);
    const room = await call(
      o.srv,
      "GET",
      `/api/rooms/${o.roomId}/settings`,
      owner(o),
    );
    // The room settings read keeps the room's look and folder.
    expect(room.status).toBe(200);
    expect(Object.keys(room.body as object)).not.toContain("prompt");
    expect(Object.keys(room.body as object)).not.toContain("version");
    const agent = await call(
      o.srv,
      "GET",
      `/api/agents/${o.agentId}/instructions`,
      owner(o),
    );
    expect(Object.keys(agent.body as object).sort()).toEqual([
      "instructions",
      "version",
    ]);
  });

  // Each write route that took an old field name. The refusal comes before
  // any other check, so a stale caller learns the new name first.
  it("a write that carries an old field name is refused with the new name, and writes nothing", async () => {
    const o = await office();
    const agentPatch = (body: Record<string, unknown>) =>
      call(o.srv, "PATCH", `/api/agents/${o.agentId}`, { ...owner(o), body });
    expect(
      (
        await agentPatch({
          instructions: "Agent kept",
          instructionsVersion: versionOf(""),
        })
      ).status,
    ).toBe(200);
    const memberSaved = await writeNew(o, memberLayer, {
      instructions: "Member kept",
      version: versionOf(""),
    });
    expect(memberSaved.status).toBe(200);
    const agents = o.srv.agentManager.getAllAgents().length;
    const spawnBody = {
      name: "Old spawn",
      cwd: o.srv.stateRoot,
      roomId: o.roomId,
      desk: 3,
      permissionMode: "default",
    };
    const preview = {
      roomId: o.roomId,
      name: "Draft",
      agentType: "claude",
      privileged: false,
    };
    const cases: [string, () => Promise<Res>][] = [
      [
        "PATCH agent customInstructions",
        () =>
          agentPatch({
            customInstructions: "Old",
            customInstructionsVersion: versionOf("Agent kept"),
          }),
      ],
      [
        "PATCH agent customInstructions without a version",
        () => agentPatch({ customInstructions: "Old" }),
      ],
      [
        "PATCH agent customInstructionsVersion with instructions",
        () =>
          agentPatch({
            instructions: "Old",
            customInstructionsVersion: versionOf("Agent kept"),
          }),
      ],
      [
        "PATCH agent customInstructions with a stale version",
        () =>
          agentPatch({
            customInstructions: "Old",
            customInstructionsVersion: versionOf(""),
          }),
      ],
      [
        "POST agent customInstructions",
        () =>
          call(o.srv, "POST", "/api/agents", {
            ...owner(o),
            body: { ...spawnBody, customInstructions: "Old" },
          }),
      ],
      [
        "preview customInstructions",
        () =>
          call(o.srv, "POST", "/api/agents/system-prompt-preview", {
            ...owner(o),
            body: { ...preview, customInstructions: "Old" },
          }),
      ],
      [
        "preview customInstructions with instructions",
        () =>
          call(o.srv, "POST", "/api/agents/system-prompt-preview", {
            ...owner(o),
            body: {
              ...preview,
              instructions: "New",
              customInstructions: "Old",
            },
          }),
      ],
      [
        "POST user memberPrompt",
        () =>
          call(o.srv, "POST", "/api/users", {
            ...owner(o),
            body: { name: "Old member", role: "member", memberPrompt: "Old" },
          }),
      ],
      [
        "PATCH user memberPrompt by an owner",
        () =>
          call(o.srv, "PATCH", "/api/users/Mia", {
            ...owner(o),
            body: {
              memberPrompt: "Old",
              memberPromptVersion: versionOf("Member kept"),
            },
          }),
      ],
      [
        "PATCH user memberPrompt by the member, with another field",
        () =>
          call(o.srv, "PATCH", "/api/users/Mia", {
            ...o.callers.memberSession,
            body: {
              avatarColor: "#123456",
              memberPrompt: "Old",
              memberPromptVersion: versionOf("Member kept"),
            },
          }),
      ],
    ];
    for (const [label, send] of cases) {
      const r = await send();
      expect([label, r.status, errOf(r)?.code]).toEqual([
        label,
        400,
        "invalid_request",
      ]);
      expect([label, errOf(r)?.message]).toEqual([
        label,
        expect.stringContaining("instructions"),
      ]);
    }
    expect(agentLayer.stored(o)).toBe("Agent kept");
    expect(memberLayer.stored(o)).toBe("Member kept");
    expect(getUserByName("Mia")!.avatarColor).not.toBe("#123456");
    expect(o.srv.agentManager.getAllAgents().length).toBe(agents);
    expect(getUserByName("Old member")).toBeUndefined();
  });

  it("an agent or API token edits no member record field at all", async () => {
    const o = await office();
    expect(
      (
        await writeNew(o, memberLayer, {
          instructions: "Member kept",
          version: versionOf(""),
        })
      ).status,
    ).toBe(200);
    const before = structuredClone(getUserByName("Mia")!);
    for (const [who, auth] of Object.entries(o.callers)) {
      if (who.endsWith("Session")) continue;
      for (const body of [
        { memberPrompt: "Old", memberPromptVersion: versionOf("Member kept") },
        { avatarColor: "#123456" },
      ]) {
        const r = await call(o.srv, "PATCH", "/api/users/Mia", {
          ...auth,
          body,
        });
        expect([who, body, r.status]).toEqual([who, body, 403]);
      }
    }
    expect(getUserByName("Mia")).toEqual(before);
  });
});
