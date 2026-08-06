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
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { mintAgentToken, mintRunToken } from "../identity/tokens.ts";
import { createAppTokenStore } from "../app-tokens.ts";
import { createAppMessageLimiter } from "../app-message-limits.ts";
import { STATE_ROOT } from "../config.ts";
import { getUserByName } from "../users.ts";
import { APP_PORT_MIN, APP_PORT_MAX } from "../app-registry.ts";
import { APP_LOG_LINES_DEFAULT } from "../app-supervisor.ts";
import type { AppWire } from "../../shared/contract-shapes.ts";
import type { AgentInfo, AppRecord } from "../../shared/types.ts";
import { appsHandlers, type AppsDeps } from "../routes/handlers/apps.ts";
import type { RouteHandlerContext } from "../routes/executor.ts";

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

  it("a delete frees the name AND the port for the next registration", async () => {
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

    // The same name, end to end through the route: 201, not a refusal.
    const again = await api(srv, "/api/apps", {
      method: "POST",
      bearer: token,
      body: body(srv, "hello"),
    });
    expect(again.status).toBe(201);
    // ...on the same port, because the gap the delete left is the lowest free
    // one. The port going back in the pool is the half a name check cannot see.
    expect((again.body as AppWire).port).toBe(port);
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
    // tell it the app does not exist while the name is taken.
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
    // 201, not 500. The record is the commit point, so the resource really was
    // created, and answering 500 would invite a retry that can only ever be
    // told the name is taken.
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

  it("a delete that cannot stop the app does NOT free its name", async () => {
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
    // refused as taken. That is the whole test - a record removed before the
    // app was actually stopped would leave a live process holding a port under
    // a name the registry has forgotten, and hand both to whoever asks next.
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
    // loop is DELETE, which costs the app its port and its data directory.
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
      // unique across the office, so "is this one taken" is a question a denial
      // must not answer. The office owner is the one who gets a 404.
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
    // Byte-identical: names are unique across the office, so "is this name
    // taken" is a question a denial must not answer.
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

// PATCH is the verb that keeps a mistyped command from costing an app its
// address and its data,
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
    // 403, not 404, and deliberately: names are unique office-wide, so a 404
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

// --- The WS fan-out (S3) ----------------------------------------------------
// A mutation announces the app to every socket that may see it and NOTHING to
// the rest. The audience is ownership-based (the app's user, plus office
// owners), so the negative assertions carry as much weight as the positive
// ones: an app_deleted naming an app you were never entitled to see is the same
// leak the REST 404 avoids.
//
// The rule itself is unit-tested exhaustively in server/events/app-delta.test.ts.
// What these add is that the LOOP honors it over real sockets, and that the
// announced payload is the one the caller was handed.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2000,
  label = "cond",
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await sleep(10);
  }
}

const appUpsertsOf = (s: TestSocket): AppWire[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "app_upserted")
    .map((m) => (m as { app: AppWire }).app);

const appDeletesOf = (s: TestSocket): string[] =>
  s.messages
    .filter((m) => (m as { type?: string }).type === "app_deleted")
    .map((m) => (m as { name: string }).name);

describe("routes/apps REST: per-recipient WS fan-out", () => {
  it("register announces to the owning user and to office owners, and to nobody else", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const ownerSock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const aliceSock: TestSocket = await srv.connectWs(alice.rawSessionId);
    const bobSock: TestSocket = await srv.connectWs(bob.rawSessionId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
      body: body(srv, "alice-app"),
    });
    expect(reg.status).toBe(201);

    await waitUntil(
      () => appUpsertsOf(aliceSock).some((a) => a.name === "alice-app"),
      2000,
      "alice sees her own app",
    );
    await waitUntil(
      () => appUpsertsOf(ownerSock).some((a) => a.name === "alice-app"),
      2000,
      "office owner sees every app",
    );

    // Bob hears nothing. Ordering is what makes this a real assertion rather
    // than a race: the fan-out is ONE synchronous loop over the sockets, so by
    // the time Alice's and the owner's frames have arrived, Bob's would have
    // been sent too if the rule had produced one for him.
    expect(appUpsertsOf(bobSock)).toHaveLength(0);
    expect(appDeletesOf(bobSock)).toHaveLength(0);
  });

  it("announces the SAME wire object the caller was handed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "twin", { description: "a demo" }),
    });
    await waitUntil(() => appUpsertsOf(sock).length > 0, 2000, "announced");
    // Response body and wire payload are built from ONE `wire` const in the
    // handler; this is what would catch a future refactor rebuilding either.
    expect(appUpsertsOf(sock)[0]).toEqual(reg.body as AppWire);
  });

  it("start, stop and restart each announce the app's fresh state", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
    await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "verbs"),
    });
    await waitUntil(() => appUpsertsOf(sock).length === 1, 2000, "registered");

    for (const verb of ["stop", "start", "restart"]) {
      const before = appUpsertsOf(sock).length;
      const res = await api(srv, `/api/apps/verbs/${verb}`, {
        method: "POST",
        rawSessionId: owner.rawSessionId,
      });
      expect(res.status).toBe(200);
      await waitUntil(
        () => appUpsertsOf(sock).length === before + 1,
        2000,
        `${verb} announced`,
      );
      const announced = appUpsertsOf(sock).at(-1)!;
      expect(announced.state).toBe((res.body as AppWire).state);
    }
    // stop -> stopped, start -> running, restart -> running: the announced
    // state tracks the verb rather than repeating the registration snapshot.
    const states = appUpsertsOf(sock).map((a) => a.state);
    expect(states.slice(1)).toEqual(["stopped", "running", "running"]);
  });

  it("a description-only update announces, and delete announces just the name", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const alice = await srv.seedMember("Alice");
    const bob = await srv.seedMember("Bob");
    const ownerSock: TestSocket = await srv.connectWs(owner.rawSessionId);
    const aliceSock: TestSocket = await srv.connectWs(alice.rawSessionId);
    const bobSock: TestSocket = await srv.connectWs(bob.rawSessionId);
    await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: alice.rawSessionId,
      body: body(srv, "alice-app"),
    });
    await waitUntil(() => appUpsertsOf(ownerSock).length === 1, 2000, "reg");

    const patched = await api(srv, "/api/apps/alice-app", {
      method: "PATCH",
      rawSessionId: alice.rawSessionId,
      body: { description: "now with a blurb" },
    });
    expect(patched.status).toBe(200);
    await waitUntil(
      () => appUpsertsOf(ownerSock).length === 2,
      2000,
      "patch announced",
    );
    expect(appUpsertsOf(ownerSock)[1].description).toBe("now with a blurb");

    const del = await api(srv, "/api/apps/alice-app", {
      method: "DELETE",
      rawSessionId: alice.rawSessionId,
    });
    expect(del.status).toBe(204);
    await waitUntil(
      () => appDeletesOf(ownerSock).includes("alice-app"),
      2000,
      "delete announced to the office owner",
    );
    // And to the app's OWN user, which is the audience the delete announcement
    // exists for: without it Alice's tab keeps showing an app that is gone.
    await waitUntil(
      () => appDeletesOf(aliceSock).includes("alice-app"),
      2000,
      "delete announced to the owning user",
    );
    // Bob was never entitled to the app, so he is not told it went away either
    // - a delete naming it would be the oracle the whole rule exists to deny.
    expect(appDeletesOf(bobSock)).toHaveLength(0);
    expect(appUpsertsOf(bobSock)).toHaveLength(0);
  });

  it("announces nothing for a refusal: unknown names and a verb that threw", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
    await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "real"),
    });
    await waitUntil(() => appUpsertsOf(sock).length === 1, 2000, "registered");

    // Unknown name on every shape of route.
    for (const [path, method] of [
      ["/api/apps/ghost/start", "POST"],
      ["/api/apps/ghost", "DELETE"],
      ["/api/apps/ghost", "PATCH"],
    ] as const) {
      const res = await api(srv, path, {
        method,
        rawSessionId: owner.rawSessionId,
        ...(method === "PATCH" ? { body: { description: "x" } } : {}),
      });
      expect(res.status).toBe(404);
    }
    // A validation refusal on a real app.
    expect(
      (
        await api(srv, "/api/apps/real", {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: {},
        })
      ).status,
    ).toBe(400);

    // A verb the machine refused: it changed nothing, so it announces nothing.
    srv.appSupervisor.failAction = "systemd could not be reached";
    expect(
      (
        await api(srv, "/api/apps/real/start", {
          method: "POST",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBe(500);
    srv.appSupervisor.failAction = null;

    // A later real mutation proves the socket was still listening throughout,
    // so the silence above is silence and not a dead connection.
    await api(srv, "/api/apps/real/stop", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
    });
    await waitUntil(() => appUpsertsOf(sock).length === 2, 2000, "stop lands");
    expect(appDeletesOf(sock)).toHaveLength(0);
  });

  it("a register whose supervisor failed still announces - the record committed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const sock: TestSocket = await srv.connectWs(owner.rawSessionId);
    srv.appSupervisor.failInstall = "no systemd here";

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: body(srv, "doomed"),
    });
    // 201: the registration really happened. The office is told the truthful
    // result - the app exists and is not running - rather than nothing at all,
    // which would leave every other tab showing no app where one now exists.
    expect(reg.status).toBe(201);
    await waitUntil(() => appUpsertsOf(sock).length === 1, 2000, "announced");
    const announced = appUpsertsOf(sock)[0];
    expect(announced.name).toBe("doomed");
    expect(announced.state).not.toBe("running");
    expect(announced.startError).toBe("no systemd here");
  });
});

