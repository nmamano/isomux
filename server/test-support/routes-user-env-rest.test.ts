import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
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

async function officeRequest(
  srv: TestServer,
  init: {
    method?: string;
    body?: unknown;
    session?: string;
    bearer?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http("/api/office/env", {
    method: init.method ?? "GET",
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
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
});

describe("managed office env routes", () => {
  it("allows owner cookies and API tokens without exposing values to members or agents", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Member");
    const ownerId = getUserByName(owner.username)!.id;
    const memberId = getUserByName(member.username)!.id;
    const ownerApi = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    const memberApi = await mintApiToken({
      userId: memberId,
      name: "Member API",
      expiresInDays: null,
    });
    const agent = mintAgentToken("office-env-agent", ownerId, false);
    const privileged = mintAgentToken("office-env-privileged", ownerId, true);

    expect(
      (
        await officeRequest(server, {
          method: "PUT",
          session: owner.rawSessionId,
          body: { values: { GH_TOKEN: "office" } },
        })
      ).status,
    ).toBe(204);
    expect(
      (await officeRequest(server, { session: owner.rawSessionId })).body,
    ).toEqual({ mode: "managed", values: { GH_TOKEN: "office" } });
    expect(
      (await officeRequest(server, { bearer: ownerApi.token })).status,
    ).toBe(200);
    expect(
      (await officeRequest(server, { session: member.rawSessionId })).status,
    ).toBe(403);
    expect(
      (await officeRequest(server, { bearer: memberApi.token })).status,
    ).toBe(403);
    expect((await officeRequest(server, { bearer: agent })).status).toBe(403);
    expect((await officeRequest(server, { bearer: privileged })).status).toBe(
      403,
    );
  });
});

// GET /api/users/:username/env/names - the office owner's read of WHICH
// variables somebody else has set. Sibling of the routes above, and the one
// managed-env route whose subject is not the caller, so the whole test is about
// who is refused and about the values never appearing in a body.
describe("managed user env names route", () => {
  it("gives an office owner the names, refuses everyone else, and never carries a value", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Member");
    const ownerId = getUserByName(owner.username)!.id;
    const memberId = getUserByName(member.username)!.id;
    const ownerApi = await mintApiToken({
      userId: ownerId,
      name: "Owner API",
      expiresInDays: null,
    });
    const memberApi = await mintApiToken({
      userId: memberId,
      name: "Member API",
      expiresInDays: null,
    });
    const plainAgent = mintAgentToken("names-agent", ownerId, false);
    const privilegedAgent = mintAgentToken("names-privileged", ownerId, true);
    const secret = "do-not-echo-this-secret";

    // The member fills their own managed file through the self route.
    expect(
      (
        await request(server, member.username, {
          method: "PUT",
          session: member.rawSessionId,
          body: { values: { ZED_TOKEN: secret, ANTHROPIC_API_KEY: secret } },
        })
      ).status,
    ).toBe(204);

    const ownerRead = await request(server, member.username, {
      suffix: "/names",
      session: owner.rawSessionId,
    });
    const ownerApiRead = await request(server, member.username, {
      suffix: "/names",
      bearer: ownerApi.token,
    });
    const statuses = {
      ownerCookie: ownerRead.status,
      ownerApi: ownerApiRead.status,
      // A member is refused even for their OWN names: values reach them
      // through userEnv.get, so this route is never theirs.
      memberCookieOnSelf: (
        await request(server, member.username, {
          suffix: "/names",
          session: member.rawSessionId,
        })
      ).status,
      memberCookieOnOwner: (
        await request(server, owner.username, {
          suffix: "/names",
          session: member.rawSessionId,
        })
      ).status,
      memberApi: (
        await request(server, member.username, {
          suffix: "/names",
          bearer: memberApi.token,
        })
      ).status,
      // An agent spawned by the OWNER still fails: officeEnvOwner gates on
      // scope, not on whose userId the token carries.
      plainAgent: (
        await request(server, member.username, {
          suffix: "/names",
          bearer: plainAgent,
        })
      ).status,
      privilegedAgent: (
        await request(server, member.username, {
          suffix: "/names",
          bearer: privilegedAgent,
        })
      ).status,
      unknownUser: (
        await request(server, "nobody", {
          suffix: "/names",
          session: owner.rawSessionId,
        })
      ).status,
    };

    expect(statuses).toEqual({
      ownerCookie: 200,
      ownerApi: 200,
      memberCookieOnSelf: 403,
      memberCookieOnOwner: 403,
      memberApi: 403,
      plainAgent: 403,
      privilegedAgent: 403,
      unknownUser: 404,
    });
    expect(ownerRead.body).toEqual({
      names: ["ANTHROPIC_API_KEY", "ZED_TOKEN"],
    });
    expect(ownerApiRead.body).toEqual(ownerRead.body);
    expect(JSON.stringify(ownerRead.body)).not.toContain(secret);
  });

  it("answers an empty list for a user who has set nothing", async () => {
    server = await startTestServer();
    const owner = await server.seedOwner("Boss");
    const member = await server.seedMember("Member");
    const read = await request(server, member.username, {
      suffix: "/names",
      session: owner.rawSessionId,
    });
    expect({ status: read.status, body: read.body }).toEqual({
      status: 200,
      body: { names: [] },
    });
  });
});
