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

// --- Fakes ------------------------------------------------------------------
const NOOP_GUARD_DEPS: GuardDeps = {
  hasRoomAccess: () => true,
  roomIdForAgent: () => null,
  userIdForUsername: () => null,
  cronjobCreatorUserId: () => null,
  agentManagerUserId: () => null,
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

function makeDeps(
  handlers: Record<string, RouteHandler>,
  preconditions: Record<string, PreconditionFn> = {},
  guardDeps: GuardDeps = NOOP_GUARD_DEPS,
): ExecutorDeps {
  return {
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
  it("runs the handler when capability + guard pass", async () => {
    const r = route("t.read", "GET", "/api/x", capAuth("task:read"));
    const deps = makeDeps({ "t.read": () => ok({ hi: true }) });
    const res = await executeRoute(
      match(r),
      req("GET", "/api/x"),
      userIdentity("member"),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: true });
  });

  it("403s a missing capability WITHOUT running the handler", async () => {
    let ran = false;
    const r = route("a.spawn", "POST", "/api/x", capAuth("agent:manage"));
    const deps = makeDeps({
      "a.spawn": () => {
        ran = true;
        return noContent();
      },
    });
    // An AGENT identity lacks agent:manage.
    const res = await executeRoute(
      match(r),
      req("POST", "/api/x", {}),
      agentIdentity(),
      deps,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(ran).toBe(false);
  });

  it("403s a resource-guard denial (officeOwner on a member)", async () => {
    const r = route(
      "o.set",
      "PUT",
      "/api/x",
      capAuth("office:admin", officeOwner),
    );
    const deps = makeDeps({ "o.set": () => noContent() });
    const res = await executeRoute(
      match(r),
      req("PUT", "/api/x", {}),
      userIdentity("member"),
      deps,
    );
    expect(res.status).toBe(403);
  });

  it("authenticated-kind route runs with no capability gate", async () => {
    const r = route("s.logout", "DELETE", "/api/x", {
      kind: "authenticated",
      resourceGuard: authenticated,
    });
    const deps = makeDeps({ "s.logout": () => noContent() });
    const res = await executeRoute(
      match(r),
      req("DELETE", "/api/x"),
      userIdentity("member"),
      deps,
    );
    expect(res.status).toBe(204);
  });
});

// --- Result rendering -------------------------------------------------------
describe("executor: result rendering", () => {
  it("created -> 201, noContent -> 204", async () => {
    const c = route("t.create", "POST", "/api/c", capAuth("task:write"));
    const n = route("t.del", "DELETE", "/api/n", capAuth("task:write"));
    const deps = makeDeps({
      "t.create": () => created({ id: "x" }),
      "t.del": () => noContent(),
    });
    const r1 = await executeRoute(
      match(c),
      req("POST", "/api/c", {}),
      userIdentity("member"),
      deps,
    );
    expect(r1.status).toBe(201);
    expect(await r1.json()).toEqual({ id: "x" });
    const r2 = await executeRoute(
      match(n),
      req("DELETE", "/api/n"),
      userIdentity("member"),
      deps,
    );
    expect(r2.status).toBe(204);
    expect(await r2.text()).toBe("");
  });

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

  it("unparseable JSON body -> 400 before authorization", async () => {
    const r = route("t.create", "POST", "/api/c", capAuth("task:write"));
    const deps = makeDeps({ "t.create": () => created({}) });
    const bad = new Request("http://test/api/c", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await executeRoute(match(r), bad, userIdentity("member"), deps);
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
    expect(await a.json()).toEqual({ n: 1 });
    expect(await b.json()).toEqual({ n: 1 });
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

  it("a passing precondition (null) lets the handler run", async () => {
    const r = route(
      "s.revoke",
      "DELETE",
      "/api/s/x",
      capAuth("session:manage"),
      ["sessionOwnerOrSelf"],
    );
    const deps = makeDeps(
      { "s.revoke": () => noContent() },
      { sessionOwnerOrSelf: () => null },
    );
    const res = await executeRoute(
      match(r, { sessionPrefix: "x" }),
      req("DELETE", "/api/s/x"),
      userIdentity("owner"),
      deps,
    );
    expect(res.status).toBe(204);
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
