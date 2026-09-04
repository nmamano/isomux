// Personal preferences (task 49d4e2f6): PATCH /api/me/preferences, exercised
// through the real REST surface.
//
// The four things worth pinning:
//   - the round trip actually reaches disk (asserted through a COLD RESTART,
//     not just the in-memory record - a preference that doesn't survive a
//     restart is worse than no preference);
//   - the write is SELF-scoped (no :username param exists, so one user's call
//     can never land on another's record) and out of reach of agent tokens;
//   - malformed / unsupported values are rejected rather than silently
//     clamped. Unlike view.*, there's no no-oracle concern here: a language
//     code says nothing about the office's contents;
//   - the write FANS OUT on the right channels. The UI reads these preferences
//     off the record it holds in its store, so persistence alone is not enough
//     for the feature to work.

import { describe, it, expect, afterEach } from "bun:test";
import {
  startTestServer,
  type TestServer,
  type TestSocket,
} from "./harness.ts";
import { getUserByName } from "../users.ts";
import { API_ROUTES } from "../routes/table.ts";
import { authorize, type RouteAuthz } from "../identity/dispatch.ts";
import type { GuardDeps } from "../identity/guards.ts";
import {
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  USER_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function putPrefs(
  srv: TestServer,
  rawSessionId: string,
  body: unknown,
): Promise<number> {
  const resp = await srv.http("/api/me/preferences", {
    method: "PATCH",
    rawSessionId,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.status;
}

describe("prefs.update - persistence", () => {
  it("round-trips language through a cold restart", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");

    expect(await putPrefs(server, owner.rawSessionId, { language: "es" })).toBe(
      204,
    );

    // Cold reload re-runs the real boot path against persisted users.json.
    server = await server.restart();
    const reloaded = getUserByName("Boss")!;
    expect(reloaded.language).toBe("es");
  });

  it("language: null clears an earlier pick", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await putPrefs(server, owner.rawSessionId, { language: "es" });

    // An explicit null clears it.
    expect(await putPrefs(server, owner.rawSessionId, { language: null })).toBe(
      204,
    );
    expect(getUserByName("Boss")!.language).toBe(null);
  });

  it("new users start with no language", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const rec = getUserByName(member.username)!;
    expect(rec.language).toBe(null);
  });
});

describe("prefs.update - self scoping", () => {
  it("a member's write lands on their own record, never the owner's", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");

    expect(
      await putPrefs(server, member.rawSessionId, { language: "es" }),
    ).toBe(204);
    expect(getUserByName(member.username)!.language).toBe("es");
    expect(getUserByName("Boss")!.language).toBe(null);
    // And the owner's own write doesn't touch the member's.
    await putPrefs(server, owner.rawSessionId, { language: "en" });
    expect(getUserByName("Boss")!.language).toBe("en");
    expect(getUserByName(member.username)!.language).toBe("es");
  });

  it("rejects an unauthenticated call", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const resp = await server.http("/api/me/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "es" }),
    });
    expect(resp.status).toBe(401);
  });
});

describe("prefs.update - value validation", () => {
  it("rejects an unsupported language code", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");

    expect(await putPrefs(server, owner.rawSessionId, { language: "fr" })).toBe(
      422,
    );
    expect(await putPrefs(server, owner.rawSessionId, { language: 7 })).toBe(
      422,
    );
    // Nothing was written by any of the rejected calls.
    const rec = getUserByName("Boss")!;
    expect(rec.language).toBe(null);
  });

  // A primitive body is legal JSON, and `"language" in body` THROWS on one -
  // a 500 where a 422 belongs. An array is an object but never a valid update.
  it("rejects primitive and array bodies with 422, not 500", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    for (const body of [7, "x", true, ["language"], null]) {
      expect(await putPrefs(server, owner.rawSessionId, body)).toBe(422);
    }
  });

  // The worst answer to a typo is 204: the user watches Save succeed and
  // nothing happen.
  it("rejects an unknown key and an empty update", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    expect(await putPrefs(server, owner.rawSessionId, { langauge: "es" })).toBe(
      422,
    );
    expect(
      await putPrefs(server, owner.rawSessionId, { language: "es", nope: 1 }),
    ).toBe(422);
    expect(await putPrefs(server, owner.rawSessionId, {})).toBe(422);
    expect(getUserByName("Boss")!.language).toBe(null);
  });
});