// --- App tokens (S5) --------------------------------------------------------
//
// End to end, because the properties only exist end to end: the token is minted
// where the app is registered, delivered through the supervisor's environment
// file, persisted as a hash that outlives the process, and it must reach NO
// route in the office. The supervisor is the harness fake, so `tokenFiles`
// stands in for <launcherDir>/<name>.env.

describe("routes/apps REST: app tokens", () => {
  // The office's own store, over the harness STATE_ROOT the server booted on.
  const officeTokens = () =>
    createAppTokenStore({ dir: join(STATE_ROOT, "apps") });

  async function registerApp(
    srv: TestServer,
    name = "hello",
  ): Promise<{ bearer: string; app: AppWire; raw: string }> {
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const bearer = mintAgentToken(bot.id, ownerId);
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer,
      body: body(srv, name),
    });
    expect(reg.status).toBe(201);
    const raw = srv.appSupervisor.tokenFiles.get(name);
    if (!raw) throw new Error("the app was registered without a token");
    return { bearer, app: reg.body as AppWire, raw };
  }

  it("registering an app delivers a token to it and persists only the hash", async () => {
    const srv = await startTestServer();
    server = srv;
    const { app, raw } = await registerApp(srv);

    // Delivered as the environment file the unit reads...
    expect(raw.length).toBeGreaterThan(20);
    // ...persisted as a hash, and NEVER as the plaintext.
    const stored = readFileSync(
      join(STATE_ROOT, "apps", "app-tokens.json"),
      "utf-8",
    );
    expect(stored).not.toContain(raw);
    expect(officeTokens().lookup(raw)?.appName).toBe("hello");

    // ...and nothing about it is on the wire, to the caller or to the office.
    expect(JSON.stringify(app)).not.toContain(raw);
    expect(Object.keys(app).some((k) => /token/i.test(k))).toBe(false);
  });

  it("the token is provisioned BEFORE the app starts", async () => {
    // A process's environment is fixed at exec, so a token written after the
    // start would not reach the app until something restarted it.
    const srv = await startTestServer();
    server = srv;
    await registerApp(srv);
    const calls = srv.appSupervisor.calls;
    expect(calls.indexOf("provisionToken:hello")).toBeLessThan(
      calls.indexOf("install:hello"),
    );
  });

  it("SURVIVES an isomux restart, without rotating or rewriting anything", async () => {
    // The property agent tokens do not have and app tokens must: an app keeps
    // running across a restart, so the token it was started with has to keep
    // working. A rotation here would mean rewriting every unit at boot - the
    // exact thing persistence exists to avoid.
    let srv = await startTestServer();
    server = srv;
    const { raw } = await registerApp(srv);

    // The supervisor instance is carried across the restart on purpose (systemd
    // outlives isomux), so what the reboot did is everything AFTER this mark.
    const before = srv.appSupervisor.calls.length;
    srv = await srv.restart(); // real cold boot against the same state dir
    server = srv;

    expect(officeTokens().lookup(raw)?.appName).toBe("hello");
    // Still the same plaintext in the app's environment file, and boot touched
    // nothing: reconciliation hashed it, found the pair healthy, and left it.
    expect(srv.appSupervisor.tokenFiles.get("hello")).toBe(raw);
    // Only the boot reload: the pair was healthy and the unit wired, so
    // nothing was rewritten, rotated or activated.
    expect(srv.appSupervisor.calls.slice(before)).toEqual(["reloadUnits"]);
  });

  it("gives a token at boot to an app that has none, without restarting it", async () => {
    // The pre-token app: a record on disk whose unit has no reference to an
    // environment file at all. Simulated by taking both halves away from a
    // registered app - the state a self-hoster who upgrades mid-flight has.
    let srv = await startTestServer();
    server = srv;
    await registerApp(srv);
    rmSync(join(STATE_ROOT, "apps", "app-tokens.json"), { force: true });
    srv.appSupervisor.tokenFiles.clear();
    // ...and its unit predates tokens too, so it references no token file. All
    // three facts absent is what a self-hoster who upgrades mid-flight has.
    srv.appSupervisor.unitsInjectingToken.clear();

    const before = srv.appSupervisor.calls.length;
    srv = await srv.restart();
    server = srv;

    const raw = srv.appSupervisor.tokenFiles.get("hello");
    expect(raw).toBeTruthy();
    expect(officeTokens().lookup(raw!)?.appName).toBe("hello");
    // The unit is rewritten so it REFERENCES the new file - a pre-token unit
    // would otherwise inject nothing and look healthy forever after - and
    // nothing is started, stopped or restarted: a running app keeps serving
    // and picks the token up on its next restart.
    const did = srv.appSupervisor.calls.slice(before);
    expect(did).toEqual([
      "reloadUnits",
      "regenerate:hello",
      "provisionToken:hello",
    ]);
  });

  it("drops the token of an app that was deleted while isomux was down", async () => {
    let srv = await startTestServer();
    server = srv;
    const { raw } = await registerApp(srv);
    // The delete's own revoke is what normally does this; here the record goes
    // and the hash is left behind, which is what a delete that died midway
    // leaves on disk.
    writeFileSync(join(STATE_ROOT, "apps", "apps.json"), "[]");

    srv = await srv.restart();
    server = srv;
    expect(officeTokens().lookup(raw)).toBeNull();
  });

  it("recovers the unit of an app whose install failed, keeping the SAME token", async () => {
    // The sharp edge: registration provisions the token BEFORE it installs (a
    // process's environment is fixed at exec), and an install failure keeps the
    // token on purpose. That leaves a perfectly healthy hash-plus-file pair
    // behind a unit that was never written - and if boot reconciliation trusted
    // the pair alone, the app would stay stranded until somebody PATCHed it.
    let srv = await startTestServer();
    server = srv;
    srv.appSupervisor.failInstall = "no systemd here";
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const bearer = mintAgentToken(bot.id, ownerId);
    expect(
      (
        await api(srv, "/api/apps", {
          method: "POST",
          bearer,
          body: body(srv, "hello"),
        })
      ).status,
    ).toBe(201);
    const raw = srv.appSupervisor.tokenFiles.get("hello")!;
    expect(srv.appSupervisor.unitInjectsToken("hello")).toBe(false);

    srv.appSupervisor.failInstall = null; // the transient failure is over
    const before = srv.appSupervisor.calls.length;
    srv = await srv.restart();
    server = srv;

    // The unit is written, and NOTHING else: no install, no enable, no start.
    expect(srv.appSupervisor.calls.slice(before)).toEqual([
      "reloadUnits",
      "regenerate:hello",
    ]);
    expect(srv.appSupervisor.unitInjectsToken("hello")).toBe(true);
    // The token that was already good is preserved, not rotated - the app's
    // running process (if it had one) would still hold a valid one.
    expect(srv.appSupervisor.tokenFiles.get("hello")).toBe(raw);
    expect(officeTokens().lookup(raw)?.appName).toBe("hello");
  });

  it("reloads systemd at boot when an install died at the daemon-reload stage", async () => {
    // The stage the other test cannot reach: the launcher and unit ARE written
    // (so the unit references the token file) and the install then fails at
    // daemon-reload. Every on-disk fact is now perfect and systemd has never
    // read the unit - so the pair check, the wired check, and any amount of
    // regenerating would all agree the app is fine. The only thing that fixes
    // it is asking systemd to re-read, which is why boot does that first.
    let srv = await startTestServer();
    server = srv;
    srv.appSupervisor.failInstallAfterFiles = "daemon-reload refused";
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const bearer = mintAgentToken(bot.id, ownerId);
    expect(
      (
        await api(srv, "/api/apps", {
          method: "POST",
          bearer,
          body: body(srv, "hello"),
        })
      ).status,
    ).toBe(201);
    const raw = srv.appSupervisor.tokenFiles.get("hello")!;
    expect(srv.appSupervisor.unitInjectsToken("hello")).toBe(true);

    const before = srv.appSupervisor.calls.length;
    srv = await srv.restart();
    server = srv;

    // Exactly the reload: no rotation, no regeneration, and nothing activated.
    expect(srv.appSupervisor.calls.slice(before)).toEqual(["reloadUnits"]);
    expect(srv.appSupervisor.tokenFiles.get("hello")).toBe(raw);
    expect(officeTokens().lookup(raw)?.appName).toBe("hello");
  });

  it("an update preserves the token; a delete revokes it", async () => {
    const srv = await startTestServer();
    server = srv;
    const { bearer, raw } = await registerApp(srv);

    const patched = await api(srv, "/api/apps/hello", {
      method: "PATCH",
      bearer,
      body: { command: "bun run other.ts" },
    });
    expect(patched.status).toBe(200);
    expect(srv.appSupervisor.tokenFiles.get("hello")).toBe(raw);
    expect(officeTokens().lookup(raw)?.appName).toBe("hello");

    const deleted = await api(srv, "/api/apps/hello", {
      method: "DELETE",
      bearer,
    });
    expect(deleted.status).toBe(204);
    expect(officeTokens().lookup(raw)).toBeNull();
    expect(srv.appSupervisor.tokenFiles.has("hello")).toBe(false);
  });

  it("registration succeeds even when the token cannot be delivered - and leaves no half-token", async () => {
    const srv = await startTestServer();
    server = srv;
    srv.appSupervisor.failProvisionToken = "no room on the disk";
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const bearer = mintAgentToken(bot.id, ownerId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer,
      body: body(srv, "hello"),
    });
    // The app is what the caller asked for; a token it could not be given is
    // one missing capability, not a failed registration.
    expect(reg.status).toBe(201);
    expect((reg.body as AppWire).state).toBe("running");
    // And the hash was taken back rather than left behind: isomux cannot
    // reproduce a plaintext it does not keep, so a hash with no file is an app
    // that can never authenticate AND cannot be repaired.
    expect(officeTokens().names()).toEqual([]);
  });

  it("keeps the token when the app itself fails to install", async () => {
    const srv = await startTestServer();
    server = srv;
    srv.appSupervisor.failInstall = "no systemd here";
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const bearer = mintAgentToken(bot.id, ownerId);

    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer,
      body: body(srv, "hello"),
    });
    expect(reg.status).toBe(201);
    // The pair is intact - the token is fine, the app simply is not running,
    // and the start verb is the cure. Revoking here would punish a healthy
    // credential for an unrelated failure.
    const raw = srv.appSupervisor.tokenFiles.get("hello")!;
    expect(officeTokens().lookup(raw)?.appName).toBe("hello");
  });
});

