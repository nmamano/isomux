// Phase 3a slice 3a.5 — validate.{cwd,env} on the unified REST surface.
//
// The validate.env block is the slice's must-have regression net: the route's
// object-level policy lives ENTIRELY in the validateEnvBodySelfSubject
// PRECONDITION (the guard is just `authenticated`), because the subject is
// body.username, not a :username path param. An earlier table had the guard as
// or(officeOwner, selfUser); since selfUser only reads params.username and this
// route has none, that guard collapsed to officeOwner and DENIED a member
// validating their own env at the guard — before the precondition could run,
// making the precondition dead code. These tests pin that a member validating
// their OWN env is ALLOWED (precondition reached + passed) while office scope /
// another user's env are denied, so the precondition can never silently become
// unreachable again.
//
// Seam: startTestServer(). Zero LLM.

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./harness.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
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
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  const res = await srv.http(path, {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.rawSessionId,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function spawnAgent(
  srv: TestServer,
  name: string,
  roomId: string,
): Promise<AgentInfo> {
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

describe("routes/validate.cwd REST", () => {
  it("valid dir -> {ok:true}; bad dir -> {ok:false,error}; member allowed; agent 403; no id 401", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    const good = await api(srv, "/api/validate/cwd", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { cwd: srv.stateRoot },
    });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ ok: true });

    const bad = await api(srv, "/api/validate/cwd", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { cwd: "/no/such/dir/xyz123" },
    });
    expect(bad.status).toBe(200);
    expect((bad.body as { ok: boolean }).ok).toBe(false);
    expect(typeof (bad.body as { error?: string }).error).toBe("string");

    // Empty/missing cwd must NOT silently resolve to the server's own cwd.
    const empty = await api(srv, "/api/validate/cwd", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: {},
    });
    expect(empty.status).toBe(200);
    expect((empty.body as { ok: boolean }).ok).toBe(false);

    // agent:manage is held by any USER (owner or member), not AGENT scope.
    const mem = await api(srv, "/api/validate/cwd", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { cwd: srv.stateRoot },
    });
    expect(mem.status).toBe(200);
    expect(mem.body).toEqual({ ok: true });

    expect(
      (
        await api(srv, "/api/validate/cwd", {
          method: "POST",
          bearer: token,
          body: { cwd: srv.stateRoot },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/validate/cwd", {
          method: "POST",
          body: { cwd: srv.stateRoot },
        })
      ).status,
    ).toBe(401);
  });
});

describe("routes/validate.env REST: object-level policy (the dead-precondition regression)", () => {
  it("member validates OWN user env (username omitted AND username=self) -> 200 allowed", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");

    // username omitted: subject defaults to self.
    const omitted = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "user" },
    });
    expect(omitted.status).toBe(200);
    expect(omitted.body).toEqual({ ok: true });

    // username = self, explicit.
    const selfNamed = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "user", username: "Alice" },
    });
    expect(selfNamed.status).toBe(200);
    expect(selfNamed.body).toEqual({ ok: true });
  });

  it("member office scope -> 403; member another user's env -> 403", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");

    expect(
      (
        await api(srv, "/api/validate/env", {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body: { scope: "office" },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await api(srv, "/api/validate/env", {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body: { scope: "user", username: "Boss" },
        })
      ).status,
    ).toBe(403);
  });

  it("nonexistent username is non-leaking: member -> 403; owner -> 200 {ok:true} (indistinguishable from a no-env user)", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");

    // Member targeting a user that does not exist: SAME 403 as a foreign user —
    // no exists-but-hidden distinction.
    expect(
      (
        await api(srv, "/api/validate/env", {
          method: "POST",
          rawSessionId: member.rawSessionId,
          body: { scope: "user", username: "Ghost" },
        })
      ).status,
    ).toBe(403);

    // Owner targeting a nonexistent user resolves to no env -> {ok:true}, the
    // SAME response as a real user with no env file (Alice) — owners cannot
    // distinguish "no such user" from "user has no env".
    const ghost = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "user", username: "Ghost" },
    });
    const aliceNoEnv = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "user", username: "Alice" },
    });
    expect(ghost.status).toBe(200);
    expect(ghost.body).toEqual({ ok: true });
    expect(aliceNoEnv.body).toEqual(ghost.body);
  });

  it("owner validates office scope AND another user's env -> 200 allowed", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");
    await srv.seedMember("Alice");

    const office = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "office" },
    });
    expect(office.status).toBe(200);
    expect(office.body).toEqual({ ok: true }); // no office env file set

    const other = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "user", username: "Alice" },
    });
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ ok: true });
  });

  it("AGENT scope -> 403 at stage 1 (lacks office:read); no identity -> 401", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const room = srv.agentManager.getRooms()[0];
    const agent = await spawnAgent(srv, "Worker", room.id);
    const token = getAgentTokenRaw(agent.id)!;

    expect(
      (
        await api(srv, "/api/validate/env", {
          method: "POST",
          bearer: token,
          body: { scope: "user" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(srv, "/api/validate/env", {
          method: "POST",
          body: { scope: "user" },
        })
      ).status,
    ).toBe(401);
  });
});

