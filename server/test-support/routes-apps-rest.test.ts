// Apps on the unified REST surface (opIds
// apps.{list,get,register,update,delete,logs,start,stop,restart}) - the
// agent-facing app registry and the supervisor behind it. See
// internal-docs/agent-apps-design.md.
//
// What these pin that the registry and supervisor unit tests cannot: the auth
// matrix (an ordinary AGENT token is enough, a cron-run token is not),
// ownership derived from the TOKEN rather than the body, the wire shape an
// agent actually reads the allocated port out of, and - the load-bearing one -
// the ORDER between the registry and the supervisor, since each has a step that
// cannot be undone.
//
// The supervisor is a FAKE (harness default). systemd is machine-global, so a
// test that reached the real one would write unit files on whatever box the
// suite runs on. Real-systemd coverage is the gated app-supervisor.live test.
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
import { APP_LOG_LINES_DEFAULT } from "../app-supervisor.ts";
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
    // Registering STARTS the app - no second call, no human confirm (the
    // design's "no approval click" ruling) - so the state it answers with is
    // the supervisor's, not a placeholder.
    expect(app.state).toBe("running");
    expect(app.restartCount).toBe(0);
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

describe("routes/apps REST: the registry and the supervisor, in order", () => {
  it("registering installs the app under its allocated port and data dir", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    const app = reg.body as AppWire;
    const installed = srv.appSupervisor.installed.get("hello");
    // The supervisor is handed the RECORD, so the port it puts in the unit is
    // the one the registry allocated and told the agent about - a second
    // allocation anywhere in this path would hand the agent a dead URL.
    expect(installed?.port).toBe(app.port);
    expect(installed?.dataDir).toBe(app.dataDir);
    expect(installed?.command).toBe("bun run serve.ts");
  });

  it("an app that installs and then dies is still registered, and says so", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);
    // systemd took the unit; the app's own process did not survive.
    srv.appSupervisor.installedState = { state: "failed", restartCount: 0 };

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    // 201, not an error: the registration really did happen, and `state` is
    // where the agent learns the app is not serving. Answering 500 here would
    // tell it the app does not exist while the name is taken forever.
    expect(reg.status).toBe(201);
    expect((reg.body as AppWire).state).toBe("failed");
  });

  it("a supervisor that refuses is still a 201, and says why on the record", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);
    srv.appSupervisor.failInstall = "systemd is not available";

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    // 201, not 500. The record is the commit point - undoing it would retire
    // the name forever - so the resource really was created, and answering 500
    // would invite a retry that can only ever be told the name is taken.
    expect(reg.status).toBe(201);
    const app = reg.body as AppWire;
    expect(app.state).not.toBe("running");
    // `state` alone cannot say WHY, and an agent cannot read the server log -
    // for an INSTALL failure there is not even a journald line yet - so the
    // reason rides on the record.
    expect(app.startError).toContain("systemd is not available");
    const list = await api(srv, "/api/apps", { bearer: token });
    expect((list.body as AppWire[])[0].startError).toContain(
      "systemd is not available",
    );
  });

  it("even a RAW filesystem failure stays a 201 with the app retained", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);
    // Not an AppSupervisorError: a plain fs error, the kind an unwritable unit
    // directory or a full disk produces. If it escapes as itself it becomes a
    // bare 500 for an app that WAS created, and the retry gets name_taken.
    srv.appSupervisor.throwRawOnInstall = new Error(
      "ENOSPC: no space left on device",
    );

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    expect(reg.status).toBe(201);
    expect((reg.body as AppWire).state).not.toBe("running");
    const list = await api(srv, "/api/apps", { bearer: token });
    expect((list.body as AppWire[]).map((a) => a.name)).toEqual(["hello"]);
  });

  it("a healthy app carries no startError at all", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    // Absent, not empty-string: the field means "an attempt failed", and a
    // present-but-blank value would read as a failure with no reason.
    expect((reg.body as AppWire).startError).toBeUndefined();
  });

  it("a delete that cannot stop the app does NOT retire its name", async () => {
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
    srv.appSupervisor.failTeardown = "the app is still running";

    const del = await api(srv, "/api/apps/hello", {
      method: "DELETE",
      bearer: token,
    });
    expect(del.status).toBe(500);
    expect(errCode(del)).toBe("supervisor_failed");
    // Still there, and still THE SAME registration: re-registering the name is
    // refused as taken, not as retired. The distinction is the whole test - a
    // tombstone written before the app was actually stopped would leave a live
    // process holding a port under a name nothing can reach any more.
    expect((await api(srv, "/api/apps/hello", { bearer: token })).status).toBe(
      200,
    );
    const again = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    expect(errCode(again)).toBe("name_taken");
  });

  it("a successful delete stops the app before the record goes", async () => {
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

    expect(
      (await api(srv, "/api/apps/hello", { method: "DELETE", bearer: token }))
        .status,
    ).toBe(204);
    expect(srv.appSupervisor.calls).toContain("teardown:hello");
    expect(srv.appSupervisor.installed.has("hello")).toBe(false);
  });

  it("state and restart count come from the supervisor on every read", async () => {
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
    // The app has been crash-looping since it was registered.
    srv.appSupervisor.setRuntime("hello", { state: "failed", restartCount: 7 });

    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect(got.body).toMatchObject({ state: "failed", restartCount: 7 });
    const list = await api(srv, "/api/apps", { bearer: token });
    expect((list.body as AppWire[])[0]).toMatchObject({
      state: "failed",
      restartCount: 7,
    });
  });

  it("an app the supervisor knows nothing about reads unknown, not stopped", async () => {
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
    // Somebody removed the unit by hand.
    srv.appSupervisor.installed.delete("hello");
    srv.appSupervisor.setRuntime("hello", {
      state: "unknown",
      restartCount: 0,
    });
    expect(
      (await api(srv, "/api/apps/hello", { bearer: token })).body,
    ).toMatchObject({ state: "unknown" });
  });

  it("keeps running across an isomux restart, with nothing re-installed", async () => {
    let srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, ownerId),
      body: body(srv, "hello"),
    });

    // A real cold boot against the state this run persisted. The supervisor
    // survives it the way systemd survives an isomux restart.
    srv = await srv.restart();
    server = srv;
    // Read as the OWNER: agent tokens are in-memory and die with the process,
    // which is exactly the asymmetry this test is about - the token did not
    // survive the restart and the app did.
    const after = await api(srv, "/api/apps/hello", {
      rawSessionId: owner.rawSessionId,
    });
    expect(after.status).toBe(200);
    expect((after.body as AppWire).state).toBe("running");
    // The point of using systemd at all: the app was never re-injected,
    // re-started, or re-installed by the boot.
    expect(
      srv.appSupervisor.calls.filter((c) => c.startsWith("install:")),
    ).toEqual(["install:hello"]);
  });
});

