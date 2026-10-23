// Phase 3a - executor pipeline contract. Exercises authorize -> preconditions ->
// idempotency(handler) -> render in isolation with fake routes/identities/deps
// (no server boot, no managers). Zero LLM.

import { describe, it, expect } from "bun:test";
import {
  executeRoute,
  ok,
  created,
  noContent,
  fail,
  type ExecutorDeps,
  type RouteHandler,
  type PreconditionFn,
} from "../routes/executor.ts";
import type {
  RouteDef,
  RouteAuth,
  RoutePrecondition,
} from "../routes/table.ts";
import type { RouteMatch } from "../routes/match.ts";
import {
  authenticated,
  officeOwner,
  type GuardDeps,
} from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  type Capability,
  type Identity,
} from "../identity/index.ts";
import { createIdempotencyCache } from "../transport/idempotency.ts";
import type { AuditWrite } from "../audit-store.ts";

// --- Fakes ------------------------------------------------------------------
const NOOP_GUARD_DEPS: GuardDeps = {
  hasRoomAccess: () => true,
  roomIdForAgent: () => null,
  userIdForUsername: () => null,
  cronjobCreatorUserId: () => null,
  appOwnerUserId: () => null,
  webhookOwnerUserId: () => null,
  isOfficeOwnerUserId: () => false,
  agentManagerUserId: () => null,
  killedAgentManagerUserId: () => null,
  killedAgentLastRoomId: () => null,
  roomExists: () => false,
  cronRunVisibleTo: () => false,
};

function userIdentity(role: "owner" | "member"): Identity {
  return {
    scope: "user",
    userId: "u1",
    role,
    capabilities: USER_CAPABILITIES,
  };
}
function agentIdentity(): Identity {
  return {
    scope: "agent",
    userId: "u1",
    agentId: "a1",
    role: "member",
    capabilities: AGENT_CAPABILITIES,
  };
}

function route(
  opId: string,
  method: RouteDef["method"],
  path: string,
  auth: RouteAuth,
  preconditions?: RoutePrecondition[],
): RouteDef {
  return { opId, method, path, auth, emits: [], preconditions };
}

function capAuth(cap: Capability, guard = authenticated): RouteAuth {
  return { kind: "capability", requiredCapability: cap, resourceGuard: guard };
}

// `auditRows` holds what the executor handed the audit store.
function makeDeps(
  handlers: Record<string, RouteHandler>,
  preconditions: Record<string, PreconditionFn> = {},
  guardDeps: GuardDeps = NOOP_GUARD_DEPS,
): ExecutorDeps & { auditRows: AuditWrite[] } {
  const auditRows: AuditWrite[] = [];
  return {
    auditRows,
    audit: {
      actor: () => ({ kind: "member", id: "u1", name: "Member" }),
      write: (row) => {
        auditRows.push(row);
      },
    },
    guardDeps,
    idempotency: createIdempotencyCache(),
    handlers: new Map(Object.entries(handlers)),
    preconditions: new Map(
      Object.entries(preconditions) as [RoutePrecondition, PreconditionFn][],
    ),
  };
}

function req(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://test${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function match(r: RouteDef, params: Record<string, string> = {}): RouteMatch {
  return { route: r, params };
}

// --- Authorization ----------------------------------------------------------
describe("executor: authorization", () => {
  it("403s a missing capability or a guard denial WITHOUT running the handler", async () => {
    // An AGENT identity lacks agent:manage (stage 1); officeOwner refuses a
    // member who holds office:admin (stage 2).
    const cases: [RouteAuth, Identity][] = [
      [capAuth("agent:manage"), agentIdentity()],
      [capAuth("office:admin", officeOwner), userIdentity("member")],
    ];
    for (const [auth, identity] of cases) {
      let ran = false;
      const r = route("a.spawn", "POST", "/api/x", auth);
      const deps = makeDeps({
        "a.spawn": () => {
          ran = true;
          return noContent();
        },
      });
      const res = await executeRoute(
        match(r),
        req("POST", "/api/x", {}),
        identity,
        deps,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden");
      expect(ran).toBe(false);
    }
  });
});

// --- Result rendering -------------------------------------------------------
describe("executor: result rendering", () => {
  it("error result -> {error:{code,message}} envelope with the status", async () => {
    const r = route("t.get", "GET", "/api/g", capAuth("task:read"));
    const deps = makeDeps({
      "t.get": () => fail(404, "not_found", "no such task"),
    });
    const res = await executeRoute(
      match(r),
      req("GET", "/api/g"),
      userIdentity("member"),
      deps,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "no such task" },
    });
  });

  // A binary route (an image upload) reads the body itself, after
  // authorization: a refused caller's body is never read.
  it("a binary route refused by authorization never reads the body", async () => {
    const r: RouteDef = {
      ...route(
        "app.upload",
        "PUT",
        "/api/u",
        capAuth("app:write", officeOwner),
      ),
      body: "binary",
    };
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
        // highWaterMark 0: nothing is pulled until somebody reads.
      },
      { highWaterMark: 0 },
    );
    let ran = false;
    const deps = makeDeps({
      "app.upload": () => {
        ran = true;
        return ok({});
      },
    });
    const request = new Request("http://test/api/u", {
      method: "PUT",
      body: stream,
      // @ts-expect-error - Bun accepts duplex for a streamed request body.
      duplex: "half",
    });
    const res = await executeRoute(
      match(r),
      request,
      userIdentity("member"),
      deps,
    );
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
    expect(request.bodyUsed).toBe(false);
    expect(pulled).toBe(0);
  });

  it("unparseable JSON body -> 400 before authorization", async () => {
    // An AGENT identity lacks agent:manage, so a valid body would 403.
    const r = route("a.spawn", "POST", "/api/c", capAuth("agent:manage"));
    const deps = makeDeps({ "a.spawn": () => created({}) });
    const bad = new Request("http://test/api/c", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await executeRoute(match(r), bad, agentIdentity(), deps);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_json");
  });
});