describe("routes/apps REST: an app token reaches nothing", () => {
  async function appToken(srv: TestServer): Promise<string> {
    await srv.seedOwner("Boss");
    const ownerId = getUserByName("Boss")!.id;
    const bot = await spawnAgent(srv, "AppBot");
    const agentToken = mintAgentToken(bot.id, ownerId);
    const reg = await api(srv, "/api/apps", {
      method: "POST",
      bearer: agentToken,
      body: body(srv, "hello"),
    });
    expect(reg.status).toBe(201);
    return srv.appSupervisor.tokenFiles.get("hello")!;
  }

  it("is a REAL identity - 403 where a garbage token gets 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = await appToken(srv);
    // The distinction is the whole evidence that the token resolved: isomux
    // knows whose it is and allows it nothing.
    expect((await api(srv, "/api/apps", { bearer: raw })).status).toBe(403);
    expect(
      (await api(srv, "/api/apps", { bearer: "not-a-real-token" })).status,
    ).toBe(401);
  });

  it("is denied on its own app, on the task board, and on a route asking only for an identity", async () => {
    const srv = await startTestServer();
    server = srv;
    const raw = await appToken(srv);
    for (const path of [
      "/api/apps/hello", // its own app - ownership is not authority
      "/api/tasks",
      "/api/version", // `authenticated`, no capability: the guard is the gate
      "/api/memory?scope=office",
    ]) {
      expect((await api(srv, path, { bearer: raw })).status).toBe(403);
    }
  });

  it("cannot read an agent's instructions, though it carries its owner's user id", async () => {
    // The confused-deputy case: GuardDeps.hasRoomAccess keys on userId, and an
    // app's userId is its owner's, so without the scope check in
    // requiresRoomAccess this route would answer 200.
    const srv = await startTestServer();
    server = srv;
    const raw = await appToken(srv);
    const bot = srv.agentManager.getAllAgents()[0];
    expect(
      (await api(srv, `/api/agents/${bot.id}/instructions`, { bearer: raw }))
        .status,
    ).toBe(403);
  });

  it("is walled off the whole legacy surface, in one place", async () => {
    // Everything below the /api dispatcher gates on "is there an identity"
    // alone: the agent manifest (live and killed), the legacy file handlers,
    // the static UI.
    const srv = await startTestServer();
    server = srv;
    const raw = await appToken(srv);
    for (const path of [
      "/agents",
      "/agents?killed=1",
      "/api/files/anything",
      "/api/nonexistent-route",
      "/",
    ]) {
      const res = await srv.http(path, {
        headers: { Authorization: `Bearer ${raw}` },
      });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });
});

