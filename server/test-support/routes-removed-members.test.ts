// Removed members (task 321e7b8e): removing a member keeps them for 30 days so
// an owner can restore them, as a killed agent can be revived. Access ends at
// the removal; secret values and sign-in tokens are deleted then, and their
// names come back after a restore as needing a value or a sign-in. The
// archive's own rules are in server/removed-members.test.ts.
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { startTestServer, type TestServer } from "./harness.ts";
import { mintMemberLink } from "./member-link.ts";
import { acceptInvite, peekInvite, validateSession } from "../auth.ts";
import { getUserByName } from "../users.ts";
import { managedUserEnvNotesPath, managedUserEnvPath } from "../user-env.ts";
import { mintApiToken, resolveApiToken } from "../api-tokens.ts";
import { getAgentTokenRaw } from "../identity/tokens.ts";
import { createSecretStore } from "../secret-store.ts";
import {
  REMOVED_MEMBER_RETENTION_MS,
  archiveRemovedMember,
} from "../removed-members.ts";
import type {
  MemberRestoreRes,
  RemovedMemberWire,
} from "../../shared/contract-shapes.ts";
import type { AgentInfo } from "../../shared/types.ts";
import {
  activatePersonalProvider,
  isPersonalProviderActive,
  personalProviderHome,
} from "../provider-homes.ts";
import { setSessionClaudeConfigDir } from "../persistence.ts";
import { claudeProjectDir } from "../cwd-utils.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const SECRET_VALUE = "fake-linear-value-removal-0001";

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

const errCode = (r: Res) =>
  (r.body as { error?: { code?: string } })?.error?.code;

const idOf = (name: string): string => {
  const user = getUserByName(name);
  if (!user) throw new Error(`no member ${name}`);
  return user.id;
};

async function listRemoved(
  srv: TestServer,
  rawSessionId: string,
): Promise<RemovedMemberWire[]> {
  const r = await api(srv, "/api/removed-members", { rawSessionId });
  expect(r.status).toBe(200);
  return (r.body as { members: RemovedMemberWire[] }).members;
}

async function removeMember(
  srv: TestServer,
  name: string,
  rawSessionId: string,
) {
  const r = await api(srv, `/api/users/${name}`, {
    method: "DELETE",
    rawSessionId,
  });
  expect(r.status).toBe(204);
}

async function restore(
  srv: TestServer,
  id: string,
  rawSessionId: string,
  body: unknown = {},
): Promise<MemberRestoreRes> {
  const r = await api(srv, `/api/removed-members/${id}/restore`, {
    method: "POST",
    rawSessionId,
    body,
  });
  expect(r.status).toBe(200);
  return r.body as MemberRestoreRes;
}

// What an owner can give a member on the Integrations page: a secret, a
// variable with a note, and an MCP server that uses the secret.
async function equip(srv: TestServer, username: string, rawSessionId: string) {
  for (const [path, method, body] of [
    [
      `/api/users/${username}/secrets`,
      "POST",
      {
        name: "LINEAR_TOKEN",
        value: SECRET_VALUE,
        hosts: ["mcp.example.com"],
        form: { kind: "authorization" },
        note: "For the Linear MCP server.",
      },
    ],
    [
      `/api/users/${username}/env/ZED_TOKEN`,
      "PUT",
      { value: "fake-zed-value", note: "For the Zed CLI." },
    ],
    [
      `/api/users/${username}/mcp-servers`,
      "POST",
      {
        name: "linear",
        url: "https://mcp.example.com/mcp",
        secret: "LINEAR_TOKEN",
      },
    ],
  ] as const)
    expect(
      (await api(srv, path, { method, body, rawSessionId })).status,
    ).toBeLessThan(300);
}

// Every file under the state root that holds `needle`.
function filesHolding(root: string, needle: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => {
      try {
        return readFileSync(path, "utf8").includes(needle);
      } catch {
        return false;
      }
    });
}

async function spawn(
  srv: TestServer,
  name: string,
  manager: string,
): Promise<AgentInfo> {
  const info = await srv.agentManager.spawn(
    name,
    srv.stateRoot,
    "default",
    undefined,
    undefined,
    srv.agentManager.getRooms()[0].id,
    undefined,
    undefined,
    undefined,
    manager,
    "codex",
  );
  if (!info) throw new Error(`spawn ${name} returned null`);
  return info;
}