// The UI is event-authoritative: PreferencesPane reads the record out of the
// store, so a write that persists but never fans out looks like a Save that
// did nothing. These pin the audiences.
describe("prefs.update - live event contract", () => {
  const bag = (sock: TestSocket, type: string): Record<string, unknown>[] =>
    (sock.messages as Record<string, unknown>[]).filter((m) => m.type === type);

  it("subject gets user_self_updated, owners get user_admin_updated, and the private fields never ride a public event", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const ownerSock = await server.connectWs(owner.rawSessionId);
    const memberSock = await server.connectWs(member.rawSessionId);
    await ownerSock.waitFor("presence_list");
    await memberSock.waitFor("presence_list");
    // Ignore the connect-time hydration; only events caused by the write count.
    const beforeSelf = bag(memberSock, "user_self_updated").length;
    const beforeAdmin = bag(ownerSock, "user_admin_updated").length;

    expect(
      await putPrefs(server, member.rawSessionId, { language: "es" }),
    ).toBe(204);
    await sleep(50);

    // The subject's own sockets get their full record - this is what makes the
    // pane authoritative on their other devices.
    const selfEvents = bag(memberSock, "user_self_updated").slice(beforeSelf);
    expect(selfEvents.length).toBe(1);
    const selfUser = selfEvents[0].user as Record<string, unknown>;
    expect(selfUser.language).toBe("es");

    // Owners get it on the owners-only admin channel.
    const adminEvents = bag(ownerSock, "user_admin_updated").slice(beforeAdmin);
    expect(adminEvents.length).toBe(1);
    const adminUser = adminEvents[0].user as Record<string, unknown>;
    expect(adminUser.language).toBe("es");

    // And NOTHING rides the all-audience public channels: neither field is in
    // UserPublicWire, so a public event would carry no delta and would only
    // broadcast the timing of someone's private edit.
    expect(bag(ownerSock, "user_updated").length).toBe(0);
    expect(bag(memberSock, "user_updated").length).toBe(0);
    // users_list arrives once at connect hydration; the write must not add one.
    expect(bag(ownerSock, "users_list").length).toBe(1);
    expect(bag(memberSock, "users_list").length).toBe(1);
    ownerSock.close();
    memberSock.close();
  });

  it("a no-op write emits nothing", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    await putPrefs(server, owner.rawSessionId, { language: "es" });
    const sock = await server.connectWs(owner.rawSessionId);
    await sock.waitFor("presence_list");
    const before = bag(sock, "user_self_updated").length;

    // Same values again.
    expect(
      await putPrefs(server, owner.rawSessionId, { language: "es" }),
    ).toBe(204);
    await sleep(50);
    expect(bag(sock, "user_self_updated").length).toBe(before);
    expect(bag(sock, "user_admin_updated").length).toBe(0);
    sock.close();
  });
});

// Capability check against the LIVE route table (same technique as
// routes-privileged-auth.test.ts): agents must not be able to change a human's
// personal settings - the agent system prompt promises exactly that.
describe("prefs.update - agent tokens are locked out", () => {
  function authz(opId: string): RouteAuthz {
    const r = API_ROUTES.find((r) => r.opId === opId);
    if (!r) throw new Error(`no route ${opId}`);
    if (r.auth.kind !== "capability") {
      throw new Error(`${opId} is auth.kind=${r.auth.kind}, not capability`);
    }
    return {
      requiredCapability: r.auth.requiredCapability,
      resourceGuard: r.auth.resourceGuard,
    };
  }
  const deps: GuardDeps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r-1",
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => "u-1",
    appOwnerUserId: () => null,
    isOfficeOwnerUserId: () => false,
    agentManagerUserId: () => "u-1",
    killedAgentManagerUserId: () => null,
  };
  const identity = (
    scope: Identity["scope"],
    capabilities: readonly Identity["capabilities"][number][],
  ): Identity => ({
    scope,
    userId: "u-1",
    ...(scope === "agent" ? { agentId: "a-1" } : {}),
    role: "member",
    capabilities,
  });
  const can = (id: Identity) =>
    authorize(authz("prefs.update"), {
      identity: id,
      params: {},
      body: undefined,
      deps,
    }).ok;

  it("a human can, a normal agent and a PRIVILEGED agent cannot", () => {
    expect(can(identity("user", USER_CAPABILITIES))).toBe(true);
    expect(can(identity("agent", AGENT_CAPABILITIES))).toBe(false);
    expect(can(identity("agent", PRIVILEGED_AGENT_CAPABILITIES))).toBe(false);
  });
});