describe("routes/validate.env REST: resolution core (keyCount + error)", () => {
  it("office scope with a real env file -> {ok:true,keyCount}; missing file -> {ok:false,error}; resolved path is DROPPED", async () => {
    const srv = await startTestServer();
    server = srv;
    const owner = await srv.seedOwner("Boss");

    const envPath = join(srv.stateRoot, "office.env");
    writeFileSync(envPath, "ALPHA=1\nBETA=2\n");
    // Set the office env file directly (bypassing the validating setSettings
    // path) so the validate.env core has a real file to resolve.
    srv.agentManager.setOfficeSettings(null, envPath, null);

    const okRes = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "office" },
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ ok: true, keyCount: 2 });
    // The resolved env-file path must never ride the REST response.
    expect(JSON.stringify(okRes.body)).not.toContain(envPath);

    // Now make the path dangle: the resolve core surfaces the read error.
    unlinkSync(envPath);
    const errRes = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: owner.rawSessionId,
      body: { scope: "office" },
    });
    expect(errRes.status).toBe(200);
    expect((errRes.body as { ok: boolean }).ok).toBe(false);
    expect(typeof (errRes.body as { error?: string }).error).toBe("string");
    // NOTE: the validation ERROR message may echo the path ("file not found:
    // <path>"), exactly as the legacy WS arm does. That is not a leak: validate.env
    // only resolves a path the caller is already authorized to know (a member sees
    // only their OWN env path; office/other-user paths reach only owners, who can
    // read them via office.getSettings anyway). What is dropped by design is the
    // structured `envFile` field on SUCCESS (asserted above), not error-message
    // scrubbing — so no not.toContain assertion here.
  });

  it("member omitted username resolves to OWN env: {scope:'user'} validates self like {scope:'user',username:self}", async () => {
    const srv = await startTestServer();
    server = srv;
    await srv.seedOwner("Boss");
    const member = await srv.seedMember("Alice");

    // Give Alice a real env file with 3 keys.
    const envPath = join(srv.stateRoot, "alice.env");
    writeFileSync(envPath, "A=1\nB=2\nC=3\n");
    const alice = getUserByName("Alice");
    expect(alice).toBeTruthy();
    expect(updateUserById(alice!.id, { envFile: envPath }).ok).toBe(true);

    // Omitted username -> self -> validates Alice's env (NOT a trivial ok). This
    // is the regression: before the self-resolution fix, omitted resolved nothing
    // and returned {ok:true} without validating.
    const omitted = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "user" },
    });
    expect(omitted.status).toBe(200);
    expect(omitted.body).toEqual({ ok: true, keyCount: 3 });

    // Explicit self username -> identical result.
    const named = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "user", username: "Alice" },
    });
    expect(named.status).toBe(200);
    expect(named.body).toEqual({ ok: true, keyCount: 3 });

    // A broken own env surfaces the error on the omitted path too.
    unlinkSync(envPath);
    const broken = await api(srv, "/api/validate/env", {
      method: "POST",
      rawSessionId: member.rawSessionId,
      body: { scope: "user" },
    });
    expect(broken.status).toBe(200);
    expect((broken.body as { ok: boolean }).ok).toBe(false);
  });
});
