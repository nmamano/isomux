// Privileged agents change the office settings (Nil, 2026-10-14): the office
// prompt, the office name, the member usage cap switch and the members' share,
// on GET/PUT /api/office/settings, while the manager is an office owner; so does
// an office owner's API token (Lead, 2026-10-14). The check is live on each
// request. Everyone else keeps the owner-only rule, the
// legacy envFile stays out of the wire, and the other office:admin routes stay
// with humans.

import { afterEach, describe, expect, it } from "bun:test";

import { mintAgentToken } from "../identity/tokens.ts";
import { mintApiToken } from "../api-tokens.ts";
import { getUserByName, setUserRoleById } from "../users.ts";
import { memberUsageCap } from "../member-usage-cap.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
}

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: { session?: string; bearer?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await srv.http(path, {
    method,
    headers,
    rawSessionId: init.session,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 204 has no body.
  }
  return { status: response.status, body };
}

interface Settings {
  prompt: string | null;
  name: string | null;
  version: string;
  memberUsageCap: boolean;
  memberUsageShare: number;
}

async function office() {
  server = await startTestServer();
  const srv = server;
  const boss = await srv.seedOwner("Boss");
  const member = await srv.seedMember("Member");
  const bossId = getUserByName(boss.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  return {
    srv,
    boss,
    member,
    bossId,
    ownerAgent: mintAgentToken("boss-privileged", bossId, true),
    ownerPlain: mintAgentToken("boss-plain", bossId, false),
    memberAgent: mintAgentToken("member-privileged", memberId, true),
  };
}

async function read(srv: TestServer, bearer: string): Promise<Settings> {
  const res = await call(srv, "GET", "/api/office/settings", { bearer });
  expect(res.status).toBe(200);
  return res.body as Settings;
}

// The version from a read and only the changed fields, as the agent reference
// page tells an agent to write.
async function change(
  srv: TestServer,
  bearer: string,
  fields: Partial<Settings> & Record<string, unknown>,
): Promise<number> {
  const current = await read(srv, bearer);
  const res = await call(srv, "PUT", "/api/office/settings", {
    bearer,
    body: { version: current.version, ...fields },
  });
  return res.status;
}

describe("an owner's privileged agent", () => {
  it("changes each of the four office settings", async () => {
    const o = await office();
    const bearer = o.ownerAgent;
    const before = await read(o.srv, bearer);

    expect(await change(o.srv, bearer, { prompt: "Office rules." })).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings().prompt).toBe("Office rules.");

    expect(await change(o.srv, bearer, { name: "Acme" })).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings().name).toBe("Acme");

    const share = before.memberUsageShare === 50 ? 60 : 50;
    expect(await change(o.srv, bearer, { memberUsageShare: share })).toBe(204);
    expect((await read(o.srv, bearer)).memberUsageShare).toBe(share);

    // Last: while the cap is on, the GET reads the providers.
    expect(before.memberUsageCap).toBe(false);
    expect(await change(o.srv, bearer, { memberUsageCap: true })).toBe(204);
    expect(memberUsageCap().isEnabled()).toBe(true);

    // The earlier changes hold.
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt: "Office rules.", name: "Acme" }),
    );
    expect(memberUsageCap().share()).toBe(share);
    // No reset needed: the next startTestServer wipes STATE_ROOT, and
    // startServer drops the cap module (resetMemberUsageCap).
  });

  it("keeps the office prompt when a PUT leaves it out, and clears it on null", async () => {
    const o = await office();
    expect(
      await change(o.srv, o.ownerAgent, { prompt: "Line one\n\n- two  ü" }),
    ).toBe(204);
    // The bytes as stored (the store trims the edges).
    const prompt = o.srv.agentManager.getOfficeSettings().prompt;
    expect(prompt).toBe("Line one\n\n- two  ü");
    expect(await change(o.srv, o.ownerAgent, { name: "Renamed" })).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt, name: "Renamed" }),
    );
    // The row of the PUT with no prompt still keeps the stored prompt.
    const audit = await call(
      o.srv,
      "GET",
      "/api/audit-log?operation=office.setSettings",
      { session: o.boss.rawSessionId },
    );
    const [row] = (audit.body as { items: { promptContent?: string }[] }).items;
    expect(row.promptContent).toBe(prompt ?? "");

    expect(await change(o.srv, o.ownerAgent, { prompt: null })).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt: null, name: "Renamed" }),
    );
  });

  it("never reads or changes the legacy envFile", async () => {
    const o = await office();
    o.srv.agentManager.setOfficeSettings(null, "/legacy/office.env", null);
    const settings = await read(o.srv, o.ownerAgent);
    expect(Object.keys(settings)).not.toContain("envFile");
    expect(
      await change(o.srv, o.ownerAgent, {
        prompt: "P",
        envFile: "/agent/chosen.env",
      }),
    ).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt: "P", envFile: "/legacy/office.env" }),
    );
    expect(Object.keys(await read(o.srv, o.ownerAgent))).not.toContain(
      "envFile",
    );
  });

  it("is checked live: after its manager loses the owner role, the next GET and PUT get 403", async () => {
    const o = await office();
    expect(await change(o.srv, o.ownerAgent, { name: "Before" })).toBe(204);
    const { version } = await read(o.srv, o.ownerAgent);
    expect(setUserRoleById(o.bossId, "member")).toBe(true);
    expect(
      (
        await call(o.srv, "GET", "/api/office/settings", {
          bearer: o.ownerAgent,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(o.srv, "PUT", "/api/office/settings", {
          bearer: o.ownerAgent,
          body: { prompt: null, name: "After", version },
        })
      ).status,
    ).toBe(403);
    expect(o.srv.agentManager.getOfficeSettings().name).toBe("Before");
  });

  it("gets no other office:admin route", async () => {
    const o = await office();
    for (const [method, path, body] of [
      ["GET", "/api/office/access", undefined],
      ["GET", "/api/office/update", undefined],
      ["POST", "/api/storage/prune", {}],
    ] as const) {
      const res = await call(o.srv, method, path, {
        bearer: o.ownerAgent,
        body,
      });
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  it("is named in the audit row of its write", async () => {
    const o = await office();
    expect(await change(o.srv, o.ownerAgent, { name: "Acme" })).toBe(204);
    const audit = await call(
      o.srv,
      "GET",
      "/api/audit-log?operation=office.setSettings",
      { session: o.boss.rawSessionId },
    );
    const row = (
      audit.body as {
        items: { actor: { kind: string; id: string; ownerId?: string } }[];
      }
    ).items[0];
    expect(row.actor).toEqual(
      expect.objectContaining({
        kind: "agent",
        id: "boss-privileged",
        ownerId: o.bossId,
      }),
    );
  });
});

describe("an owner's API token", () => {
  it("reads and changes the office settings, as its owner's privileged agent does", async () => {
    const o = await office();
    const { token } = await mintApiToken({
      userId: o.bossId,
      name: "Boss token",
      expiresInDays: null,
    });
    const settings = await read(o.srv, token);
    expect(Object.keys(settings)).not.toContain("envFile");
    expect(await change(o.srv, token, { name: "Via token" })).toBe(204);
    expect(o.srv.agentManager.getOfficeSettings().name).toBe("Via token");
    expect(setUserRoleById(o.bossId, "member")).toBe(true);
    expect(
      (await call(o.srv, "GET", "/api/office/settings", { bearer: token }))
        .status,
    ).toBe(403);
  });
});

describe("every other caller keeps the owner-only rule", () => {
  it("refuses a member's privileged agent, an owner's ordinary agent, a member's API token and a member on GET and PUT", async () => {
    const o = await office();
    const { version } = await read(o.srv, o.ownerAgent);
    const { token: memberApi } = await mintApiToken({
      userId: getUserByName(o.member.username)!.id,
      name: "Member token",
      expiresInDays: null,
    });
    for (const [who, auth] of [
      ["member's privileged agent", { bearer: o.memberAgent }],
      ["owner's ordinary agent", { bearer: o.ownerPlain }],
      ["member's API token", { bearer: memberApi }],
      ["member", { session: o.member.rawSessionId }],
    ] as const) {
      const get = await call(o.srv, "GET", "/api/office/settings", auth);
      const put = await call(o.srv, "PUT", "/api/office/settings", {
        ...auth,
        body: { prompt: "X", name: "X", version },
      });
      expect([who, get.status, put.status]).toEqual([who, 403, 403]);
    }
    expect(o.srv.agentManager.getOfficeSettings()).toEqual(
      expect.objectContaining({ prompt: null, name: null }),
    );
  });
});
