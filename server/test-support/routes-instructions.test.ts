// Every instruction layer (office, room, agent, member, schedules) reads and
// writes its text at GET/PUT .../instructions with {instructions, version}
// (task 379ae5db). The old routes and field names stay for one release as
// aliases of the same store, the same version and the same auth.
//
// What this file pins, per layer:
//   - the read/write round trip: the PUT answers with the stored text and its
//     version, null and "" clear, and the write reaches the browsers live;
//   - a missing version is 400, a stale one 409 with the current version, and
//     neither writes;
//   - the old route and the new route are one store, and (except the office,
//     whose settings version also covers the name) one version;
//   - each caller gets the same answer on the new route as on the old one.
// Then the per-layer rules: the office's two versions, the member write that
// takes only the text, the agent and member field aliases.
//
// Seam: startTestServer() - real auth + /api executor + WS. Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";

import { versionOf } from "../../shared/blob-version.ts";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
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
  (r.body as { error?: { code?: string; version?: string } } | null)?.error;

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
    // Every kind of caller the old routes tell apart.
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

// The old route of one layer, as its callers use it today.
interface OldRoute {
  // null: the layer had no read route (schedules).
  read: ((o: Office, auth: Auth) => Promise<Res>) | null;
  text: (r: Res) => string | null;
  version: (r: Res) => string;
  // version undefined: the old write takes none (schedules).
  write: (
    o: Office,
    auth: Auth,
    text: string | null,
    version?: string,
  ) => Promise<Res>;
}

interface Layer {
  name: string;
  path: (o: Office) => string;
  stored: (o: Office) => string | null;
  // The WS event the old write sends, which the new write must send too.
  event: string;
  // A version read on the old route is valid on the new one.
  sameVersion: boolean;
  old: OldRoute;
}

const owner = (o: Office) => o.callers.ownerSession;

const officeLayer: Layer = {
  name: "office",
  path: () => "/api/office/instructions",
  stored: (o) => o.srv.agentManager.getOfficeSettings().prompt,
  event: "office_settings_updated",
  sameVersion: false,
  old: {
    read: (o, auth) => call(o.srv, "GET", "/api/office/settings", auth),
    text: (r) => (r.body as { prompt: string | null }).prompt,
    version: (r) => (r.body as { version: string }).version,
    write: (o, auth, text, version) =>
      call(o.srv, "PUT", "/api/office/settings", {
        ...auth,
        body: { prompt: text, version },
      }),
  },
};

const roomLayer: Layer = {
  name: "room",
  path: (o) => `/api/rooms/${o.roomId}/instructions`,
  stored: (o) =>
    o.srv.agentManager.getRooms().find((room) => room.id === o.roomId)!
      .prompt ?? null,
  event: "room_settings_updated",
  sameVersion: true,
  old: {
    read: (o, auth) =>
      call(o.srv, "GET", `/api/rooms/${o.roomId}/settings`, auth),
    text: (r) => (r.body as { prompt: string | null }).prompt,
    version: (r) => (r.body as { version: string }).version,
    write: (o, auth, text, version) =>
      call(o.srv, "PUT", `/api/rooms/${o.roomId}/settings`, {
        ...auth,
        body: { prompt: text, version },
      }),
  },
};

const agentLayer: Layer = {
  name: "agent",
  path: (o) => `/api/agents/${o.agentId}/instructions`,
  stored: (o) => o.srv.agentManager.getAgent(o.agentId)!.customInstructions,
  event: "agent_updated",
  sameVersion: true,
  old: {
    read: (o, auth) =>
      call(o.srv, "GET", `/api/agents/${o.agentId}/instructions`, auth),
    text: (r) =>
      (r.body as { customInstructions: string | null }).customInstructions,
    version: (r) =>
      (r.body as { customInstructionsVersion: string })
        .customInstructionsVersion,
    write: (o, auth, text, version) =>
      call(o.srv, "PATCH", `/api/agents/${o.agentId}`, {
        ...auth,
        body: { customInstructions: text, customInstructionsVersion: version },
      }),
  },
};

// The member layer's target is Mia, an ordinary member.
const memberLayer: Layer = {
  name: "member",
  path: () => "/api/users/Mia/instructions",
  stored: () => getUserByName("Mia")!.memberPrompt,
  // The owner's socket gets the full record; user_updated is the public one.
  event: "user_admin_updated",
  sameVersion: true,
  old: {
    read: (o, auth) => call(o.srv, "GET", "/api/users/Mia/member-prompt", auth),
    text: (r) => (r.body as { memberPrompt: string | null }).memberPrompt,
    version: (r) =>
      (r.body as { memberPromptVersion: string }).memberPromptVersion,
    write: (o, auth, text, version) =>
      call(o.srv, "PATCH", "/api/users/Mia", {
        ...auth,
        body: { memberPrompt: text, memberPromptVersion: version },
      }),
  },
};