const managerOf = (srv: TestServer, agentId: string) =>
  srv.agentManager.getAgent(agentId)?.userId ?? null;

describe("removing a member", () => {
  it("keeps them in Removed members for 30 days and ends every way in at once", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    const ws = await srv.connectWs(owner.rawSessionId);
    const token = await mintApiToken({
      userId: miaId,
      name: "Laptop",
      expiresInDays: null,
    });
    const { rawToken: link } = await mintMemberLink("Mia");

    await removeMember(srv, "Mia", owner.rawSessionId);

    expect(getUserByName("Mia")).toBeUndefined();
    const [entry] = await listRemoved(srv, owner.rawSessionId);
    expect(entry).toMatchObject({
      user: { id: miaId, name: "Mia" },
      heirName: "Morgan",
    });
    expect(entry.expiresAt - entry.removedAt).toBe(REMOVED_MEMBER_RETENTION_MS);
    const pushed = await ws.waitFor("removed_members");
    expect(
      (pushed.members as RemovedMemberWire[]).map((m) => m.user.id),
    ).toEqual([miaId]);
    ws.close();

    // Session, API token and sign-in link are gone now, not after a purge.
    expect(validateSession(mia.rawSessionId)).toBeNull();
    expect(resolveApiToken(token.token)).toBeNull();
    expect(peekInvite(link)).toEqual({ error: "not_found" });
  });

  it("deletes the secret values and keeps no secret value on disk anywhere", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    await equip(srv, "Mia", owner.rawSessionId);
    // The condition: the value is on disk before the removal.
    expect(filesHolding(srv.stateRoot, SECRET_VALUE).length).toBeGreaterThan(0);

    await removeMember(srv, "Mia", owner.rawSessionId);
    expect(filesHolding(srv.stateRoot, SECRET_VALUE)).toEqual([]);
  });

  it("a member who removes themselves is restorable too", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    await removeMember(srv, "Mia", mia.rawSessionId);
    expect(
      (await listRemoved(srv, owner.rawSessionId)).map((m) => m.user.id),
    ).toEqual([miaId]);
  });
});

describe("a browser the member paired", () => {
  it("does not come back with a restore", async () => {
    const first = (server = await startTestServer());
    await first.seedOwner("Morgan");
    await first.seedMember("Mia");
    const miaId = idOf("Mia");
    // A browser Mia paired, as the store keeps it; the store reads it at boot.
    writeFileSync(
      join(first.stateRoot, "browser-connections.json"),
      JSON.stringify({
        version: 2,
        members: {
          [miaId]: {
            browsers: [
              {
                id: "laptop",
                name: "Laptop",
                hash: "a".repeat(64),
                origin: `chrome-extension://${"a".repeat(32)}`,
                pairedAt: Date.now(),
              },
            ],
          },
        },
      }),
    );
    const srv = (server = await first.restart());
    const signIn = async (name: string, role?: "owner") => {
      const { rawToken } = await mintMemberLink(name, role);
      const session = await acceptInvite(rawToken, { userAgent: "test" });
      if (!session.ok) throw new Error(session.error);
      return session.rawSessionId;
    };
    const browserOf = async (rawSessionId: string) => {
      const r = await api(srv, "/api/me/browser", { rawSessionId });
      expect(r.status).toBe(200);
      return (r.body as { browsers: { id: string }[] }).browsers.map(
        (b) => b.id,
      );
    };
    const owner = await signIn("Morgan", "owner");
    expect(await browserOf(await signIn("Mia"))).toEqual(["laptop"]);

    await removeMember(srv, "Mia", owner);
    await restore(srv, miaId, owner);
    expect(await browserOf(await signIn("Mia"))).toEqual([]);
  });
});

