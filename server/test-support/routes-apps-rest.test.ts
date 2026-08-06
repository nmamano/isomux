// Apps on the unified REST surface (opIds apps.{list,get,register,delete}) -
// the agent-facing app registry. See internal-docs/agent-apps-design.md.
//
// What these pin that the registry unit tests cannot: the auth matrix (an
// ordinary AGENT token is enough, a cron-run token is not), ownership derived
// from the TOKEN rather than the body, and the wire shape an agent actually
// reads the allocated port out of.
//
// The harness wipes STATE_ROOT on every boot and the registry holds no
// in-memory cache, so each test starts with an empty registry.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { APP_PORT_MIN, APP_PORT_MAX } from "../app-registry.ts";
import type { AppWire } from "../../shared/contract-shapes.ts";
import type { AgentInfo } from "../../shared/types.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}
async function api(
  srv: TestServer,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    rawSessionId?: string;
    bearer?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const errCode = (r: Res): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

async function spawnAgent(srv: TestServer, name: string): Promise<AgentInfo> {
  const roomId = srv.agentManager.getRooms()[0].id;
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
    undefined,
    "claude",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

// A registration body with a cwd that really exists on this box.
const body = (
  srv: TestServer,
  name: string,
  over: Record<string, unknown> = {},
) => ({
  name,
  command: "bun run serve.ts",
  cwd: srv.stateRoot,
  ...over,
});

describe("routes/apps REST: the register -> list -> get -> delete lifecycle", () => {
  it("an ordinary agent registers an app and is told its port and data dir", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello", { description: "a demo" }),
    });
    expect(reg.status).toBe(201);
    const app = reg.body as AppWire;
    // The agent never picked the port - that is the whole point of the
    // registry - so the response is where it learns it.
    expect(app.port).toBeGreaterThanOrEqual(APP_PORT_MIN);
    expect(app.port).toBeLessThanOrEqual(APP_PORT_MAX);
    expect(app.dataDir.startsWith(srv.stateRoot)).toBe(true);
    expect(app.state).toBe("registered");
    expect(app.name).toBe("hello");
    expect(app.description).toBe("a demo");

    const list = await api(srv, "/api/apps", { bearer: token });
    expect(list.status).toBe(200);
    expect((list.body as AppWire[]).map((a) => a.name)).toEqual(["hello"]);

    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect(got.status).toBe(200);
    expect(got.body).toEqual(app);

    const del = await api(srv, "/api/apps/hello", {
      method: "DELETE",
      bearer: token,
    });
    expect(del.status).toBe(204);
    expect((await api(srv, "/api/apps", { bearer: token })).body).toEqual([]);
  });

  it("a deleted app's name is refused forever, with a distinct code", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const first = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    expect(first.status).toBe(201);
    const port = (first.body as AppWire).port;
    await api(srv, "/api/apps/hello", { method: "DELETE", bearer: token });

    const again = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    // 409, and NOT the same code a live collision gives: "somebody has it" and
    // "nobody can ever have it again" are different facts and the agent is
    // meant to act differently on them.
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe("name_retired");

    // The retired PORT is burned too - a fresh app must not land on it.
    const next = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "second"),
    });
    expect(next.status).toBe(201);
    expect((next.body as AppWire).port).not.toBe(port);
  });

  it("a live name collision is 409 name_taken", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    const dup = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup)).toBe("name_taken");
  });

  it("two apps never share a port", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const ports: number[] = [];
    for (const name of ["one", "two", "three"]) {
      const r = await api(srv, "/api/apps", {
        method: "POST",
        bearer: token,
        body: body(srv, name),
      });
      expect(r.status).toBe(201);
      ports.push((r.body as AppWire).port);
    }
    expect(new Set(ports).size).toBe(3);
  });
});

describe("routes/apps REST: ownership comes from the token", () => {
  it("the app belongs to the agent's MANAGER, with the agent as attribution", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName(alice.username)!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, aliceId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      // A body that TRIES to claim a different owner. These fields are not part
      // of the request shape and must not be honoured - otherwise any caller
      // could register an app onto somebody else.
      body: body(srv, "hello", {
        userId: "u-somebody-else",
        username: "Boss",
        createdBy: "Boss",
      }),
    });
    expect(reg.status).toBe(201);
    const app = reg.body as AppWire;
    expect(app.userId).toBe(aliceId);
    expect(app.username).toBe("Alice");
    expect(app.createdBy).toBe("AppBot");
    // Recorded so the app can message its author later; the app still outlives
    // the agent, which is why ownership above is the USER's.
    expect(app.createdByAgentId).toBe(bot.id);
  });

  it("a human registering through the UI owns the app themselves", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "hello"),
    });
    expect(reg.status).toBe(201);
    const app = reg.body as AppWire;
    expect(app.userId).toBe(ownerId);
    expect(app.createdBy).toBe("Boss");
    expect(app.createdByAgentId).toBeUndefined();
  });
});