// --- Idempotency ------------------------------------------------------------
describe("executor: idempotency", () => {
  it("replays a same-key same-body mutation (handler runs once)", async () => {
    let calls = 0;
    const r = route("t.create", "POST", "/api/c", capAuth("task:write"));
    const deps = makeDeps({
      "t.create": () => {
        calls++;
        return created({ n: calls });
      },
    });
    const headers = { "Idempotency-Key": "k1" };
    const a = await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 1 }, headers),
      userIdentity("member"),
      deps,
    );
    const b = await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 1 }, headers),
      userIdentity("member"),
      deps,
    );
    expect(calls).toBe(1);
    expect(a.headers.get("Idempotency-Replayed")).toBeNull();
    expect(b.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await a.json()).toEqual({ n: 1 });
    expect(await b.json()).toEqual({ n: 1 });
  });

  it("marks an in-flight collapsed 204 as replayed without marking fresh responses", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const r = route("t.delete", "POST", "/api/d", capAuth("task:write"));
    const deps = makeDeps({
      "t.delete": async () => {
        calls++;
        entered();
        await pending;
        return noContent();
      },
    });
    const run = (key?: string) =>
      executeRoute(
        match(r),
        req("POST", "/api/d", {}, key ? { "Idempotency-Key": key } : {}),
        userIdentity("member"),
        deps,
      );
    const first = run("collapse");
    await started;
    const second = run("collapse");
    release();
    const [fresh, replay] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(fresh.status).toBe(204);
    expect(fresh.headers.get("Idempotency-Replayed")).toBeNull();
    expect(replay.status).toBe(204);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await run()).headers.get("Idempotency-Replayed")).toBeNull();
    expect(calls).toBe(2);
  });

  it("409s a same-key different-body mutation", async () => {
    const r = route("t.create", "POST", "/api/c", capAuth("task:write"));
    const deps = makeDeps({ "t.create": () => created({ ok: true }) });
    const headers = { "Idempotency-Key": "k1" };
    await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 1 }, headers),
      userIdentity("member"),
      deps,
    );
    const conflict = await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 2 }, headers),
      userIdentity("member"),
      deps,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("Idempotency-Replayed")).toBeNull();
    expect((await conflict.json()).error.code).toBe("idempotency_conflict");
  });

  it("does NOT cache a GET (no key read; handler runs each time)", async () => {
    let calls = 0;
    const r = route("t.list", "GET", "/api/l", capAuth("task:read"));
    const deps = makeDeps({
      "t.list": () => {
        calls++;
        return ok({ n: calls });
      },
    });
    const headers = { "Idempotency-Key": "k1" };
    await executeRoute(
      match(r),
      req("GET", "/api/l", undefined, headers),
      userIdentity("member"),
      deps,
    );
    await executeRoute(
      match(r),
      req("GET", "/api/l", undefined, headers),
      userIdentity("member"),
      deps,
    );
    expect(calls).toBe(2);
  });

  it("does NOT cache a failure (error result re-runs on retry)", async () => {
    let calls = 0;
    const r = route("t.create", "POST", "/api/c", capAuth("task:write"));
    const deps = makeDeps({
      "t.create": () => {
        calls++;
        return calls === 1 ? fail(409, "stale") : created({ n: calls });
      },
    });
    const headers = { "Idempotency-Key": "k1" };
    const first = await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 1 }, headers),
      userIdentity("member"),
      deps,
    );
    expect(first.status).toBe(409);
    const second = await executeRoute(
      match(r),
      req("POST", "/api/c", { x: 1 }, headers),
      userIdentity("member"),
      deps,
    );
    expect(second.status).toBe(201);
    expect(calls).toBe(2);
  });
});