// --- Announcing must never change what was announced (S3) -------------------
// Every announce call site sits after its commit point and inside the handler's
// outer try. If the injected wire seam throws, that catch would render an HTTP
// failure for a mutation that REALLY HAPPENED - and the caller's natural
// response to a 500 is a retry that can only ever be told the name is taken, or
// already gone. Driven through appsHandlers directly, because the point is a
// dependency the real server does not let you break.

function throwingDeps(over: Partial<AppsDeps> = {}): AppsDeps {
  const record: AppRecord = {
    name: "hello",
    port: 21000,
    command: "bun run serve.ts",
    cwd: "/tmp",
    dataDir: "/tmp/data/hello",
    userId: "u-alice",
    username: "alice",
    createdBy: "Agent1",
    createdAt: 1,
  };
  const boom = () => {
    throw new Error("the wire is on fire");
  };
  return {
    list: () => [record],
    get: () => record,
    register: () => record,
    remove: () => record,
    update: () => record,
    attributionFor: () => ({ createdBy: "Agent1", username: "alice" }),
    validateCwd: (cwd) => ({ ok: true, resolved: cwd }),
    isOfficeOwner: () => true,
    announce: boom,
    announceRemoved: boom,
    provisionToken: () => true,
    revokeToken: () => {},
    install: () => {},
    reinstall: () => {},
    teardown: () => {},
    start: () => {},
    stop: () => {},
    restart: () => {},
    states: () => new Map(),
    logs: () => [],
    sendAsApp: () => ({ ok: true, messageId: "m-1" }),
    limiter: createAppMessageLimiter(),
    ...over,
  };
}