const cronLayer: Layer = {
  name: "schedules",
  path: () => "/api/cron-instructions",
  stored: (o) => o.srv.cronjobManager.getCronjobsPrompt(),
  event: "cronjobs_prompt_updated",
  sameVersion: true,
  old: {
    read: null,
    text: () => null,
    version: () => "",
    write: (o, auth, text) =>
      call(o.srv, "PUT", "/api/cron-prompt", {
        ...auth,
        body: { value: text },
      }),
  },
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

    it("shares one store with the old route, and one version where the old version covers only the text", async () => {
      const o = await office();
      const read = layer.old.read;

      // Old write, new read.
      const v0 = read ? layer.old.version(await read(o, owner(o))) : undefined;
      const oldSaved = await layer.old.write(o, owner(o), "Old route", v0);
      expect(oldSaved.status).toBeLessThan(300);
      const viaNew = await readNew(o, layer);
      expect(viaNew.instructions).toBe("Old route");
      expect(viaNew.version).toBe(versionOf("Old route"));

      // New write, old read.
      expect(
        (
          await writeNew(o, layer, {
            instructions: "New route",
            version: viaNew.version,
          })
        ).status,
      ).toBe(200);
      if (read) {
        const viaOld = await read(o, owner(o));
        expect(layer.old.text(viaOld)).toBe("New route");
        if (layer.sameVersion) {
          // A version read on either route is valid on the other.
          expect(layer.old.version(viaOld)).toBe(versionOf("New route"));
          expect(
            (
              await writeNew(o, layer, {
                instructions: "Third",
                version: layer.old.version(viaOld),
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await layer.old.write(
                o,
                owner(o),
                "Fourth",
                (await readNew(o, layer)).version,
              )
            ).status,
          ).toBeLessThan(300);
          expect(layer.stored(o)).toBe("Fourth");
        }
      }
    });

    it("gives each caller the same answer on the new route as on the old one", async () => {
      const o = await office();
      const answers: Record<string, unknown> = {};
      // Every caller is authenticated, so a refusal is a 403, never a 401.
      const denied = (status: number) => {
        expect(status).not.toBe(401);
        return status === 403;
      };
      for (const [who, auth] of Object.entries(o.callers)) {
        // A stale version: an allowed write is a 409, and nothing changes.
        const oldWrite = layer.old.read
          ? await layer.old.write(o, auth, "x", "000000000000")
          : await layer.old.write(o, auth, null);
        const newWrite = await writeNew(
          o,
          layer,
          {
            instructions: "x",
            version: "000000000000",
          },
          auth,
        );
        const newRead = await call(o.srv, "GET", layer.path(o), auth);
        if (!denied(newWrite.status))
          expect([who, newWrite.status]).toEqual([who, 409]);
        if (!denied(newRead.status))
          expect([who, newRead.status]).toEqual([who, 200]);
        const oldRead = layer.old.read
          ? (await layer.old.read(o, auth)).status
          : undefined;
        answers[who] = {
          read: oldRead === undefined ? undefined : !denied(oldRead),
          write: !denied(oldWrite.status),
        };
        expect([who, !denied(newWrite.status)]).toEqual([
          who,
          !denied(oldWrite.status),
        ]);
        if (oldRead !== undefined)
          expect([who, !denied(newRead.status)]).toEqual([
            who,
            !denied(oldRead),
          ]);
        else
          // The schedules layer had no read: its read takes the write's auth.
          expect([who, !denied(newRead.status)]).toEqual([
            who,
            !denied(oldWrite.status),
          ]);
      }
      // The matrix tells callers apart: someone is allowed, someone is not.
      const writes = Object.values(answers).map(
        (a) => (a as { write: boolean }).write,
      );
      expect(writes).toContain(true);
      expect(writes).toContain(false);
      expect(layer.stored(o)).toBeNull();
    });
  },
);

describe("office instructions and office settings", () => {
  it("the instructions version covers only the text, and the settings version still covers the text", async () => {
    const o = await office();
    const settings = async () =>
      (await call(o.srv, "GET", "/api/office/settings", owner(o))).body as {
        prompt: string | null;
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

    // A text change moves the settings version, so a settings write made
    // from a read before it cannot overwrite the text unseen.
    const s1 = await settings();
    expect(
      (await writeNew(o, officeLayer, { instructions: "Rules", version: i0 }))
        .status,
    ).toBe(200);
    expect((await settings()).version).not.toBe(s1.version);
    const stale = await call(o.srv, "PUT", "/api/office/settings", {
      ...owner(o),
      body: { prompt: "Clobber", version: s1.version },
    });
    expect(stale.status).toBe(409);
    expect(officeLayer.stored(o)).toBe("Rules");

    // An instructions write changes the text and nothing else.
    const before = await settings();
    expect(
      (
        await writeNew(o, officeLayer, {
          instructions: "Only text",
          version: versionOf("Rules"),
        })
      ).status,
    ).toBe(200);
    const after = await settings();
    expect(after).toEqual({
      ...before,
      prompt: "Only text",
      version: after.version,
    });
    expect(after.name).toBe("Acme");
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

  it("reaches other members only with an owner's reach, as the old route does", async () => {
    const o = await office();
    const path = "/api/users/Morgan/instructions";
    const allowed: string[] = [];
    for (const [who, auth] of Object.entries(o.callers)) {
      const read = await call(o.srv, "GET", path, auth);
      const write = await call(o.srv, "PUT", path, {
        ...auth,
        body: { instructions: "x", version: "000000000000" },
      });
      const oldRead = await call(
        o.srv,
        "GET",
        "/api/users/Morgan/member-prompt",
        auth,
      );
      expect([who, read.status === 403]).toEqual([who, oldRead.status === 403]);
      expect([who, write.status === 403]).toEqual([who, read.status === 403]);
      expect([who, read.status]).not.toEqual([who, 401]);
      if (read.status !== 403) allowed.push(who);
    }
    expect(allowed.sort()).toEqual([
      "ownerApiToken",
      "ownerPrivilegedAgent",
      "ownerSession",
    ]);
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

describe("agent instructions field aliases", () => {
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

    // The new and the old name of one field together: refused, equal or not.
    for (const body of [
      {
        instructions: "Both",
        customInstructions: "Both",
        instructionsVersion: versionOf("Patched"),
      },
      {
        instructions: "Both",
        customInstructions: "Other",
        customInstructionsVersion: versionOf("Patched"),
      },
      {
        instructions: "Both",
        instructionsVersion: versionOf("Patched"),
        customInstructionsVersion: versionOf("Patched"),
      },
    ]) {
      const r = await patch(body);
      expect([body, r.status]).toEqual([body, 400]);
    }
    expect(agentLayer.stored(o)).toBe("Patched");
  });

  it("POST /api/agents and the system prompt preview take instructions", async () => {
    const o = await office();
    const spawn = (desk: number, fields: Record<string, unknown>) =>
      call(o.srv, "POST", "/api/agents", {
        ...owner(o),
        body: {
          name: `Spawned ${desk}`,
          cwd: o.srv.stateRoot,
          roomId: o.roomId,
          desk,
          permissionMode: "default",
          ...fields,
        },
      });
    const made = await spawn(1, { instructions: "Spawn text" });
    expect(made.status).toBe(201);
    const id = (made.body as { agent: { id: string } }).agent.id;
    expect(o.srv.agentManager.getAgent(id)!.customInstructions).toBe(
      "Spawn text",
    );
    const count = o.srv.agentManager.getAllAgents().length;
    const both = await spawn(2, {
      instructions: "Spawn text",
      customInstructions: "Spawn text",
    });
    expect(both.status).toBe(400);
    expect(o.srv.agentManager.getAllAgents().length).toBe(count);

    const draft = {
      roomId: o.roomId,
      name: "Draft",
      agentType: "claude",
      privileged: false,
    };
    const preview = (fields: Record<string, unknown>) =>
      call(o.srv, "POST", "/api/agents/system-prompt-preview", {
        ...owner(o),
        body: { ...draft, ...fields },
      });
    const shown = await preview({ instructions: "Preview sentinel 4d1c" });
    expect(shown.status).toBe(200);
    expect((shown.body as { prompt: string }).prompt).toContain(
      "Preview sentinel 4d1c",
    );
    expect(
      (
        await preview({
          instructions: "Preview sentinel 4d1c",
          customInstructions: "Preview sentinel 4d1c",
        })
      ).status,
    ).toBe(400);
  });

  it("GET /api/agents/:id/instructions answers in the new and the old names", async () => {
    const o = await office();
    expect(
      (
        await writeNew(o, agentLayer, {
          instructions: "Both names",
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
      instructions: "Both names",
      version: versionOf("Both names"),
      customInstructions: "Both names",
      customInstructionsVersion: versionOf("Both names"),
    });
  });
});

describe("member instructions field alias on create", () => {
  it("POST /api/users takes instructions, and refuses both names", async () => {
    const o = await office();
    const create = (body: unknown) =>
      call(o.srv, "POST", "/api/users", { ...owner(o), body });
    expect(
      (
        await create({
          name: "Briefed",
          role: "member",
          instructions: "Member text",
        })
      ).status,
    ).toBe(201);
    expect(getUserByName("Briefed")!.memberPrompt).toBe("Member text");
    const both = await create({
      name: "Twice",
      role: "member",
      instructions: "Member text",
      memberPrompt: "Member text",
    });
    expect(both.status).toBe(400);
    expect(getUserByName("Twice")).toBeUndefined();
  });
});
