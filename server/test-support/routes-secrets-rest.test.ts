// Secrets routes (internal-docs/secrets-design.md, section 1): the lifecycle,
// the gates, the field rules, and the read paths that must never carry a
// value: every response, the audit rows, the idempotency replay, the socket
// traffic during a change, and the server's console output.

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { mintApiToken } from "../api-tokens.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { SECRET_MIN_VALUE_LENGTH } from "../../shared/secret-hosts.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const FAKE = "fake-secret-value-0000-routes";

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

async function call(
  srv: TestServer,
  method: string,
  path: string,
  init: {
    body?: unknown;
    session?: string;
    bearer?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
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

const errorOf = (res: Res) =>
  (res.body as { error?: Record<string, unknown> }).error ?? {};

function github(value = FAKE) {
  return {
    name: "GH_TOKEN",
    value,
    hosts: ["api.github.com", "github.com"],
    form: { kind: "authorization" },
  };
}

// Every console line the server writes while `run` runs.
async function consoleDuring(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(
          args
            .map((a) =>
              a instanceof Error ? `${a.message}\n${a.stack}` : String(a),
            )
            .join(" "),
        );
      }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.join("\n");
}

describe("member secrets", () => {
  it("saves, lists, rotates, edits and deletes without returning the value", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const base = `/api/users/${owner.username}/secrets`;
    const session = owner.rawSessionId;
    const responses: Res[] = [];
    const track = async (res: Promise<Res>) => {
      const r = await res;
      responses.push(r);
      return r;
    };

    const createdRes = await track(
      call(srv, "POST", base, { session, body: github() }),
    );
    expect(createdRes.status).toBe(201);
    const listed = await track(call(srv, "GET", base, { session }));
    expect(listed.status).toBe(200);
    const [secret] = (listed.body as { secrets: Record<string, unknown>[] })
      .secrets;
    expect(secret.name).toBe("GH_TOKEN");
    expect(secret.hosts).toEqual(["api.github.com", "github.com"]);
    expect(secret.form).toEqual({ kind: "authorization" });
    expect(typeof secret.valueSetAt).toBe("number");
    expect(Object.keys(secret)).not.toContain("value");

    const ownerId = getUserByName(owner.username)!.id;
    const file = join(srv.stateRoot, "secrets", "users", `${ownerId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(srv.stateRoot, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(srv.stateRoot, "secrets", "users")).mode & 0o777).toBe(
      0o700,
    );
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.secrets[0].generation).toBe(1);
    expect(stored.secrets[0].value).toBe(FAKE);

    const rotated = await track(
      call(srv, "PUT", `${base}/GH_TOKEN/value`, {
        session,
        body: { value: `${FAKE}-2` },
      }),
    );
    expect(rotated.status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).secrets[0].value).toBe(
      `${FAKE}-2`,
    );

    const edited = await track(
      call(srv, "PATCH", `${base}/GH_TOKEN`, {
        session,
        body: {
          hosts: ["uploads.github.com"],
          form: { kind: "header", header: "X-Api-Key" },
        },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as { secret: Record<string, unknown> }).secret).toEqual(
      expect.objectContaining({
        hosts: ["uploads.github.com"],
        form: { kind: "header", header: "x-api-key" },
      }),
    );

    const duplicate = await track(
      call(srv, "POST", base, { session, body: github() }),
    );
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).code).toBe("secret_exists");

    const removed = await track(
      call(srv, "DELETE", `${base}/GH_TOKEN`, { session }),
    );
    expect(removed.status).toBe(204);
    const after = await track(call(srv, "GET", base, { session }));
    expect(after.body).toEqual({ secrets: [] });
    expect(
      (await track(call(srv, "DELETE", `${base}/GH_TOKEN`, { session })))
        .status,
    ).toBe(404);

    for (const res of responses) expect(res.text).not.toContain(FAKE);
  });

  it("admits the owning cookie and API identity, never an ordinary agent or one outside its reach", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const other = await srv.seedMember("Other");
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
    const plainAgent = mintAgentToken("plain-secrets-agent", ownerId, false);
    // A privileged agent of another member: outside its manager's reach.
    // An owner's privileged agent: routes-integrations.test.ts.
    const privilegedAgent = mintAgentToken(
      "privileged-secrets-agent",
      otherId,
      true,
    );
    const base = `/api/users/${owner.username}/secrets`;

    expect(
      (
        await call(srv, "POST", base, {
          bearer: ownerApi.token,
          body: github(),
        })
      ).status,
    ).toBe(201);
    const statuses = {
      ownCookie: (await call(srv, "GET", base, { session: owner.rawSessionId }))
        .status,
      otherCookie: (
        await call(srv, "GET", base, { session: other.rawSessionId })
      ).status,
      otherApi: (await call(srv, "GET", base, { bearer: otherApi.token }))
        .status,
      plainAgent: (await call(srv, "GET", base, { bearer: plainAgent })).status,
      privilegedAgent: (
        await call(srv, "GET", base, { bearer: privilegedAgent })
      ).status,
      agentCreate: (
        await call(srv, "POST", base, {
          bearer: privilegedAgent,
          body: { ...github(), name: "OTHER" },
        })
      ).status,
      agentRotate: (
        await call(srv, "PUT", `${base}/GH_TOKEN/value`, {
          bearer: plainAgent,
          body: { value: "x" },
        })
      ).status,
      otherDelete: (
        await call(srv, "DELETE", `${base}/GH_TOKEN`, {
          session: other.rawSessionId,
        })
      ).status,
    };
    expect(statuses).toEqual({
      ownCookie: 200,
      otherCookie: 403,
      otherApi: 403,
      plainAgent: 403,
      privilegedAgent: 403,
      agentCreate: 403,
      agentRotate: 403,
      otherDelete: 403,
    });
  });
});

describe("office secrets", () => {
  // Members read the list as a summary (Nil, 2026-10-13); see
  // routes-integrations.test.ts. Every change stays owner-only.
  it("are owner-only to change, as the office variables are", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const member = await srv.seedMember("Member");
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
    // A member's privileged agent reads the summary, as the member does, and
    // changes nothing.
    const privileged = mintAgentToken("office-secrets-agent", memberId, true);
    const base = "/api/office/secrets";

    expect(
      (
        await call(srv, "POST", base, {
          session: owner.rawSessionId,
          body: github(),
        })
      ).status,
    ).toBe(201);
    expect(
      statSync(join(srv.stateRoot, "secrets", "office.json")).mode & 0o777,
    ).toBe(0o600);
    const ownerList = await call(srv, "GET", base, { bearer: ownerApi.token });
    expect(ownerList.status).toBe(200);
    expect(ownerList.text).not.toContain(FAKE);

    expect((await call(srv, "GET", base, { bearer: privileged })).status).toBe(
      200,
    );
    for (const who of [
      { session: member.rawSessionId },
      { bearer: memberApi.token },
      { bearer: privileged },
    ]) {
      expect(
        (await call(srv, "POST", base, { ...who, body: github("x") })).status,
      ).toBe(403);
      expect(
        (
          await call(srv, "PUT", `${base}/GH_TOKEN/value`, {
            ...who,
            body: { value: "x" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(srv, "PATCH", `${base}/GH_TOKEN`, {
            ...who,
            body: { hosts: ["example.com"] },
          })
        ).status,
      ).toBe(403);
      expect((await call(srv, "DELETE", `${base}/GH_TOKEN`, who)).status).toBe(
        403,
      );
    }
    const stored = JSON.parse(
      readFileSync(join(srv.stateRoot, "secrets", "office.json"), "utf8"),
    );
    expect(stored.secrets.map((s: { name: string }) => s.name)).toEqual([
      "GH_TOKEN",
    ]);
    expect(stored.secrets[0].hosts).toEqual(["api.github.com", "github.com"]);
  });
});

describe("secret field rules", () => {
  it("refuses never-listed hosts on create and edit, after the syntax check", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    for (const base of [
      `/api/users/${owner.username}/secrets`,
      "/api/office/secrets",
    ]) {
      expect(
        (await call(srv, "POST", base, { session, body: github() })).status,
      ).toBe(201);
      // One of each: the lists are shared/secret-hosts.test.ts.
      const syntax = ["*.openai.com"];
      const neverListed = ["api.openai.com"];
      for (const host of syntax) {
        const created = await call(srv, "POST", base, {
          session,
          body: { ...github(), name: "OTHER", hosts: [host] },
        });
        const patched = await call(srv, "PATCH", `${base}/GH_TOKEN`, {
          session,
          body: { hosts: ["api.github.com", host] },
        });
        for (const res of [created, patched]) {
          expect(res.status).toBe(400);
          expect(errorOf(res)).toEqual(
            expect.objectContaining({ code: "invalid_secret", field: "hosts" }),
          );
        }
      }
      for (const host of neverListed) {
        const created = await call(srv, "POST", base, {
          session,
          body: { ...github(), name: "OTHER", hosts: [host] },
        });
        const patched = await call(srv, "PATCH", `${base}/GH_TOKEN`, {
          session,
          body: { hosts: ["api.github.com", host] },
        });
        for (const res of [created, patched]) {
          expect(res.status).toBe(422);
          expect(errorOf(res)).toEqual(
            expect.objectContaining({
              code: "host_not_allowed",
              field: "hosts",
              host,
            }),
          );
        }
      }
      const list = await call(srv, "GET", base, { session });
      expect(
        (list.body as { secrets: { name: string; hosts: string[] }[] }).secrets,
      ).toEqual([
        expect.objectContaining({
          name: "GH_TOKEN",
          hosts: ["api.github.com", "github.com"],
        }),
      ]);
    }
  });

  it("refuses bad names, values and forms by field, and never echoes the input", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const base = `/api/users/${owner.username}/secrets`;
    const pasted = `ghp_${"A".repeat(36)}`;
    const cases: {
      body: Record<string, unknown>;
      field: string;
      reason?: string;
    }[] = [
      // The value pasted into the name field.
      { body: { ...github(), name: pasted }, field: "name" },
      { body: { ...github(), name: `${FAKE}-name` }, field: "name" },
      {
        body: { ...github(), name: "HTTPS_PROXY" },
        field: "name",
        reason: "reserved",
      },
      { body: { ...github(), value: `${FAKE}é` }, field: "value" },
      { body: { ...github(), value: `${FAKE}\n` }, field: "value" },
      { body: { ...github(), value: ` ${FAKE}` }, field: "value" },
      { body: { ...github(), value: "" }, field: "value" },
      {
        body: { ...github(), value: "x".repeat(16 * 1024 + 1) },
        field: "value",
        reason: "too_long",
      },
      // The value pasted into the hosts field.
      { body: { ...github(), hosts: [FAKE] }, field: "hosts" },
      { body: { ...github(), hosts: [] }, field: "hosts" },
      {
        body: { ...github(), form: { kind: "header", header: "Host" } },
        field: "form",
      },
      {
        body: {
          ...github(),
          form: { kind: "header", header: "Proxy-Authorization" },
        },
        field: "form",
      },
      {
        body: { ...github(), form: { kind: "header", header: FAKE + " x" } },
        field: "form",
      },
      { body: { ...github(), form: { kind: "cookie" } }, field: "form" },
    ];
    const output = await consoleDuring(async () => {
      for (const { body, field, reason } of cases) {
        const res = await call(srv, "POST", base, { session, body });
        expect(res.status).toBe(400);
        expect(errorOf(res)).toEqual(
          expect.objectContaining({
            code: "invalid_secret",
            field,
            ...(reason ? { reason } : {}),
          }),
        );
        expect(res.text).not.toContain(FAKE);
        expect(res.text).not.toContain(pasted);
      }
      const extra = await call(srv, "POST", base, {
        session,
        // An unknown key ("note" became a field in A4).
        body: { ...github(), comment: FAKE },
      });
      expect(extra.status).toBe(400);
      expect(extra.text).not.toContain(FAKE);
    });
    expect(output).not.toContain(FAKE);
    expect(output).not.toContain(pasted);
    expect((await call(srv, "GET", base, { session })).body).toEqual({
      secrets: [],
    });
  });

  // Task f51e4ab9: an agent with a secret gets its placeholder in the env,
  // and an engine signs in with a model key from the env over its stored
  // sign-in. The proxy never swaps a placeholder for a model host, so a
  // model key name may go only on a secret that apps alone read.
  it("refuses a model sign-in key name on a secret with a host, and keeps one stored before the rule removable", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const userBase = `/api/users/${owner.username}/secrets`;
    const modelKey = (res: Res) => {
      expect(res.status).toBe(400);
      expect(errorOf(res)).toEqual(
        expect.objectContaining({
          code: "invalid_secret",
          field: "name",
          reason: "model_key",
        }),
      );
    };
    const toExample = { hosts: ["api.example.com"] };
    for (const base of [userBase, "/api/office/secrets"]) {
      // One name: the list is MODEL_KEY_SECRET_NAMES in shared/secret-hosts.ts.
      modelKey(
        await call(srv, "POST", base, {
          session,
          body: { ...github(), ...toExample, name: "OPENAI_API_KEY" },
        }),
      );
      // Not a model sign-in key: a generic name, and a name that differs
      // only in case (the engines read the exact name).
      for (const name of ["GOOGLE_API_KEY", "openai_api_key"])
        expect(
          (
            await call(srv, "POST", base, {
              session,
              body: { ...github(), ...toExample, name },
            })
          ).status,
        ).toBe(201);
      expect(
        (
          (await call(srv, "GET", base, { session })).body as {
            secrets: { name: string }[];
          }
        ).secrets
          .map((s) => s.name)
          .sort(),
      ).toEqual(["GOOGLE_API_KEY", "openai_api_key"]);
    }

    // A secret that only an app reads gives the app the real value and
    // reaches no agent: allowed, and it cannot gain a host.
    const app = await call(srv, "POST", "/api/apps", {
      session,
      body: { name: "bot", command: "true", cwd: srv.stateRoot },
    });
    expect(app.status).toBe(201);
    const appOnly = await call(srv, "POST", userBase, {
      session,
      body: {
        ...github(),
        name: "ANTHROPIC_API_KEY",
        hosts: [],
        apps: ["bot"],
      },
    });
    expect(appOnly.status).toBe(201);
    modelKey(
      await call(srv, "PATCH", `${userBase}/ANTHROPIC_API_KEY`, {
        session,
        body: toExample,
      }),
    );

    // A secret with a host stored before the rule: it still loads, an edit
    // that keeps a host is refused whatever it changes, and the member can
    // rotate, reissue and delete it.
    const ownerId = getUserByName(owner.username)!.id;
    const file = join(srv.stateRoot, "secrets", "users", `${ownerId}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const old = stored.secrets.find(
      (s: { name: string }) => s.name === "GOOGLE_API_KEY",
    );
    old.name = "OPENAI_API_KEY";
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    const listed = await call(srv, "GET", userBase, { session });
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { secrets: { name: string; hosts: string[] }[] }).secrets,
    ).toContainEqual(
      expect.objectContaining({
        name: "OPENAI_API_KEY",
        hosts: ["api.example.com"],
      }),
    );
    modelKey(
      await call(srv, "PATCH", `${userBase}/OPENAI_API_KEY`, {
        session,
        body: { note: "moving it to Variables" },
      }),
    );
    expect(
      (
        await call(srv, "PUT", `${userBase}/OPENAI_API_KEY/value`, {
          session,
          body: { value: `${FAKE}-2` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(srv, "POST", `${userBase}/OPENAI_API_KEY/reissue`, {
          session,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(srv, "DELETE", `${userBase}/OPENAI_API_KEY`, { session }))
        .status,
    ).toBe(204);
  });

  it("keeps both of two concurrent creates in one scope", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const base = `/api/users/${owner.username}/secrets`;
    const names = Array.from({ length: 12 }, (_, i) => `TOKEN_${i}`);
    const results = await Promise.all(
      names.map((name) =>
        call(srv, "POST", base, { session, body: { ...github(), name } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(names.map(() => 201));
    const list = await call(srv, "GET", base, { session });
    expect(
      (list.body as { secrets: { name: string }[] }).secrets
        .map((s) => s.name)
        .sort(),
    ).toEqual([...names].sort());
  });

  it("answers 500 for an unreadable store and never rewrites or prints it", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const dir = join(srv.stateRoot, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "office.json");
    for (const content of [
      `{"version":1,"secrets":[{"name":"GH_TOKEN","value":"${FAKE}"`,
      JSON.stringify({ version: 2, secrets: [{ value: FAKE }] }),
    ]) {
      writeFileSync(file, content, { mode: 0o600 });
      const output = await consoleDuring(async () => {
        for (const res of [
          await call(srv, "GET", "/api/office/secrets", { session }),
          await call(srv, "POST", "/api/office/secrets", {
            session,
            body: github("another-value"),
          }),
          await call(srv, "DELETE", "/api/office/secrets/GH_TOKEN", {
            session,
          }),
        ]) {
          expect(res.status).toBe(500);
          expect(errorOf(res).code).toBe("secrets_unreadable");
          expect(res.text).not.toContain(FAKE);
        }
      });
      expect(output).not.toContain(FAKE);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("refuses a new value under the minimum length, and keeps a short value saved before the rule", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const base = `/api/users/${owner.username}/secrets`;
    const short = "x".repeat(SECRET_MIN_VALUE_LENGTH - 1);
    const shortest = "y".repeat(SECRET_MIN_VALUE_LENGTH);

    const refused = await call(srv, "POST", base, {
      session,
      body: github(short),
    });
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toEqual(
      expect.objectContaining({
        code: "invalid_secret",
        field: "value",
        reason: "too_short",
      }),
    );
    expect(refused.text).not.toContain(short);
    expect((await call(srv, "GET", base, { session })).body).toEqual({
      secrets: [],
    });
    const created = await call(srv, "POST", base, {
      session,
      body: github(shortest),
    });
    expect(created.status).toBe(201);
    const rotate = await call(srv, "PUT", `${base}/GH_TOKEN/value`, {
      session,
      body: { value: short },
    });
    expect(rotate.status).toBe(400);
    expect(errorOf(rotate).reason).toBe("too_short");

    // A value saved before the rule: the store reads it, and the edits that
    // carry no value go through.
    const ownerId = getUserByName(owner.username)!.id;
    const file = join(srv.stateRoot, "secrets", "users", `${ownerId}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.secrets[0].value = short;
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    const listed = await call(srv, "GET", base, { session });
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { secrets: { name: string }[] }).secrets.map(
        (s) => s.name,
      ),
    ).toEqual(["GH_TOKEN"]);
    for (const res of [
      await call(srv, "PATCH", `${base}/GH_TOKEN`, {
        session,
        body: { hosts: ["api.github.com"] },
      }),
      await call(srv, "POST", `${base}/GH_TOKEN/reissue`, { session }),
    ])
      expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).secrets[0].value).toBe(short);
  });
});

describe("secret read paths", () => {
  it("keeps the value out of the audit log, the idempotency replay and the socket", async () => {
    server = await startTestServer();
    const srv = server;
    const owner = await srv.seedOwner("Morgan");
    const session = owner.rawSessionId;
    const sock = await srv.connectWs(session);
    await sock.waitFor("session_context");
    const base = `/api/users/${owner.username}/secrets`;

    const first = await call(srv, "POST", base, {
      session,
      body: github(),
      idempotencyKey: "secrets-replay-1",
    });
    const replay = await call(srv, "POST", base, {
      session,
      body: github(),
      idempotencyKey: "secrets-replay-1",
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.text).not.toContain(FAKE);
    await call(srv, "PUT", `${base}/GH_TOKEN/value`, {
      session,
      body: { value: `${FAKE}-2` },
    });
    await call(srv, "PATCH", `${base}/GH_TOKEN`, {
      session,
      body: { hosts: ["api.github.com"] },
    });
    await call(srv, "DELETE", `${base}/GH_TOKEN`, { session });
    await call(srv, "POST", "/api/office/secrets", {
      session,
      body: github(),
    });

    const audit = await call(srv, "GET", "/api/audit-log", { session });
    expect(audit.status).toBe(200);
    expect(audit.text).not.toContain(FAKE);
    const rows = (
      audit.body as {
        items: { operation: string; targets: string[]; fields: string[] }[];
      }
    ).items;
    const operations = rows.map((row) => row.operation);
    for (const op of [
      "secrets.create",
      "secrets.rotate",
      "secrets.update",
      "secrets.delete",
      "officeSecrets.create",
    ])
      expect(operations).toContain(op);
    const create = rows.find((row) => row.operation === "secrets.create")!;
    expect(create.targets).toContain("GH_TOKEN");
    expect(create.fields).toContain("value");
    // One row for the create, not two: the replay adds none.
    expect(operations.filter((op) => op === "secrets.create")).toHaveLength(1);

    sock.send({ type: "ping" });
    await sock.waitFor("pong");
    expect(JSON.stringify(sock.messages)).not.toContain(FAKE);
    sock.close();
  });
});