// --- Preconditions ----------------------------------------------------------
describe("executor: preconditions", () => {
  it("a rejecting precondition short-circuits before the handler", async () => {
    let ran = false;
    const r = route(
      "s.revoke",
      "DELETE",
      "/api/s/x",
      capAuth("session:manage"),
      ["notLastOwnerLockout"],
    );
    const deps = makeDeps(
      {
        "s.revoke": () => {
          ran = true;
          return noContent();
        },
      },
      { notLastOwnerLockout: () => fail(409, "would_strand_office") },
    );
    const res = await executeRoute(
      match(r, { sessionPrefix: "x" }),
      req("DELETE", "/api/s/x"),
      userIdentity("owner"),
      deps,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("would_strand_office");
    expect(ran).toBe(false);
  });

  it("throws (fail-closed) when a declared precondition has no enforcer", async () => {
    const r = route(
      "s.revoke",
      "DELETE",
      "/api/s/x",
      capAuth("session:manage"),
      ["notLastOwnerLockout"],
    );
    const deps = makeDeps({ "s.revoke": () => noContent() }); // no precondition registered
    let threw: unknown = null;
    try {
      await executeRoute(
        match(r, { sessionPrefix: "x" }),
        req("DELETE", "/api/s/x"),
        userIdentity("owner"),
        deps,
      );
    } catch (e) {
      threw = e;
    }
    expect(String(threw)).toContain("no enforcer registered");
  });
});

describe("executor audit", () => {
  it("records only executed successful writes, with ids and field names but no values", async () => {
    const { resourceTargets } = await import("../routes/audit.ts");
    const r = route("test.write", "POST", "/api/x", capAuth("task:write"));
    r.audit = { owner: "executor", targets: resourceTargets };
    const deps = makeDeps({
      "test.write": (ctx) =>
        (ctx.body as { fail?: boolean }).fail
          ? fail(400, "bad")
          : created({ id: "new-id", secret: "response-secret" }),
    });
    const rows = deps.auditRows;
    const call = (body: unknown, key?: string) =>
      executeRoute(
        match(r),
        req("POST", "/api/x", body, key ? { "Idempotency-Key": key } : {}),
        userIdentity("owner"),
        deps,
      );
    expect((await call({ password: "request-secret" }, "same")).status).toBe(
      201,
    );
    expect(
      (await call({ password: "request-secret" }, "same")).headers.get(
        "Idempotency-Replayed",
      ),
    ).toBe("true");
    expect((await call({ password: "different" }, "same")).status).toBe(409);
    expect((await call({ fail: true })).status).toBe(400);
    expect(rows).toHaveLength(1);
    expect(rows[0].targets).toEqual(["new-id"]);
    expect(rows[0].fields).toEqual(["password"]);
    expect(JSON.stringify(rows)).not.toContain("request-secret");
    expect(JSON.stringify(rows)).not.toContain("response-secret");
    r.method = "GET";
    deps.handlers = new Map([["test.write", () => ok({ id: "read" })]]);
    await executeRoute(
      match(r),
      req("GET", "/api/x"),
      userIdentity("owner"),
      deps,
    );
    expect(rows).toHaveLength(1);
  });
  it("returns success after a generic audit insert fails", async () => {
    const { resourceTargets } = await import("../routes/audit.ts");
    const { spyOn } = await import("bun:test");
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = route("test.write", "POST", "/api/x", capAuth("task:write"));
      r.audit = { owner: "executor", targets: resourceTargets };
      const deps = makeDeps({ "test.write": () => noContent() });
      deps.audit = {
        actor: () => ({ kind: "member", id: "u", name: "Member" }),
        write: () => {
          throw new Error("disk full");
        },
      };
      expect(
        (
          await executeRoute(
            match(r),
            req("POST", "/api/x", {}),
            userIdentity("owner"),
            deps,
          )
        ).status,
      ).toBe(204);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

it("inbox polling adds no audit row", async () => {
  const { API_ROUTES } = await import("../routes/table.ts");
  const { API_CAPABILITIES } = await import("../identity/index.ts");
  const r = API_ROUTES.find((r) => r.opId === "apiTokenInbox.drain")!;
  const deps = makeDeps({ [r.opId]: () => ok({ messages: [] }) });
  const identity: Identity = {
    scope: "api",
    userId: "owner",
    role: "owner",
    apiTokenId: "token",
    capabilities: API_CAPABILITIES,
  };
  expect(
    (await executeRoute(match(r), req("POST", r.path, {}), identity, deps))
      .status,
  ).toBe(200);
  expect(deps.auditRows).toHaveLength(0);
});