describe("routes/apps REST: the recovery verbs", () => {
  const seed = async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);
    await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    return { srv, token, owner };
  };

  it("stop, start and restart each answer with the app's fresh state", async () => {
    const { srv, token } = await seed();

    const stopped = await api(srv, "/api/apps/hello/stop", {
      method: "POST",
      bearer: token,
    });
    expect(stopped.status).toBe(200);
    // The fresh state, not 204: the caller asked for a change and the answer
    // is whether it happened, without a second round trip.
    expect((stopped.body as AppWire).state).toBe("stopped");

    const started = await api(srv, "/api/apps/hello/start", {
      method: "POST",
      bearer: token,
    });
    expect((started.body as AppWire).state).toBe("running");

    const restarted = await api(srv, "/api/apps/hello/restart", {
      method: "POST",
      bearer: token,
    });
    expect((restarted.body as AppWire).state).toBe("running");
    expect(srv.appSupervisor.calls).toContain("restart:hello");
  });

  it("recovers an app that came to rest in failed", async () => {
    // The reason these verbs exist: without them the only cure for a crash
    // loop is DELETE, which retires the app's name permanently.
    const { srv, token } = await seed();
    srv.appSupervisor.setRuntime("hello", { state: "failed", restartCount: 5 });

    const restarted = await api(srv, "/api/apps/hello/restart", {
      method: "POST",
      bearer: token,
    });
    expect((restarted.body as AppWire).state).toBe("running");
  });

  it("surfaces a refusal rather than reporting a change that did not happen", async () => {
    const { srv, token } = await seed();
    srv.appSupervisor.failAction = "Job for isomux-app-hello.service failed";

    const r = await api(srv, "/api/apps/hello/restart", {
      method: "POST",
      bearer: token,
    });
    expect(r.status).toBe(500);
    expect(errCode(r)).toBe("supervisor_failed");
  });

  it("are closed to another member, and never say whether a name exists", async () => {
    const { srv, owner } = await seed();
    const bob = await srv.seedMember("Bob");
    for (const verb of ["start", "stop", "restart"]) {
      expect(
        (
          await api(srv, `/api/apps/hello/${verb}`, {
            method: "POST",
            rawSessionId: bob.rawSessionId,
          })
        ).status,
      ).toBe(403);
      // Identical refusal for a name that was never registered: names are
      // permanently unique, so "is this one taken" is a question a denial must
      // not answer. The office owner is the one who gets a 404.
      expect(
        (
          await api(srv, `/api/apps/nope/${verb}`, {
            method: "POST",
            rawSessionId: bob.rawSessionId,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api(srv, `/api/apps/nope/${verb}`, {
            method: "POST",
            rawSessionId: owner.rawSessionId,
          })
        ).status,
      ).toBe(404);
    }
    // Nothing moved.
    expect(srv.appSupervisor.calls).not.toContain("stop:hello");
  });
});