const unitCtx = (
  body: unknown = {},
  params: Record<string, string> = { name: "hello" },
): RouteHandlerContext => ({
  identity: {
    scope: "user",
    userId: "u-alice",
    role: "owner",
  } as unknown as RouteHandlerContext["identity"],
  params,
  body,
  rawBody: JSON.stringify(body ?? {}),
  query: new URLSearchParams(),
  req: new Request("http://localhost/"),
});

describe("routes/apps: a failed announcement never rewrites a committed answer", () => {
  it("register still answers 201 with the app when announcing throws", async () => {
    const handlers = appsHandlers(throwingDeps());
    const res = await handlers["apps.register"](
      unitCtx({ name: "hello", command: "bun run serve.ts", cwd: "/tmp" }, {}),
    );
    expect(res.kind).toBe("json");
    if (res.kind !== "json") throw new Error("expected json");
    expect(res.status).toBe(201);
    expect((res.body as AppWire).name).toBe("hello");
  });

  it("update still answers 200 with the app when announcing throws", async () => {
    const handlers = appsHandlers(throwingDeps());
    const res = await handlers["apps.update"](unitCtx({ description: "x" }));
    expect(res.kind).toBe("json");
    if (res.kind !== "json") throw new Error("expected json");
    expect(res.status ?? 200).toBe(200);
    expect((res.body as AppWire).name).toBe("hello");
  });

  it("delete still answers 204 when announcing throws - the app IS gone", async () => {
    // The worst of the four: a 500 here would invite a retry against a record
    // the registry has already removed.
    const handlers = appsHandlers(throwingDeps());
    const res = await handlers["apps.delete"](unitCtx());
    expect(res.kind).toBe("noContent");
  });

  it("start still answers 200 with the app's state when announcing throws", async () => {
    let started = 0;
    const handlers = appsHandlers(
      throwingDeps({
        start: () => {
          started++;
        },
      }),
    );
    const res = await handlers["apps.start"](unitCtx());
    expect(res.kind).toBe("json");
    if (res.kind !== "json") throw new Error("expected json");
    expect(started).toBe(1);
    expect((res.body as AppWire).name).toBe("hello");
  });
});
