// The integrations page's server contract (Nil, 2026-10-13; Lead's option B):
// an office owner manages every member's variables, secrets and MCP servers,
// but never reads a member's variable or secret values; Show returns a
// secret's value to its own member, or an office one to an owner; members
// read the office items as names, hosts and notes. No ordinary agent token
// reaches any of it; a privileged agent's reach is in
// routes-integrations-agents.test.ts. A fake value is checked against every
// response and audit row.

import { afterEach, describe, expect, it } from "bun:test";

import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const FAKE = "fake-integrations-value-0000";
const PATH_TOKEN = "path-token-SEKRIT-0000";
const QUERY_TOKEN = "query-token-SEKRIT-0000";
const OFFICE_SECRET = "MAIL_KEY_DISTINCTNAME";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

interface Res {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
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
  return { status: response.status, body, text, headers: response.headers };
}

const testFetch = async () => new Response("no", { status: 401 });

async function office() {
  server = await startTestServer({
    startServer: { connectionTestFetch: testFetch },
  });
  const srv = server;
  const owner = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Member");
  const other = await srv.seedMember("Other");
  const ownerId = getUserByName(owner.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  const otherId = getUserByName(other.username)!.id;
  const api = async (userId: string) =>
    (await mintApiToken({ userId, name: "API", expiresInDays: null })).token;
  return {
    srv,
    ownerId,
    owner,
    member,
    other,
    ownerApi: await api(ownerId),
    memberApi: await api(memberId),
    otherApi: await api(otherId),
    // Agents of the owner: the owner's reach rides on a privileged agent
    // only, never on an ordinary one, and never to a value.
    plainAgent: mintAgentToken("integrations-plain", ownerId, false),
    privilegedAgent: mintAgentToken("integrations-privileged", ownerId, true),
    memberAgent: mintAgentToken("integrations-member", memberId, true),
    otherAgent: mintAgentToken("integrations-other", otherId, true),
  };
}

type Office = Awaited<ReturnType<typeof office>>;

async function auditRows(o: Office) {
  const audit = await call(o.srv, "GET", "/api/audit-log?limit=500", {
    session: o.owner.rawSessionId,
  });
  expect(audit.status).toBe(200);
  return {
    text: audit.text,
    rows: (
      audit.body as {
        items: {
          operation: string;
          targets: string[];
          fields: string[];
          actor: { id: string; ownerId?: string };
        }[];
      }
    ).items,
  };
}

// The member fills their own items through their own session.
async function seedMember(o: Office) {
  const session = o.member.rawSessionId;
  const base = `/api/users/${o.member.username}`;
  expect(
    (
      await call(o.srv, "POST", `${base}/secrets`, {
        session,
        body: {
          name: "M_TOKEN",
          value: FAKE,
          hosts: ["api.example.com"],
          form: { kind: "authorization" },
        },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call(o.srv, "POST", `${base}/mcp-servers`, {
        session,
        body: {
          name: "docs",
          url: "https://docs.example.com/mcp",
          secret: null,
        },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call(o.srv, "PUT", `${base}/env`, {
        session,
        body: { values: { M_VAR: FAKE }, notes: { M_VAR: "Member note." } },
      })
    ).status,
  ).toBe(204);
}

async function listNames(
  o: Office,
  username: string,
  kind: "secrets" | "mcp-servers",
): Promise<string[]> {
  const user = username === o.owner.username ? o.owner : o.member;
  const res = await call(o.srv, "GET", `/api/users/${username}/${kind}`, {
    session: user.rawSessionId,
  });
  expect(res.status).toBe(200);
  const body = res.body as {
    secrets?: { name: string }[];
    servers?: { name: string }[];
  };
  return (body.secrets ?? body.servers ?? []).map((item) => item.name).sort();
}

async function memberEnv(o: Office) {
  const res = await call(o.srv, "GET", `/api/users/${o.member.username}/env`, {
    session: o.member.rawSessionId,
  });
  expect(res.status).toBe(200);
  return res.body as {
    values: Record<string, string>;
    notes: Record<string, string>;
  };
}

describe("an office owner on a member's integrations", () => {
  for (const via of ["cookie", "API token"] as const) {
    it(`acts on the member's items, never the owner's own, by ${via}`, async () => {
      const o = await office();
      await seedMember(o);
      const auth: Auth =
        via === "cookie"
          ? { session: o.owner.rawSessionId }
          : { bearer: o.ownerApi };
      const base = `/api/users/${o.member.username}`;
      const texts: string[] = [];
      const step = async (
        method: string,
        path: string,
        status: number,
        body?: unknown,
      ) => {
        const res = await call(o.srv, method, `${base}${path}`, {
          ...auth,
          body,
        });
        texts.push(res.text);
        expect([method, path, res.status]).toEqual([method, path, status]);
        return res;
      };

      const secretList = await step("GET", "/secrets", 200);
      expect(
        (secretList.body as { secrets: { name: string }[] }).secrets.map(
          (s) => s.name,
        ),
      ).toEqual(["M_TOKEN"]);
      await step("POST", "/secrets", 201, {
        name: "O_MADE",
        value: `${FAKE}-made`,
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
      });
      await step("PUT", "/secrets/M_TOKEN/value", 200, { value: `${FAKE}-2` });
      await step("PATCH", "/secrets/M_TOKEN", 200, { note: "Owner note." });
      await step("POST", "/secrets/M_TOKEN/reissue", 200);
      await step("POST", "/secrets/M_TOKEN/test", 200);
      await step("POST", "/secrets", 201, {
        name: "O_GONE",
        value: `${FAKE}-gone`,
        hosts: ["api.example.com"],
        form: { kind: "authorization" },
      });
      await step("DELETE", "/secrets/O_GONE", 204);
      const serverList = await step("GET", "/mcp-servers", 200);
      expect(
        (serverList.body as { servers: { name: string }[] }).servers.map(
          (s) => s.name,
        ),
      ).toEqual(["docs"]);
      await step("POST", "/mcp-servers", 201, {
        name: "odocs",
        url: "https://odocs.example.com/mcp",
        secret: null,
      });
      await step("PATCH", "/mcp-servers/docs", 200, { note: "Owner note." });
      await step("POST", "/mcp-servers/docs/test", 200);
      // A server with no OAuth: 409 proves the member's server was found.
      await step("POST", "/mcp-servers/docs/sign-in", 409);
      await step("DELETE", "/mcp-servers/odocs", 204);
      await step("PUT", "/env/O_VAR", 204, { value: `${FAKE}-var` });
      await step("DELETE", "/env/M_VAR", 204);

      // The member's stores changed; the owner's own stayed empty.
      expect(await listNames(o, o.member.username, "secrets")).toEqual([
        "M_TOKEN",
        "O_MADE",
      ]);
      expect(await listNames(o, o.member.username, "mcp-servers")).toEqual([
        "docs",
      ]);
      expect((await memberEnv(o)).values).toEqual({ O_VAR: `${FAKE}-var` });
      expect(await listNames(o, o.owner.username, "secrets")).toEqual([]);
      expect(await listNames(o, o.owner.username, "mcp-servers")).toEqual([]);
      const ownEnv = await call(
        o.srv,
        "GET",
        `/api/users/${o.owner.username}/env`,
        {
          session: o.owner.rawSessionId,
        },
      );
      expect((ownEnv.body as { values: object }).values).toEqual({});

      const store = Bun.file(
        `${o.srv.stateRoot}/secrets/users/${getUserByName(o.member.username)!.id}.json`,
      );
      expect(
        (await store.json()).secrets.find(
          (s: { name: string }) => s.name === "M_TOKEN",
        ).value,
      ).toBe(`${FAKE}-2`);

      // Every owner row names the member; none holds a value.
      const { text, rows } = await auditRows(o);
      const ownerOps = [
        "secrets.create",
        "secrets.rotate",
        "secrets.update",
        "secrets.reissue",
        "secrets.test",
        "secrets.delete",
        "mcpServers.create",
        "mcpServers.update",
        "mcpServers.test",
        "mcpServers.delete",
        "userEnv.set",
        "userEnv.remove",
      ];
      for (const op of ownerOps) {
        const row = rows.find(
          (r) =>
            r.operation === op &&
            (r.actor.id === o.ownerId || r.actor.ownerId === o.ownerId),
        );
        expect([op, row?.targets.includes(o.member.username)]).toEqual([
          op,
          true,
        ]);
      }
      const set = rows.find((r) => r.operation === "userEnv.set")!;
      expect(set.targets).toEqual([o.member.username, "O_VAR"]);
      expect(set.fields).toEqual(["value"]);
      expect(text).not.toContain(FAKE);
      for (const t of texts) expect(t).not.toContain(FAKE);
    });
  }

  it("refuses a member on another member and an agent outside its reach, and every agent on a value", async () => {
    const o = await office();
    await seedMember(o);
    const base = `/api/users/${o.member.username}`;
    const routes: [string, string, unknown?][] = [
      ["GET", "/secrets"],
      [
        "POST",
        "/secrets",
        {
          name: "X",
          value: "x",
          hosts: ["a.example.com"],
          form: { kind: "authorization" },
        },
      ],
      ["PUT", "/secrets/M_TOKEN/value", { value: "x" }],
      ["PATCH", "/secrets/M_TOKEN", { note: "x" }],
      ["DELETE", "/secrets/M_TOKEN"],
      ["POST", "/secrets/M_TOKEN/reissue"],
      ["POST", "/secrets/M_TOKEN/test"],
      ["GET", "/secrets/M_TOKEN/value"],
      ["GET", "/mcp-servers"],
      [
        "POST",
        "/mcp-servers",
        { name: "x", url: "https://x.example.com/mcp", secret: null },
      ],
      ["PATCH", "/mcp-servers/docs", { note: "x" }],
      ["DELETE", "/mcp-servers/docs"],
      ["POST", "/mcp-servers/docs/test"],
      ["POST", "/mcp-servers/docs/sign-in"],
      ["GET", "/env"],
      ["PUT", "/env", { values: {} }],
      ["PUT", "/env/M_VAR", { value: "x" }],
      ["DELETE", "/env/M_VAR"],
    ];
    for (const auth of [
      { session: o.other.rawSessionId },
      { bearer: o.otherApi },
      { bearer: o.plainAgent },
      { bearer: o.otherAgent },
    ])
      for (const [method, path, body] of routes) {
        const res = await call(o.srv, method, `${base}${path}`, {
          ...auth,
          body,
        });
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
    // The owner's and the member's own privileged agents: the value reads,
    // the whole-map write and the sign-in stay closed.
    const valueRoutes = routes.filter(([method, path]) =>
      [
        "GET /secrets/M_TOKEN/value",
        "POST /mcp-servers/docs/sign-in",
        "GET /env",
        "PUT /env",
      ].includes(`${method} ${path}`),
    );
    expect(valueRoutes).toHaveLength(4);
    for (const auth of [
      { bearer: o.privilegedAgent },
      { bearer: o.memberAgent },
    ])
      for (const [method, path, body] of valueRoutes) {
        const res = await call(o.srv, method, `${base}${path}`, {
          ...auth,
          body,
        });
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
    // Nothing moved.
    expect(await listNames(o, o.member.username, "secrets")).toEqual([
      "M_TOKEN",
    ]);
    expect(await listNames(o, o.member.username, "mcp-servers")).toEqual([
      "docs",
    ]);
    expect((await memberEnv(o)).values).toEqual({ M_VAR: FAKE });
  });

  it("answers 404 to an owner for an unknown member, and 403 to a member", async () => {
    const o = await office();
    for (const [method, path, body] of [
      ["GET", "/secrets"],
      ["GET", "/mcp-servers"],
      ["PUT", "/env/X", { value: "x" }],
    ] as [string, string, unknown?][]) {
      const owner = await call(o.srv, method, `/api/users/nobody${path}`, {
        session: o.owner.rawSessionId,
        body,
      });
      const member = await call(o.srv, method, `/api/users/nobody${path}`, {
        session: o.member.rawSessionId,
        body,
      });
      expect([path, owner.status, member.status]).toEqual([path, 404, 403]);
    }
  });
});

describe("Show", () => {
  it("gives a member their own value and an owner the office ones, audited by name", async () => {
    const o = await office();
    await seedMember(o);
    expect(
      (
        await call(o.srv, "POST", "/api/office/secrets", {
          session: o.owner.rawSessionId,
          body: {
            name: "O_TOKEN",
            value: `${FAKE}-office`,
            hosts: ["api.example.com"],
            form: { kind: "authorization" },
          },
        })
      ).status,
    ).toBe(201);
    const mine = `/api/users/${o.member.username}/secrets/M_TOKEN/value`;
    const officeValue = "/api/office/secrets/O_TOKEN/value";

    for (const auth of [
      { session: o.member.rawSessionId },
      { bearer: o.memberApi },
    ]) {
      const res = await call(o.srv, "GET", mine, auth);
      expect([res.status, res.body]).toEqual([200, { value: FAKE }]);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    for (const auth of [
      { session: o.owner.rawSessionId },
      { bearer: o.ownerApi },
    ]) {
      const res = await call(o.srv, "GET", officeValue, auth);
      expect([res.status, res.body]).toEqual([
        200,
        { value: `${FAKE}-office` },
      ]);
    }

    // Ruling 1: an owner never reads a member's secret, whether the name
    // exists or not (no 404 oracle).
    const refused: string[] = [];
    for (const auth of [
      { session: o.owner.rawSessionId },
      { bearer: o.ownerApi },
    ])
      for (const name of ["M_TOKEN", "NO_SUCH"]) {
        const res = await call(
          o.srv,
          "GET",
          `/api/users/${o.member.username}/secrets/${name}/value`,
          auth,
        );
        refused.push(res.text);
        expect([name, res.status]).toEqual([name, 403]);
      }
    for (const auth of [
      { session: o.other.rawSessionId },
      { bearer: o.otherApi },
      { bearer: o.plainAgent },
      { bearer: o.privilegedAgent },
      { bearer: o.memberAgent },
    ]) {
      const res = await call(o.srv, "GET", mine, auth);
      refused.push(res.text);
      expect(res.status).toBe(403);
    }
    for (const auth of [
      { session: o.member.rawSessionId },
      { bearer: o.memberApi },
      { bearer: o.plainAgent },
      { bearer: o.privilegedAgent },
    ]) {
      const res = await call(o.srv, "GET", officeValue, auth);
      refused.push(res.text);
      expect(res.status).toBe(403);
    }
    for (const text of refused) expect(text).not.toContain(FAKE);
    expect(
      (
        await call(
          o.srv,
          "GET",
          `/api/users/${o.member.username}/secrets/NO_SUCH/value`,
          {
            session: o.member.rawSessionId,
          },
        )
      ).status,
    ).toBe(404);

    const { text, rows } = await auditRows(o);
    expect(text).not.toContain(FAKE);
    const reveals = rows
      .filter((r) => r.operation.endsWith(".reveal"))
      .map((r) => [r.operation, r.targets, r.fields]);
    expect(reveals.sort()).toEqual(
      [
        ["officeSecrets.reveal", ["office", "O_TOKEN"], []],
        ["officeSecrets.reveal", ["office", "O_TOKEN"], []],
        ["secrets.reveal", [o.member.username, "M_TOKEN"], []],
        ["secrets.reveal", [o.member.username, "M_TOKEN"], []],
      ].sort(),
    );
  });
});

describe("members reading the office integrations", () => {
  it("get names, hosts and notes only, and owners the full rows", async () => {
    const o = await office();
    const owner = { session: o.owner.rawSessionId };
    expect(
      (
        await call(o.srv, "POST", "/api/office/secrets", {
          ...owner,
          body: {
            name: OFFICE_SECRET,
            value: FAKE,
            hosts: ["mcp.example.com"],
            form: { kind: "header", header: "X-Api-Key" },
            note: "Office secret note.",
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(o.srv, "POST", "/api/office/mcp-servers", {
          ...owner,
          body: {
            name: "mail",
            url: `https://mcp.example.com/${PATH_TOKEN}/mcp?key=${QUERY_TOKEN}`,
            secret: OFFICE_SECRET,
            note: "Office server note.",
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(o.srv, "PUT", "/api/office/env", {
          ...owner,
          body: {
            values: { OFFICE_VAR: FAKE, BARE_VAR: FAKE },
            notes: { OFFICE_VAR: "Office variable note." },
          },
        })
      ).status,
    ).toBe(204);

    for (const auth of [
      { session: o.member.rawSessionId },
      { bearer: o.memberApi },
    ]) {
      const secrets = await call(o.srv, "GET", "/api/office/secrets", auth);
      expect([secrets.status, secrets.body]).toEqual([
        200,
        {
          secrets: [
            {
              name: OFFICE_SECRET,
              hosts: ["mcp.example.com"],
              note: "Office secret note.",
            },
          ],
        },
      ]);
      const servers = await call(o.srv, "GET", "/api/office/mcp-servers", auth);
      expect([servers.status, servers.body]).toEqual([
        200,
        {
          servers: [
            {
              name: "mail",
              host: "mcp.example.com",
              note: "Office server note.",
            },
          ],
        },
      ]);
      for (const leak of [PATH_TOKEN, QUERY_TOKEN, OFFICE_SECRET, FAKE])
        expect(servers.text).not.toContain(leak);
      const names = await call(o.srv, "GET", "/api/office/env/names", auth);
      expect([names.status, names.body]).toEqual([
        200,
        {
          variables: [
            { name: "BARE_VAR", note: null },
            { name: "OFFICE_VAR", note: "Office variable note." },
          ],
        },
      ]);
      for (const res of [secrets, names]) expect(res.text).not.toContain(FAKE);
      // The values stay with the owner.
      expect((await call(o.srv, "GET", "/api/office/env", auth)).status).toBe(
        403,
      );
    }

    for (const auth of [
      { session: o.owner.rawSessionId },
      { bearer: o.ownerApi },
    ]) {
      const secrets = await call(o.srv, "GET", "/api/office/secrets", auth);
      expect(
        (secrets.body as { secrets: Record<string, unknown>[] }).secrets[0],
      ).toEqual(
        expect.objectContaining({
          form: { kind: "header", header: "x-api-key" },
        }),
      );
      const servers = await call(o.srv, "GET", "/api/office/mcp-servers", auth);
      expect(
        (servers.body as { servers: Record<string, unknown>[] }).servers[0],
      ).toEqual(expect.objectContaining({ secret: OFFICE_SECRET }));
      const names = await call(o.srv, "GET", "/api/office/env/names", auth);
      expect(names.status).toBe(200);
      for (const res of [secrets, servers, names])
        expect(res.text).not.toContain(FAKE);
    }

    for (const auth of [{ bearer: o.plainAgent }])
      for (const path of [
        "/api/office/secrets",
        "/api/office/mcp-servers",
        "/api/office/env/names",
      ])
        expect([path, (await call(o.srv, "GET", path, auth)).status]).toEqual([
          path,
          403,
        ]);
  });
});

describe("one variable at a time", () => {
  it("creates, keeps or clears the note, removes, and refuses a bad name", async () => {
    const o = await office();
    await seedMember(o);
    const auth = { session: o.owner.rawSessionId };
    const path = `/api/users/${o.member.username}/env`;
    const put = (name: string, body: unknown) =>
      call(o.srv, "PUT", `${path}/${name}`, { ...auth, body });

    expect((await put("NEW_VAR", { value: FAKE, note: "First." })).status).toBe(
      204,
    );
    expect(await memberEnv(o)).toEqual({
      mode: "managed",
      values: { M_VAR: FAKE, NEW_VAR: FAKE },
      notes: { M_VAR: "Member note.", NEW_VAR: "First." },
    } as never);
    // Value only: the note stays.
    expect((await put("NEW_VAR", { value: `${FAKE}-2` })).status).toBe(204);
    expect((await memberEnv(o)).notes.NEW_VAR).toBe("First.");
    // note null clears it, and leaves the other notes.
    expect(
      (await put("NEW_VAR", { value: `${FAKE}-2`, note: null })).status,
    ).toBe(204);
    expect((await memberEnv(o)).notes).toEqual({ M_VAR: "Member note." });

    const before = await memberEnv(o);
    for (const [name, body] of [
      ["1BAD", { value: "x" }],
      ["__proto__", { value: "x" }],
      ["GOOD", { value: "x", other: 1 }],
      ["GOOD", { note: "x" }],
      ["GOOD", { value: "line\u0001" }],
    ] as [string, unknown][]) {
      const res = await put(name, body);
      expect([name, res.status]).toEqual([name, 400]);
      expect(res.text).not.toContain(FAKE);
    }
    expect(await memberEnv(o)).toEqual(before);

    expect((await call(o.srv, "DELETE", `${path}/NO_SUCH`, auth)).status).toBe(
      404,
    );
    expect((await call(o.srv, "DELETE", `${path}/NEW_VAR`, auth)).status).toBe(
      204,
    );
    expect((await memberEnv(o)).values).toEqual({ M_VAR: FAKE });

    // The member themself, by cookie and API token.
    for (const self of [
      { session: o.member.rawSessionId },
      { bearer: o.memberApi },
    ]) {
      expect(
        (
          await call(o.srv, "PUT", `${path}/SELF_VAR`, {
            ...self,
            body: { value: "s" },
          })
        ).status,
      ).toBe(204);
      expect(
        (await call(o.srv, "DELETE", `${path}/SELF_VAR`, self)).status,
      ).toBe(204);
    }

    // The owner names and notes, never the values.
    const names = await call(o.srv, "GET", `${path}/names`, auth);
    expect(names.status).toBe(200);
    expect(names.body).toEqual(
      expect.objectContaining({
        names: ["M_VAR"],
        notes: { M_VAR: "Member note." },
      }),
    );
    expect(names.text).not.toContain(FAKE);
    // The values and the whole-map write stay the member's own.
    for (const owner of [
      { session: o.owner.rawSessionId },
      { bearer: o.ownerApi },
    ]) {
      expect((await call(o.srv, "GET", path, owner)).status).toBe(403);
      expect(
        (await call(o.srv, "PUT", path, { ...owner, body: { values: {} } }))
          .status,
      ).toBe(403);
    }
    expect((await memberEnv(o)).values).toEqual({ M_VAR: FAKE });

    const { text, rows } = await auditRows(o);
    expect(text).not.toContain(FAKE);
    const set = rows.find(
      (r) => r.operation === "userEnv.set" && r.targets.includes("NEW_VAR"),
    )!;
    expect(set.targets).toEqual([o.member.username, "NEW_VAR"]);
  });
});
