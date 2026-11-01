// "Changed for you" (task 7a3b4114): GET /api/me/integration-changes, the
// member's own list of the Integrations changes someone else made for them,
// read from the audit log through the real route table and server.
//
// Pins: an owner's change to the member's variables, secrets, MCP servers,
// voice and pager shows, newest first, by the human who made it (an agent's
// change names its manager); the member's own changes (cookie, own token, own
// agent) and changes for another member never show; no value ever does; at
// most 20 items from the last 30 days, and a busy member's unrelated audit
// rows do not push a change out; a rename keeps the history. The member's
// cookie or own API token reads it, no agent.
//
// Seam: startTestServer(). Zero LLM.

import { afterEach, describe, expect, it } from "bun:test";
import { mintApiToken } from "../api-tokens.ts";
import { officeAuditStore } from "../audit-store.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const VAR_VALUE = "fake-variable-value-7a3b";
const SECRET_VALUE = "fake-secret-value-7a3b";
const WEBHOOK_TOKEN = "SeCrEt_WeBhOoK-7a3b";
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
const OWNER_AGENT_ID = "feed-owner-agent-7a3b";
const DAY = 24 * 60 * 60 * 1000;
const FEED = "/api/me/integration-changes";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
  text: string;
}

type Auth = { session?: string; bearer?: string };

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: Auth & { body?: unknown } = {},
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
  return { status: response.status, body, text };
}

interface Item {
  time: number;
  by: string;
  kind: string;
  action: string;
  name?: string;
}