describe("routes/apps REST: who can see and delete an app", () => {
  it("another member cannot read or delete it; its owner and an office owner can", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const aliceId = getUserByName("Alice")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const aliceToken = mintAgentToken(bot.id, aliceId);

    expect(
      (
        await api(srv, "/api/apps", {
          method: "POST",
          bearer: aliceToken,
          body: body(srv, "alice-app"),
        })
      ).status,
    ).toBe(201);

    // Owner of record.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          rawSessionId: alice.rawSessionId,
        })
      ).status,
    ).toBe(200);
    // Office owner reaches every app (the cronjob rule).
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
    // A different member: denied on read AND on delete.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          rawSessionId: bob.rawSessionId,
        })
      ).status,
    ).toBe(403);
    const bobDelete = await api(srv, "/api/apps/alice-app", {
      method: "DELETE",
      rawSessionId: bob.rawSessionId,
    });
    expect(bobDelete.status).toBe(403);
    // ...and the app is untouched.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          rawSessionId: alice.rawSessionId,
        })
      ).status,
    ).toBe(200);
  });

  it("list shows a member only their own apps, and an office owner all of them", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const aliceId = getUserByName("Alice")!.id;
    const bot = await spawnAgent(srv, "AppBot");

    await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, aliceId),
      body: body(srv, "alice-app"),
    });
    await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "boss-app"),
    });

    const aliceList = await api(srv, "/api/apps", {
      rawSessionId: alice.rawSessionId,
    });
    expect((aliceList.body as AppWire[]).map((a) => a.name)).toEqual([
      "alice-app",
    ]);
    const ownerList = await api(srv, "/api/apps", {
      rawSessionId: owner.rawSessionId,
    });
    expect((ownerList.body as AppWire[]).map((a) => a.name).sort()).toEqual([
      "alice-app",
      "boss-app",
    ]);
  });

  it("an unknown name denies exactly like somebody else's app (no existence oracle)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bob = await srv.seedMember("Bob");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");

    await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, ownerId),
      body: body(srv, "boss-app"),
    });

    const taken = await api(srv, "/api/apps/boss-app", {
      rawSessionId: bob.rawSessionId,
    });
    const free = await api(srv, "/api/apps/never-registered", {
      rawSessionId: bob.rawSessionId,
    });
    // Byte-identical: names are permanently unique, so "is this name taken" is
    // a question a denial must not answer.
    expect(taken.status).toBe(free.status);
    expect(errCode(taken)).toBe(errCode(free));
    // The office owner is the one who can tell them apart.
    expect(
      (
        await api(srv, "/api/apps/never-registered", {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(404);
  });
});

describe("routes/apps REST: auth wall", () => {
  it("anonymous is 401; a cron-run token is refused", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;

    const anon = await api(srv, "/api/apps");
    expect(anon.status).toBe(401);

    // A cron run holds neither app capability: it is a fresh unattended session
    // with no chat and nobody to hand a URL to.
    const runToken = mintRunToken("job-1", "run-1", ownerId);
    expect((await api(srv, "/api/apps", { bearer: runToken })).status).toBe(
      403,
    );
    expect(
      (
        await api(srv, "/api/apps", {
          method: "POST",
          bearer: runToken,
          body: body(srv, "cron-app"),
        })
      ).status,
    ).toBe(403);
  });
});

describe("routes/apps REST: an app must have an owner", () => {
  it("an agent token with a NULL userId cannot register, and registers nothing", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const bot = await spawnAgent(srv, "AppBot");
    // mintAgentToken's userId is nullable, so this token is a real shape, not a
    // hypothetical one. The app it would create would belong to nobody: its
    // own creator could not read or delete it (owner-match needs a non-null
    // userId), leaving only an office owner able to clean it up.
    const ownerless = mintAgentToken(bot.id, null);

    const r = await api(srv, "/api/apps", {
      method: "POST",
      bearer: ownerless,
      body: body(srv, "ownerless"),
    });
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe("forbidden");

    // Nothing was written - checked as the OFFICE OWNER, who would see the app
    // regardless of who owned it.
    const all = await api(srv, "/api/apps", {
      rawSessionId: owner.rawSessionId,
    });
    expect(all.body).toEqual([]);
  });
});

describe("routes/apps REST: registration validation", () => {
  it("rejects bad names, reserved names, and an unusable cwd - each with its own code", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const post = (b: unknown) =>
      api(srv, "/api/apps", { method: "POST", bearer: token, body: b });

    for (const bad of [
      "My_App",
      "-lead",
      "trail-",
      "has space",
      "dot.name",
      "",
    ]) {
      const r = await post(body(srv, bad));
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("invalid_name");
    }

    const reserved = await post(body(srv, "api"));
    expect(reserved.status).toBe(400);
    expect(errCode(reserved)).toBe("reserved_name");

    const noCommand = await post({ name: "ok-name", cwd: srv.stateRoot });
    expect(noCommand.status).toBe(400);
    expect(errCode(noCommand)).toBe("invalid_command");

    const noCwd = await post({ name: "ok-name", command: "bun run x.ts" });
    expect(noCwd.status).toBe(400);
    expect(errCode(noCwd)).toBe("invalid_cwd");

    // A cwd that does not exist is caught at registration, not left for the
    // supervisor to discover later.
    const badCwd = await post(
      body(srv, "ok-name", { cwd: "/nope/definitely/not/here" }),
    );
    expect(badCwd.status).toBe(400);
    expect(errCode(badCwd)).toBe("invalid_cwd");

    // None of the refusals registered anything.
    expect((await api(srv, "/api/apps", { bearer: token })).body).toEqual([]);
  });

  it("expands ~/ in cwd and stores it resolved", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");

    const r = await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, ownerId),
      body: body(srv, "tilde", { cwd: "~" }),
    });
    expect(r.status).toBe(201);
    const app = r.body as AppWire;
    expect(app.cwd.startsWith("~")).toBe(false);
    expect(app.cwd.startsWith("/")).toBe(true);
  });
});
