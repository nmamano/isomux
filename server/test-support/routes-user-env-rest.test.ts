import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName, updateUserById } from "../users.ts";
import {
  managedUserEnvPath,
  managedUserEnvExists,
  readManagedUserEnv,
  writeManagedUserEnv,
} from "../user-env.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function request(
  srv: TestServer,
  username: string,
  init: {
    method?: string;
    body?: unknown;
    session?: string;
    bearer?: string;
    suffix?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(
    `/api/users/${encodeURIComponent(username)}/env${init.suffix ?? ""}`,
    {
      method: init.method ?? "GET",
      headers,
      rawSessionId: init.session,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A successful write has no response body.
  }
  return { status: response.status, body };
}

describe("managed user env routes", () => {
  it("admits only the owning cookie or API identity and refuses both agent classes", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const other = await server.seedMember("Other");
    const ownerId = getUserByName(owner.username)!.id;
    const otherId = getUserByName(other.username)!.id;
    const ownerApi = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    const otherApi = await mintApiToken({
      userId: otherId,
      name: "Other API",
      expiresInDays: null,
    });
    const plainAgent = mintAgentToken("plain-env-agent", ownerId, false);
    const privilegedAgent = mintAgentToken(
      "privileged-env-agent",
      ownerId,
      true,
    );
    const values = { SECRET: "owner-only" };

    const ownCookieWrite = await request(server, owner.username, {
      method: "PUT",
      session: owner.rawSessionId,
      body: { values },
    });
    const ownCookieRead = await request(server, owner.username, {
      session: owner.rawSessionId,
    });
    const statuses = {
      ownCookieWrite: ownCookieWrite.status,
      ownCookieRead: ownCookieRead.status,
      otherCookie: (
        await request(server, other.username, { session: owner.rawSessionId })
      ).status,
      ownApi: (
        await request(server, owner.username, { bearer: ownerApi.token })
      ).status,
      otherApi: (
        await request(server, owner.username, { bearer: otherApi.token })
      ).status,
      plainAgent: (
        await request(server, owner.username, { bearer: plainAgent })
      ).status,
      privilegedAgent: (
        await request(server, owner.username, { bearer: privilegedAgent })
      ).status,
    };
    expect(statuses).toEqual({
      ownCookieWrite: 204,
      ownCookieRead: 200,
      otherCookie: 403,
      ownApi: 200,
      otherApi: 403,
      plainAgent: 403,
      privilegedAgent: 403,
    });
    expect(ownCookieRead.body).toEqual({ mode: "managed", values });
  });

  it("rejects unsafe input without putting values in the error", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const secret = "do-not-echo-this-secret";
    const badKey = await request(server, owner.username, {
      method: "PUT",
      session: owner.rawSessionId,
      body: { values: { "BAD-KEY": secret } },
    });
    const badValue = await request(server, owner.username, {
      method: "PUT",
      session: owner.rawSessionId,
      body: { values: { SAFE_KEY: `${secret}\nsecond-line` } },
    });

    expect(badKey.status).toBe(400);
    expect(JSON.stringify(badKey.body)).not.toContain(secret);
    expect(badValue.status).toBe(400);
    expect(JSON.stringify(badValue.body)).not.toContain(secret);
  });

  it("reports legacy mode without reading values and imports only into an absent managed file", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const ownerRecord = getUserByName(owner.username)!;
    const custom = join(server.stateRoot, "legacy-owner.env");
    const original = "CUSTOM_SECRET='legacy value'\n";
    writeFileSync(custom, original, { mode: 0o600 });
    expect(updateUserById(ownerRecord.id, { envFile: custom }).ok).toBe(true);

    const legacy = await request(server, owner.username, {
      session: owner.rawSessionId,
    });
    expect(legacy).toEqual({
      status: 200,
      body: { mode: "custom", path: custom },
    });
    expect(JSON.stringify(legacy.body)).not.toContain("legacy value");

    writeManagedUserEnv(ownerRecord.id, { EXISTING: "keep" });
    const collision = await request(server, owner.username, {
      method: "POST",
      session: owner.rawSessionId,
      suffix: "/import",
    });
    expect(collision.status).toBe(409);
    expect(readFileSync(custom, "utf8")).toBe(original);
    expect(readManagedUserEnv(ownerRecord.id)).toEqual({ EXISTING: "keep" });
    expect(getUserByName(owner.username)!.envFile).toBe(custom);
  });

  it("imports a custom file without returning its values", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const record = getUserByName(member.username)!;
    const custom = join(server.stateRoot, "legacy-member.env");
    writeFileSync(custom, "CUSTOM_SECRET='migrated'\n", { mode: 0o600 });
    expect(updateUserById(record.id, { envFile: custom }).ok).toBe(true);

    const imported = await request(server, member.username, {
      method: "POST",
      session: member.rawSessionId,
      suffix: "/import",
    });
    expect(imported).toEqual({ status: 204, body: null });
    expect(getUserByName(member.username)!.envFile).toBeNull();
    expect(readManagedUserEnv(record.id)).toEqual({
      CUSTOM_SECRET: "migrated",
    });
    expect(readFileSync(custom, "utf8")).toContain("migrated");
    expect(readFileSync(managedUserEnvPath(record.id), "utf8")).toBe(
      "CUSTOM_SECRET='migrated'\n",
    );
  });

  it("leaves both sources unchanged when import validation fails", async () => {
    server = await startTestServer();
    await server.seedOwner("Boss");
    const member = await server.seedMember("Mia");
    const record = getUserByName(member.username)!;
    const custom = join(server.stateRoot, "invalid-legacy.env");
    const original = "CUSTOM_SECRET='do-not-echo\nsecond-line'\n";
    writeFileSync(custom, original, { mode: 0o600 });
    expect(updateUserById(record.id, { envFile: custom }).ok).toBe(true);

    const imported = await request(server, member.username, {
      method: "POST",
      session: member.rawSessionId,
      suffix: "/import",
    });
    expect(imported.status).toBe(400);
    expect(JSON.stringify(imported.body)).not.toContain("do-not-echo");
    expect(getUserByName(member.username)!.envFile).toBe(custom);
    expect(readFileSync(custom, "utf8")).toBe(original);
    expect(managedUserEnvExists(record.id)).toBe(false);
  });
});