async function office() {
  const srv = await startTestServer({
    startServer: {
      pagerFetch: async () => new Response(null, { status: 204 }),
    },
  });
  server = srv;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Mia");
  const other = await srv.seedMember("Olly");
  const ownerId = getUserByName(owner.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  const api = async (userId: string) =>
    (await mintApiToken({ userId, name: "API", expiresInDays: null })).token;
  return {
    srv,
    owner,
    member,
    other,
    ownerId,
    memberId,
    ownerApi: await api(ownerId),
    memberApi: await api(memberId),
    ownerAgent: mintAgentToken(OWNER_AGENT_ID, ownerId, true),
    memberAgent: mintAgentToken("feed-member-agent-7a3b", memberId, true),
    base: `/api/users/${member.username}`,
  };
}

type Office = Awaited<ReturnType<typeof office>>;

async function expectOk(r: Promise<Res>, what: string) {
  const res = await r;
  expect({ what, ok: res.status >= 200 && res.status < 300 }).toEqual({
    what,
    ok: true,
  });
}

async function setVar(o: Office, auth: Auth, username: string, name: string) {
  await expectOk(
    call(o.srv, "PUT", `/api/users/${username}/env/${name}`, {
      ...auth,
      body: { value: VAR_VALUE },
    }),
    `set ${name}`,
  );
}

async function feed(o: Office, auth: Auth): Promise<Item[]> {
  const r = await call(o.srv, "GET", FEED, auth);
  expect(r.status).toBe(200);
  return (r.body as { items: Item[] }).items;
}

const rows = (items: Item[]) =>
  items.map((i) => [i.kind, i.action, i.name ?? null, i.by]);

describe("integration changes: what the member sees", () => {
  it("lists each change an owner made for the member, newest first, by the human, with no value", async () => {
    const o = await office();
    const start = Date.now();
    const owner = { session: o.owner.rawSessionId };
    await setVar(o, owner, o.member.username, "OPENAI_VOICE_API_KEY");
    await expectOk(
      call(o.srv, "POST", `${o.base}/secrets`, {
        bearer: o.ownerApi,
        body: {
          name: "M_TOKEN",
          value: SECRET_VALUE,
          hosts: ["api.example.com"],
          form: { kind: "authorization" },
        },
      }),
      "secret",
    );
    await expectOk(
      call(o.srv, "POST", `${o.base}/mcp-servers`, {
        bearer: o.ownerAgent,
        body: {
          name: "docs",
          url: "https://docs.example.com/mcp",
          secret: null,
        },
      }),
      "mcp",
    );
    await expectOk(
      call(o.srv, "PATCH", `${o.base}/voice`, {
        bearer: o.ownerAgent,
        body: { voiceInput: "openai" },
      }),
      "voice",
    );
    await expectOk(
      call(o.srv, "PATCH", `${o.base}/pager-settings`, {
        ...owner,
        body: { webhookUrl: WEBHOOK },
      }),
      "pager",
    );
    // Test sends a message; it changes nothing.
    await expectOk(
      call(o.srv, "POST", `${o.base}/pager-settings/test`, owner),
      "pager test",
    );
    await expectOk(
      call(o.srv, "DELETE", `${o.base}/env/OPENAI_VOICE_API_KEY`, owner),
      "remove",
    );
    // The member's own changes, by every way the member acts.
    await setVar(
      o,
      { session: o.member.rawSessionId },
      o.member.username,
      "SELF_VAR",
    );
    await setVar(o, { bearer: o.memberApi }, o.member.username, "TOKEN_VAR");
    await setVar(o, { bearer: o.memberAgent }, o.member.username, "AGENT_VAR");
    // A change for another member.
    await setVar(o, owner, o.other.username, "OLLY_VAR");

    const res = await call(o.srv, "GET", FEED, {
      session: o.member.rawSessionId,
    });
    expect(res.status).toBe(200);
    const items = (res.body as { items: Item[] }).items;
    expect(rows(items)).toEqual([
      ["variable", "removed", "OPENAI_VOICE_API_KEY", "Morgan"],
      ["pager", "set", null, "Morgan"],
      ["voice", "set", null, "Morgan"],
      ["mcp", "set", "docs", "Morgan"],
      ["secret", "set", "M_TOKEN", "Morgan"],
      ["variable", "set", "OPENAI_VOICE_API_KEY", "Morgan"],
    ]);
    for (const item of items) {
      expect(item.time).toBeGreaterThanOrEqual(start);
      expect(item.time).toBeLessThanOrEqual(Date.now());
    }
    for (const leak of [VAR_VALUE, SECRET_VALUE, WEBHOOK_TOKEN, OWNER_AGENT_ID])
      expect(res.text).not.toContain(leak);

    // The member's own API token reads the same list.
    expect(await feed(o, { bearer: o.memberApi })).toEqual(items);
    // Each member reads only their own: nobody changed the owner's.
    expect(await feed(o, owner)).toEqual([]);
    expect(rows(await feed(o, { session: o.other.rawSessionId }))).toEqual([
      ["variable", "set", "OLLY_VAR", "Morgan"],
    ]);
  });

  it("an agent token never reads it, and a limited API token needs the environment area", async () => {
    const o = await office();
    for (const bearer of [o.memberAgent, o.ownerAgent]) {
      const r = await call(o.srv, "GET", FEED, { bearer });
      expect(r.status).toBe(403);
    }
    const limited = async (areas: Record<string, "read" | "write">) =>
      (
        await mintApiToken({
          userId: o.memberId,
          name: "Limited",
          expiresInDays: null,
          limits: { areas },
        })
      ).token;
    expect(
      (
        await call(o.srv, "GET", FEED, {
          bearer: await limited({ voice: "write" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(o.srv, "GET", FEED, {
          bearer: await limited({ environment: "read" }),
        })
      ).status,
    ).toBe(200);
  });
});

describe("integration changes: what drops out", () => {
  // The member's own changes and other operations on the member's record
  // (users.update targets the member's id too) must not fill the 20 slots
  // before the change that is for them.
  it("keeps a change visible behind many unrelated rows, and returns at most 20", async () => {
    const o = await office();
    const owner = { session: o.owner.rawSessionId };
    await setVar(o, owner, o.member.username, "FOR_YOU");
    for (let i = 0; i < 25; i++) {
      await setVar(
        o,
        { session: o.member.rawSessionId },
        o.member.username,
        `SELF_${i}`,
      );
      await expectOk(
        call(o.srv, "PATCH", `/api/users/${o.member.username}`, {
          ...owner,
          body: { avatarColor: i % 2 ? "#123456" : "#654321" },
        }),
        `avatar ${i}`,
      );
    }
    expect(rows(await feed(o, { session: o.member.rawSessionId }))).toEqual([
      ["variable", "set", "FOR_YOU", "Morgan"],
    ]);

    for (let i = 0; i < 22; i++)
      await setVar(o, owner, o.member.username, `MANY_${i}`);
    const items = await feed(o, { session: o.member.rawSessionId });
    expect(items).toHaveLength(20);
    expect(items[0].name).toBe("MANY_21");
    expect(items[19].name).toBe("MANY_2");
  });

  it("drops changes older than 30 days, and keeps the history across a rename", async () => {
    const o = await office();
    const owner = { session: o.owner.rawSessionId };
    await setVar(o, owner, o.member.username, "OLD_VAR");
    await setVar(o, owner, o.member.username, "RECENT_VAR");
    // Age the two rows in place: the rows are the server's own, only their
    // time moves.
    const db = officeAuditStore().db;
    const age = (name: string, days: number) => {
      const time = Date.now() - days * DAY;
      const changed = db
        .query(
          `UPDATE audit SET time=?, record=json_set(record,'$.time',?) WHERE sequence IN (SELECT sequence FROM audit_targets WHERE target=?)`,
        )
        .run(time, time, name);
      expect(changed.changes).toBe(1);
    };
    age("OLD_VAR", 31);
    age("RECENT_VAR", 29);
    expect(rows(await feed(o, { session: o.member.rawSessionId }))).toEqual([
      ["variable", "set", "RECENT_VAR", "Morgan"],
    ]);

    await expectOk(
      call(o.srv, "PATCH", `/api/users/${o.member.username}`, {
        ...owner,
        body: { name: "Mina" },
      }),
      "rename",
    );
    expect(getUserByName("Mina")?.id).toBe(o.memberId);
    await setVar(o, owner, "Mina", "AFTER_RENAME");
    expect(rows(await feed(o, { session: o.member.rawSessionId }))).toEqual([
      ["variable", "set", "AFTER_RENAME", "Morgan"],
      ["variable", "set", "RECENT_VAR", "Morgan"],
    ]);
  });
});