describe("routes/apps REST: logs", () => {
  it("returns the app's journald tail, and defaults the line count", async () => {
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
    srv.appSupervisor.logLines = ["boot", "listening on 21000"];

    const r = await api(srv, "/api/apps/hello/logs", { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      name: "hello",
      lines: ["boot", "listening on 21000"],
    });
    expect(srv.appSupervisor.lastLogRequest?.lines).toBe(APP_LOG_LINES_DEFAULT);

    await api(srv, "/api/apps/hello/logs?lines=5", { bearer: token });
    expect(srv.appSupervisor.lastLogRequest?.lines).toBe(5);
  });

  it("refuses a nonsense line count rather than quietly using the default", async () => {
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

    // A junk SUFFIX is the one that a parseInt-based check waves through: it
    // reads 5 out of "5junk" and answers as if the caller had asked for 5.
    for (const bad of ["banana", "5junk", "-5", "0", "1.5", "", " 5"]) {
      const r = await api(
        srv,
        `/api/apps/hello/logs?lines=${encodeURIComponent(bad)}`,
        { bearer: token },
      );
      // Silently answering with the default would hide the bug in whatever
      // built the URL.
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("invalid_request");
    }
    // Too big is NOT nonsense: it is clamped inside the supervisor, which is
    // where the ceiling lives.
    const big = await api(srv, "/api/apps/hello/logs?lines=999999", {
      bearer: token,
    });
    expect(big.status).toBe(200);
  });

  it("are readable by the app's owner and an office owner, nobody else", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const aliceId = getUserByName("Alice")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, aliceId),
      body: body(srv, "alice-app"),
    });

    expect(
      (
        await api(srv, "/api/apps/alice-app/logs", {
          rawSessionId: alice.rawSessionId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(srv, "/api/apps/alice-app/logs", {
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(200);
    // An app's logs are its output: a member who cannot see the app must not
    // read what it printed.
    expect(
      (
        await api(srv, "/api/apps/alice-app/logs", {
          rawSessionId: bob.rawSessionId,
        })
      ).status,
    ).toBe(403);
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

// PATCH is the verb that keeps a mistyped command from costing a name forever,
// so what it must NOT do matters as much as what it does: it must not rename an
// app, must not move its port, must not bounce a running process over a
// description edit, and must not report a failed unit rewrite as a plain
// success when the record has in fact already changed.
describe("routes/apps REST: updating an app", () => {
  // One registered, running app owned by an agent, plus the pieces a test needs
  // to talk to it.
  async function withApp(name = "hello", over: Record<string, unknown> = {}) {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const token = mintAgentToken(bot.id, ownerId);
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, name, over),
    });
    expect(reg.status).toBe(201);
    srv.appSupervisor.calls.length = 0; // only the PATCH's calls from here
    return { srv, token, owner, app: reg.body as AppWire };
  }

  const patch = (
    srv: TestServer,
    name: string,
    body: unknown,
    bearer: string,
  ) => api(srv, `/api/apps/${name}`, { method: "PATCH", bearer, body });

  it("changes the command and brings the running app onto it", async () => {
    const { srv, token, app } = await withApp();

    const r = await patch(srv, "hello", { command: "bun run other.ts" }, token);
    expect(r.status).toBe(200);
    const updated = r.body as AppWire;
    expect(updated.command).toBe("bun run other.ts");
    // Identity untouched, which is the whole contract of this route.
    expect(updated.name).toBe(app.name);
    expect(updated.port).toBe(app.port);
    expect(updated.dataDir).toBe(app.dataDir);
    expect(updated.createdAt).toBe(app.createdAt);
    // The machine was told.
    expect(srv.appSupervisor.calls).toContain("reinstall:hello");
    expect(updated.state).toBe("running");
    // And it stuck: a fresh GET agrees.
    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect((got.body as AppWire).command).toBe("bun run other.ts");
  });

  it("leaves systemd alone for a description-only change", async () => {
    const { srv, token } = await withApp("hello", { description: "before" });

    const r = await patch(srv, "hello", { description: "after" }, token);
    expect(r.status).toBe(200);
    expect((r.body as AppWire).description).toBe("after");
    // Not a single supervisor call beyond the state read the response needs.
    // Editing a blurb must never bounce a running process.
    expect(
      srv.appSupervisor.calls.filter((c) => !c.startsWith("states:")),
    ).toEqual([]);
  });

  it('removes a description with null, and keeps an empty one with ""', async () => {
    const { srv, token } = await withApp("hello", { description: "before" });

    const emptied = await patch(srv, "hello", { description: "" }, token);
    expect((emptied.body as AppWire).description).toBe("");

    const cleared = await patch(srv, "hello", { description: null }, token);
    expect((cleared.body as AppWire).description).toBeUndefined();
    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect((got.body as AppWire).description).toBeUndefined();
  });

  it("does not touch systemd when the patch changes nothing that runs", async () => {
    const { srv, token, app } = await withApp();

    // Same command it already had. Nothing to reinstall, so nothing is
    // restarted - an idempotent PATCH must not be a way to bounce an app.
    const r = await patch(srv, "hello", { command: app.command }, token);
    expect(r.status).toBe(200);
    expect(srv.appSupervisor.calls).not.toContain("reinstall:hello");
  });

  it("refuses a rename or a port move, and changes nothing", async () => {
    const { srv, token, app } = await withApp();

    const bad = [
      { name: "goodbye" },
      { port: app.port + 1 },
      // Malformed is refused too, not quietly ignored. Presence is what
      // triggers the check: if it were a type test, each of these would slide
      // past as "not a rename" and the app would be updated anyway.
      { name: 7 },
      { name: null },
      { port: "21001" },
      { port: null },
    ];
    for (const attempt of bad) {
      const r = await patch(srv, "hello", { ...attempt, command: "x" }, token);
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("invalid_request");
    }
    // Refused BEFORE the registry write: the command it came with is intact.
    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect((got.body as AppWire).command).toBe(app.command);
  });

  it("accepts a body that echoes the app's own name and port back", async () => {
    const { srv, token, app } = await withApp();
    // The obvious way to use this route is GET, edit one field, PATCH the
    // object back - and that body carries name and port. Rejecting it would
    // punish the natural pattern for asking for nothing.
    const r = await patch(
      srv,
      "hello",
      { ...app, command: "bun run other.ts" },
      token,
    );
    expect(r.status).toBe(200);
    expect((r.body as AppWire).command).toBe("bun run other.ts");
  });

  it("refuses a patch that asks for nothing", async () => {
    const { srv, token } = await withApp();
    const r = await patch(srv, "hello", {}, token);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("invalid_request");
  });

  it("applies register's validation to the fields it changes", async () => {
    const { srv, token, app } = await withApp();

    const refusals: [unknown, string][] = [
      [{ command: 42 }, "invalid_command"],
      [{ command: "   " }, "invalid_command"],
      [{ cwd: "" }, "invalid_cwd"],
      [{ cwd: "/nope/definitely/not/here" }, "invalid_cwd"],
      [{ description: 7 }, "invalid_description"],
      [{ description: "d".repeat(201) }, "invalid_description"],
    ];
    for (const [patchBody, code] of refusals) {
      const r = await patch(srv, "hello", patchBody, token);
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe(code);
    }
    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect((got.body as AppWire).command).toBe(app.command);
    expect(srv.appSupervisor.calls).not.toContain("reinstall:hello");
  });

  it("expands ~/ in a patched cwd, the same as registration does", async () => {
    const { srv, token } = await withApp();
    const r = await patch(srv, "hello", { cwd: "~" }, token);
    expect(r.status).toBe(200);
    expect((r.body as AppWire).cwd.startsWith("/")).toBe(true);
  });

  it("denies an unknown name rather than confirming it is free", async () => {
    const { srv, token, owner } = await withApp();
    // 403, not 404, and deliberately: names are permanently unique, so a 404
    // here would answer "is this name still available" - a question only
    // registration is meant to answer. Same rule the read and delete routes
    // follow.
    expect((await patch(srv, "nope", { command: "x" }, token)).status).toBe(
      403,
    );
    // An office owner skips the owner lookup, so it reaches the handler and
    // gets the honest answer.
    expect(
      (
        await api(srv, "/api/apps/nope", {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: { command: "x" },
        })
      ).status,
    ).toBe(404);
  });

  it("still answers 200 when the unit rewrite fails, and says why", async () => {
    const { srv, token } = await withApp();
    srv.appSupervisor.failReinstall =
      "the app's files were updated but systemd could not be asked whether it was running";

    const r = await patch(srv, "hello", { command: "bun run other.ts" }, token);
    // NOT a 500: the record really did change, and a status saying otherwise
    // would describe an update that did not happen. The failure rides on the
    // body instead.
    expect(r.status).toBe(200);
    const updated = r.body as AppWire;
    expect(updated.command).toBe("bun run other.ts");
    expect(updated.startError).toContain("could not be asked");
    // The registry kept the change, so a retry (or a restart) can finish it.
    const got = await api(srv, "/api/apps/hello", { bearer: token });
    expect((got.body as AppWire).command).toBe("bun run other.ts");
  });

  it("stops reporting a stale reason once an update succeeds", async () => {
    const { srv, token } = await withApp();
    // Stopped, so the successful reinstall below takes the leave-it-alone
    // branch - the one where a remembered failure could most easily survive.
    await api(srv, "/api/apps/hello/stop", { method: "POST", bearer: token });
    srv.appSupervisor.failReinstall = "systemd could not be reached";

    const failed = await patch(srv, "hello", { command: "bun a.ts" }, token);
    expect((failed.body as AppWire).startError).toBe(
      "systemd could not be reached",
    );

    srv.appSupervisor.failReinstall = null;
    const fixed = await patch(srv, "hello", { command: "bun b.ts" }, token);
    // The app is where it was, and the reason for a call that has since
    // succeeded is gone rather than lingering on every later read.
    expect((fixed.body as AppWire).state).toBe("stopped");
    expect((fixed.body as AppWire).startError).toBeUndefined();
  });

  it("is app:write and owner-scoped, like every other change to an app", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const aliceId = getUserByName("Alice")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    await api(srv, "/api/apps", {
      method: "POST",
      bearer: mintAgentToken(bot.id, aliceId),
      body: body(srv, "alice-app"),
    });

    // A different member: denied.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          method: "PATCH",
          rawSessionId: bob.rawSessionId,
          body: { command: "bun run mine.ts" },
        })
      ).status,
    ).toBe(403);
    // A cron run holds neither app capability, so its token cannot either.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          method: "PATCH",
          bearer: mintRunToken("job-1", "run-1", aliceId),
          body: { command: "bun run mine.ts" },
        })
      ).status,
    ).toBe(403);
    // The owner of record and an office owner both can.
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          method: "PATCH",
          rawSessionId: alice.rawSessionId,
          body: { description: "mine" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(srv, "/api/apps/alice-app", {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: { description: "seen by the office owner" },
        })
      ).status,
    ).toBe(200);
  });
});