describe("the removed member's name", () => {
  it("stays reserved until Delete now: no new member and no rename takes it", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    await srv.seedMember("Bob");
    const miaId = idOf("Mia");
    await removeMember(srv, "Mia", owner.rawSessionId);

    const create = (name: string) =>
      api(srv, "/api/users", {
        method: "POST",
        rawSessionId: owner.rawSessionId,
        body: { name, role: "member" },
      });
    const taken = await create("mIa");
    expect([taken.status, errCode(taken)]).toEqual([409, "name_taken"]);
    const rename = await api(srv, "/api/users/Bob", {
      method: "PATCH",
      rawSessionId: owner.rawSessionId,
      body: { name: "MIA" },
    });
    expect([rename.status, errCode(rename)]).toEqual([409, "name_taken"]);
    expect(getUserByName("Bob")).toBeDefined();

    const purge = await api(srv, `/api/removed-members/${miaId}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(purge.status).toBe(204);
    expect(await listRemoved(srv, owner.rawSessionId)).toEqual([]);
    expect(existsSync(join(srv.stateRoot, "removed-members", miaId))).toBe(
      false,
    );
    const fresh = await create("Mia");
    expect(fresh.status).toBe(201);
    // A new member, not the removed one back.
    expect(idOf("Mia")).not.toBe(miaId);
  });

  it("an unknown id is 404 for restore and Delete now", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    for (const [method, path] of [
      ["POST", "/api/removed-members/deadbeef/restore"],
      ["DELETE", "/api/removed-members/deadbeef"],
    ] as const) {
      const r = await api(srv, path, {
        method,
        rawSessionId: owner.rawSessionId,
        ...(method === "POST" ? { body: {} } : {}),
      });
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
    }
  });

  it("only an office owner's browser session lists, restores or deletes a removed member", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const bob = await srv.seedMember("Bob");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    await removeMember(srv, "Mia", owner.rawSessionId);
    const ownerToken = await mintApiToken({
      userId: idOf("Morgan"),
      name: "Script",
      expiresInDays: null,
    });
    for (const caller of [
      { rawSessionId: bob.rawSessionId },
      { bearer: ownerToken.token },
    ])
      for (const [method, path] of [
        ["GET", "/api/removed-members"],
        ["POST", `/api/removed-members/${miaId}/restore`],
        ["DELETE", `/api/removed-members/${miaId}`],
      ] as const) {
        const r = await api(srv, path, {
          method,
          ...caller,
          ...(method === "POST" ? { body: {} } : {}),
        });
        expect({ path, method, refused: r.status === 403 }).toEqual({
          path,
          method,
          refused: true,
        });
      }
    expect(
      (await listRemoved(srv, owner.rawSessionId)).map((m) => m.user.id),
    ).toEqual([miaId]);
  });
});

describe("restoring a member", () => {
  it("brings back the same member with room access, settings and variables; secrets need a value and the MCP server is listed", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    const room = srv.agentManager.createRoom("Studio");
    expect(
      (
        await api(srv, "/api/users/Mia/access", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { allowedRooms: [room] },
        })
      ).status,
    ).toBeLessThan(300);
    expect(
      (
        await api(srv, "/api/users/Mia", {
          method: "PATCH",
          rawSessionId: owner.rawSessionId,
          body: { avatarVariant: "sleepy" },
        })
      ).status,
    ).toBeLessThan(300);
    await equip(srv, "Mia", owner.rawSessionId);
    const variables = {
      env: readFileSync(managedUserEnvPath(miaId), "utf8"),
      notes: readFileSync(managedUserEnvNotesPath(miaId), "utf8"),
    };
    const token = await mintApiToken({
      userId: miaId,
      name: "Laptop",
      expiresInDays: null,
    });

    await removeMember(srv, "Mia", owner.rawSessionId);
    const res = await restore(srv, miaId, owner.rawSessionId);

    expect(res.user).toMatchObject({
      id: miaId,
      name: "Mia",
      allowedRooms: [room],
      avatarVariant: "sleepy",
    });
    expect(getUserByName("Mia")?.id).toBe(miaId);
    expect(await listRemoved(srv, owner.rawSessionId)).toEqual([]);
    expect({
      env: readFileSync(managedUserEnvPath(miaId), "utf8"),
      notes: readFileSync(managedUserEnvNotesPath(miaId), "utf8"),
    }).toEqual(variables);

    const secrets = await api(srv, "/api/users/Mia/secrets", {
      rawSessionId: owner.rawSessionId,
    });
    expect(secrets.status).toBe(200);
    expect(
      (secrets.body as { secrets: Record<string, unknown>[] }).secrets,
    ).toEqual([
      expect.objectContaining({
        name: "LINEAR_TOKEN",
        hosts: ["mcp.example.com"],
        note: "For the Linear MCP server.",
        needsValue: true,
      }),
    ]);
    // Nothing reads it: the proxy snapshot has no entry for it.
    expect(
      createSecretStore(srv.stateRoot).readForProxy({
        kind: "user",
        userId: miaId,
      }),
    ).toEqual([]);
    const servers = await api(srv, "/api/users/Mia/mcp-servers", {
      rawSessionId: owner.rawSessionId,
    });
    expect(
      (servers.body as { servers: { name: string }[] }).servers.map(
        (s) => s.name,
      ),
    ).toEqual(["linear"]);

    // No old session or token comes back; a new sign-in link lets Mia in.
    expect(validateSession(mia.rawSessionId)).toBeNull();
    expect(resolveApiToken(token.token)).toBeNull();
    const { rawToken } = await mintMemberLink("Mia");
    const signedIn = await acceptInvite(rawToken, { userAgent: "test" });
    if (!signedIn.ok) throw new Error(signedIn.error);
    expect(idOf("Mia")).toBe(miaId);
    // Show has nothing to show, and says so without an empty value.
    const shown = await api(srv, "/api/users/Mia/secrets/LINEAR_TOKEN/value", {
      rawSessionId: signedIn.rawSessionId,
    });
    expect(shown.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(shown.body)).not.toContain('"value"');
  });

  it("moves back the agents the heir still manages, as they are now; one the heir passed on stays", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    await srv.seedMember("Bob");
    const miaId = idOf("Mia");
    const morganId = idOf("Morgan");
    const kept = await spawn(srv, "Kept", "Mia");
    const passed = await spawn(srv, "Passed", "Mia");
    const revived = await spawn(srv, "Revived", "Mia");
    const asleep = await spawn(srv, "Asleep", "Mia");
    await srv.agentManager.kill(revived.id);
    await srv.agentManager.kill(asleep.id);

    await removeMember(srv, "Mia", owner.rawSessionId);
    // The condition: everything went to the heir.
    expect(managerOf(srv, kept.id)).toBe(morganId);
    expect(managerOf(srv, passed.id)).toBe(morganId);
    expect(srv.agentManager.killedAgentManagerUserId(asleep.id)).toBe(morganId);

    // The heir changes things in the 30 days.
    const give = await api(srv, `/api/agents/${passed.id}/manager`, {
      method: "PUT",
      rawSessionId: owner.rawSessionId,
      body: { userId: idOf("Bob") },
    });
    expect(give.status).toBeLessThan(300);
    const back = await srv.agentManager.revive(
      revived.id,
      srv.agentManager.getRooms()[0].id,
    );
    expect(back.ok).toBe(true);
    const tokenBefore = getAgentTokenRaw(kept.id);

    const res = await restore(srv, miaId, owner.rawSessionId);
    expect(res.movedBack.agentIds.sort()).toEqual(
      [kept.id, revived.id, asleep.id].sort(),
    );
    expect(res.stayed.agentIds).toEqual([passed.id]);
    expect(managerOf(srv, kept.id)).toBe(miaId);
    expect(srv.agentManager.getAgent(kept.id)?.manager).toBe("Mia");
    expect(managerOf(srv, revived.id)).toBe(miaId);
    expect(srv.agentManager.killedAgentManagerUserId(asleep.id)).toBe(miaId);
    expect(managerOf(srv, passed.id)).toBe(idOf("Bob"));
    // A manager change: the agent's token rotates.
    expect(getAgentTokenRaw(kept.id)).not.toBe(tokenBefore);
  });

  it("with agents off, every agent stays with the heir", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    const agent = await spawn(srv, "Kept", "Mia");
    await removeMember(srv, "Mia", owner.rawSessionId);

    const res = await restore(srv, miaId, owner.rawSessionId, {
      agents: false,
    });
    expect(res.movedBack.agentIds).toEqual([]);
    expect(managerOf(srv, agent.id)).toBe(idOf("Morgan"));
    expect(getUserByName("Mia")?.id).toBe(miaId);
  });

  it("when the heir was removed too, the agents stay with the next heir, and the response says so", async () => {
    const srv = (server = await startTestServer());
    const morgan = await srv.seedOwner("Morgan");
    // The heir is the oldest owner: Olga must be younger than Morgan, not
    // made in the same millisecond (a tie goes by id).
    await Bun.sleep(5);
    const { rawToken } = await mintMemberLink("Olga", "owner");
    const olga = await acceptInvite(rawToken, { userAgent: "test" });
    if (!olga.ok) throw new Error(olga.error);
    expect(getUserByName("Olga")!.createdAt).toBeGreaterThan(
      getUserByName("Morgan")!.createdAt,
    );
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    const agent = await spawn(srv, "Kept", "Mia");

    await removeMember(srv, "Mia", morgan.rawSessionId);
    expect(managerOf(srv, agent.id)).toBe(idOf("Morgan"));
    await removeMember(srv, "Morgan", olga.rawSessionId);
    expect(managerOf(srv, agent.id)).toBe(idOf("Olga"));

    const res = await restore(srv, miaId, olga.rawSessionId);
    expect(res.movedBack.agentIds).toEqual([]);
    expect(res.stayed.agentIds).toEqual([agent.id]);
    expect(managerOf(srv, agent.id)).toBe(idOf("Olga"));
  });
});

describe("restoring a member: schedules, webhooks and rooms", () => {
  it("moves back the schedules and webhooks the heir still owns, still off; one the heir passed on or deleted stays", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    const mia = await srv.seedMember("Mia");
    await srv.seedMember("Bob");
    const miaId = idOf("Mia");
    const morganId = idOf("Morgan");
    const addJob = (name: string) =>
      srv.cronjobManager.addCronjob({
        name,
        schedule: { type: "interval", minutes: 60 },
        prompt: "p",
        cwd: srv.stateRoot,
        agentType: "claude",
        modelFamily: "opus",
        effort: "medium",
        permissionMode: "bypassPermissions",
        username: "Mia",
        userId: miaId,
      });
    const kept = addJob("kept");
    const passedOn = addJob("passed on");
    const addHook = async (name: string) => {
      const r = await api(srv, "/api/webhooks", {
        method: "POST",
        rawSessionId: mia.rawSessionId,
        body: {
          name,
          scheme: "github-hmac-sha256",
          rules: [{ event: "push" }],
          enabled: true,
          target: { kind: "cronjob", cronjobId: kept.id },
        },
      });
      expect(r.status).toBe(201);
      return (r.body as { id: string }).id;
    };
    const keptHook = await addHook("kept");
    const deletedHook = await addHook("deleted");
    const job = (id: string) =>
      srv.cronjobManager.listCronjobs().find((j) => j.id === id);
    const hook = async (id: string) => {
      const r = await api(srv, `/api/webhooks/${id}`, {
        rawSessionId: owner.rawSessionId,
      });
      return r.status === 200
        ? (r.body as { userId: string; enabled: boolean })
        : null;
    };
    expect(job(kept.id)?.enabled).toBe(true);
    expect((await hook(keptHook))?.enabled).toBe(true);

    await removeMember(srv, "Mia", owner.rawSessionId);
    expect(job(kept.id)).toMatchObject({ userId: morganId, enabled: false });
    expect(await hook(keptHook)).toMatchObject({
      userId: morganId,
      enabled: false,
    });
    // The heir passes one schedule on and deletes one webhook.
    srv.cronjobManager.setCronjobOwner(passedOn.id, idOf("Bob"), "Bob");
    expect(
      (
        await api(srv, `/api/webhooks/${deletedHook}`, {
          method: "DELETE",
          rawSessionId: owner.rawSessionId,
        })
      ).status,
    ).toBeLessThan(300);

    const res = await restore(srv, miaId, owner.rawSessionId);
    expect(res.movedBack.cronjobIds).toEqual([kept.id]);
    expect(res.stayed.cronjobIds).toEqual([passedOn.id]);
    expect(res.movedBack.webhookIds).toEqual([keptHook]);
    expect(res.stayed.webhookIds).toEqual([deletedHook]);
    expect(job(kept.id)).toMatchObject({ userId: miaId, enabled: false });
    expect(job(passedOn.id)?.userId).toBe(idOf("Bob"));
    expect(await hook(keptHook)).toMatchObject({
      userId: miaId,
      enabled: false,
    });
  });

  it("drops the rooms closed while the member was removed from their room access", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    const studio = srv.agentManager.createRoom("Studio");
    const attic = srv.agentManager.createRoom("Attic");
    expect(
      (
        await api(srv, "/api/users/Mia/access", {
          method: "PUT",
          rawSessionId: owner.rawSessionId,
          body: { allowedRooms: [studio, attic] },
        })
      ).status,
    ).toBeLessThan(300);
    await removeMember(srv, "Mia", owner.rawSessionId);
    expect(srv.agentManager.closeRoom(attic)).toBe(true);
    // The archived record still names the closed room.
    expect(
      (await listRemoved(srv, owner.rawSessionId))[0].user.allowedRooms,
    ).toEqual([studio, attic]);

    const res = await restore(srv, miaId, owner.rawSessionId);
    expect(res.user.allowedRooms).toEqual([studio]);
    expect(getUserByName("Mia")?.allowedRooms).toEqual([studio]);
  });
});

describe("at boot", () => {
  it("an unfinished removal leaves the member live and no entry; a member past 30 days is purged", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const mia = getUserByName("Mia")!;
    const empty = { secrets: [], mcpServers: [] };
    const passed = {
      agentIds: [],
      killedAgentIds: [],
      cronjobIds: [],
      webhookIds: [],
    };
    // A crash after the archive step and before the live deletes.
    archiveRemovedMember(
      {
        user: mia,
        removedAt: Date.now(),
        removedBy: "Morgan",
        heirId: null,
        heirName: null,
        passed,
      },
      empty,
    );
    // A member removed 31 days ago.
    archiveRemovedMember(
      {
        user: { ...mia, id: "abcdef01", name: "Old" },
        removedAt: Date.now() - REMOVED_MEMBER_RETENTION_MS - 24 * 3600_000,
        removedBy: "Morgan",
        heirId: null,
        heirName: null,
        passed,
      },
      empty,
    );

    const again = (server = await srv.restart());
    const signedIn = await mintMemberLink("Morgan", "owner");
    const session = await acceptInvite(signedIn.rawToken, {
      userAgent: "test",
    });
    if (!session.ok) throw new Error(session.error);
    void owner;
    expect(await listRemoved(again, session.rawSessionId)).toEqual([]);
    expect(getUserByName("Mia")?.id).toBe(mia.id);
    expect(existsSync(join(again.stateRoot, "removed-members", mia.id))).toBe(
      false,
    );
    expect(
      existsSync(join(again.stateRoot, "removed-members", "abcdef01")),
    ).toBe(false);
  });
});

// The member's own Claude and Codex sign-ins (task 548d607b): signed out at
// the removal, and their provider homes, conversations included, deleted at
// the purge. Boot deletes the homes of ids that are neither live nor removed.
const SIGN_IN = { claude: ".credentials.json", codex: "auth.json" } as const;
const PROVIDERS = ["claude", "codex"] as const;

// A member's two homes, each signed in with a conversation beside it.
function seedHomes(userId: string): void {
  for (const provider of PROVIDERS) {
    const home = personalProviderHome(userId, provider);
    mkdirSync(join(home, "conversations"), { recursive: true });
    writeFileSync(join(home, SIGN_IN[provider]), "{}");
    writeFileSync(join(home, "conversations", "s.jsonl"), "{}");
    activatePersonalProvider(userId, provider);
  }
}

const homesOf = (srv: TestServer, userId: string) =>
  join(srv.stateRoot, "provider-homes", userId);
const signedIn = (userId: string, provider: "claude" | "codex") =>
  existsSync(join(personalProviderHome(userId, provider), SIGN_IN[provider]));
const conversationKept = (userId: string, provider: "claude" | "codex") =>
  existsSync(
    join(personalProviderHome(userId, provider), "conversations", "s.jsonl"),
  );
const active = (userId: string) =>
  PROVIDERS.some((provider) => isPersonalProviderActive(userId, provider));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, label: string) {
  for (let i = 0; i < 400 && !pred(); i++) await sleep(5);
  if (!pred()) throw new Error(`waitUntil timed out: ${label}`);
}

describe("the member's own Claude and Codex sign-ins", () => {
  it("are signed out at the removal, the conversations stay, and a restore brings no sign-in back", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    seedHomes(miaId);
    seedHomes(idOf("Morgan"));

    await removeMember(srv, "Mia", owner.rawSessionId);
    for (const provider of PROVIDERS) {
      expect({ provider, signedIn: signedIn(miaId, provider) }).toEqual({
        provider,
        signedIn: false,
      });
      expect(conversationKept(miaId, provider)).toBe(true);
      expect(signedIn(idOf("Morgan"), provider)).toBe(true);
    }
    expect(active(miaId)).toBe(false);
    expect(active(idOf("Morgan"))).toBe(true);

    await restore(srv, miaId, owner.rawSessionId);
    expect(idOf("Mia")).toBe(miaId);
    for (const provider of PROVIDERS)
      expect(signedIn(miaId, provider)).toBe(false);
    expect(active(miaId)).toBe(false);
  });

  it("releases another member's agent whose Claude session is pinned to the removed member's home", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    seedHomes(miaId);
    const info = await srv.agentManager.spawn(
      "Pinned",
      srv.stateRoot,
      "default",
      undefined,
      undefined,
      srv.agentManager.getRooms()[0].id,
      undefined,
      undefined,
      undefined,
      "Morgan",
      "claude",
    );
    if (!info) throw new Error("spawn returned null");
    const sent = srv.agentManager.enqueueMessage(info.id, {
      sender: { kind: "user", username: "Morgan" },
      text: "wake",
    });
    expect(sent.ok).toBe(true);
    await waitUntil(
      () =>
        srv.agentManager.getCurrentSessionId(info.id) !== null &&
        ["idle", "waiting_for_response"].includes(
          srv.agentManager.getAgent(info.id)?.state ?? "",
        ),
      "live",
    );
    // A session from before a manager change, pinned to Mia's home where its
    // transcript is.
    const sessionId = srv.agentManager.getCurrentSessionId(info.id)!;
    const miaClaude = personalProviderHome(miaId, "claude");
    const transcripts = claudeProjectDir(srv.stateRoot, {
      CLAUDE_CONFIG_DIR: miaClaude,
    });
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${sessionId}.jsonl`), "");
    setSessionClaudeConfigDir(info.id, sessionId, miaClaude);
    expect(srv.agentManager.getAgent(info.id)?.dormant).not.toBe(true);

    await removeMember(srv, "Mia", owner.rawSessionId);
    await waitUntil(
      () => srv.agentManager.getAgent(info.id)?.dormant === true,
      "released",
    );
  });

  it("Delete now deletes the provider homes with the conversations, and the sign-in state", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const miaId = idOf("Mia");
    seedHomes(miaId);
    await removeMember(srv, "Mia", owner.rawSessionId);
    // A sign-in state entry the purge must drop too.
    activatePersonalProvider(miaId, "codex");

    const purge = await api(srv, `/api/removed-members/${miaId}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(purge.status).toBe(204);
    expect(existsSync(homesOf(srv, miaId))).toBe(false);
    expect(active(miaId)).toBe(false);
  });

  it("Delete now of an entry whose member is live again keeps the member's homes and sign-ins", async () => {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    const mia = getUserByName("Mia")!;
    seedHomes(mia.id);
    // A crash between the archive and the live deletes leaves this entry.
    archiveRemovedMember(
      {
        user: mia,
        removedAt: Date.now(),
        removedBy: "Morgan",
        heirId: null,
        heirName: null,
        passed: {
          agentIds: [],
          killedAgentIds: [],
          cronjobIds: [],
          webhookIds: [],
        },
      },
      { secrets: [], mcpServers: [] },
    );

    const purge = await api(srv, `/api/removed-members/${mia.id}`, {
      method: "DELETE",
      rawSessionId: owner.rawSessionId,
    });
    expect(purge.status).toBe(204);
    for (const provider of PROVIDERS) {
      expect(signedIn(mia.id, provider)).toBe(true);
      expect(conversationKept(mia.id, provider)).toBe(true);
    }
    expect(active(mia.id)).toBe(true);
  });
});

describe("provider homes at boot", () => {
  const ORPHAN = "0dd1d00d";
  const EXPIRED = "abcdef01";

  // Mia live, Rex removed today, a member removed 31 days ago, and homes of
  // an id the office no longer knows (removed before the 30-day window).
  async function office(): Promise<{
    srv: TestServer;
    miaId: string;
    rexId: string;
  }> {
    const srv = (server = await startTestServer());
    const owner = await srv.seedOwner("Morgan");
    await srv.seedMember("Mia");
    await srv.seedMember("Rex");
    const miaId = idOf("Mia");
    const rexId = idOf("Rex");
    seedHomes(miaId);
    seedHomes(rexId);
    await removeMember(srv, "Rex", owner.rawSessionId);
    activatePersonalProvider(rexId, "claude");
    archiveRemovedMember(
      {
        user: { ...getUserByName("Mia")!, id: EXPIRED, name: "Old" },
        removedAt: Date.now() - REMOVED_MEMBER_RETENTION_MS - 24 * 3600_000,
        removedBy: "Morgan",
        heirId: null,
        heirName: null,
        passed: {
          agentIds: [],
          killedAgentIds: [],
          cronjobIds: [],
          webhookIds: [],
        },
      },
      { secrets: [], mcpServers: [] },
    );
    seedHomes(EXPIRED);
    seedHomes(ORPHAN);
    mkdirSync(join(homesOf(srv, "not.an.id")), { recursive: true });
    return { srv, miaId, rexId };
  }

  it("deletes the homes of an expired member and of an id that is neither live nor removed, and keeps the rest", async () => {
    const { srv, miaId, rexId } = await office();

    const again = (server = await srv.restart());
    expect(existsSync(homesOf(again, EXPIRED))).toBe(false);
    expect(existsSync(homesOf(again, ORPHAN))).toBe(false);
    expect(active(EXPIRED)).toBe(false);
    expect(active(ORPHAN)).toBe(false);
    for (const provider of PROVIDERS)
      expect(signedIn(miaId, provider)).toBe(true);
    expect(active(miaId)).toBe(true);
    // Rex is in Removed members: signed out at the removal, the rest kept.
    expect(conversationKept(rexId, "codex")).toBe(true);
    expect(isPersonalProviderActive(rexId, "claude")).toBe(true);
    expect(existsSync(homesOf(again, "not.an.id"))).toBe(true);
  });

  // The expired member's purge does not depend on the sweep: it runs
  // whenever removed-members.json reads.
  for (const [name, purges, breakStore] of [
    [
      "a users.json that does not parse",
      true,
      (srv: TestServer) =>
        writeFileSync(join(srv.stateRoot, "users.json"), "{ not json"),
    ],
    [
      "a users.json with no owner",
      true,
      (srv: TestServer) => {
        const path = join(srv.stateRoot, "users.json");
        const users = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          { role?: string }
        >;
        for (const user of Object.values(users)) user.role = "member";
        writeFileSync(path, JSON.stringify(users));
      },
    ],
    [
      "a removed-members.json that does not read",
      false,
      (srv: TestServer) =>
        writeFileSync(join(srv.stateRoot, "removed-members.json"), "[]"),
    ],
  ] as const) {
    it(`with ${name}, deletes no home of an id it cannot place`, async () => {
      const { srv, miaId } = await office();
      breakStore(srv);

      const again = (server = await srv.restart());
      expect(existsSync(homesOf(again, ORPHAN))).toBe(true);
      expect(active(ORPHAN)).toBe(true);
      for (const provider of PROVIDERS)
        expect(signedIn(miaId, provider)).toBe(true);
      expect(existsSync(homesOf(again, EXPIRED))).toBe(!purges);
    });
  }
});
