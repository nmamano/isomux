// Vault secrets that apps read (task c7007f8b), on the wire: who may give a
// secret to an app, the file the app's unit reads after each change, app
// delete and boot, and the app logs route, which never returns a vault
// value. The supervisor is the harness fake; the secrets file is real, under
// the test STATE_ROOT, and is read back with the container supervisor's
// parser.

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mintApiToken } from "../api-tokens.ts";
import { appSecretsDir, appSecretsPath } from "../app-secrets.ts";
import { STATE_ROOT } from "../config.ts";
import { mintAgentToken } from "../identity/tokens.ts";
import { getUserByName } from "../users.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const PARSER = fileURLToPath(
  new URL("../../deploy/container/supervisor.py", import.meta.url),
);
const VALUE = "fake-app-secret-value-0001";
const HOST_VALUE = "fake-host-secret-value-0001";

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
  return { status: response.status, body, text };
}

const errorOf = (res: Res) =>
  (res.body as { error?: Record<string, unknown> }).error ?? {};

// The app's secrets file as the app gets it, or null when there is none.
function appEnv(name: string): Record<string, string> | null {
  const path = appSecretsPath(appSecretsDir(STATE_ROOT), name);
  if (!existsSync(path)) return null;
  const result = spawnSync("python3", [PARSER, "parse-secrets-env", path], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

const secret = (over: Record<string, unknown> = {}) => ({
  name: "BOT_TOKEN",
  value: VALUE,
  hosts: [],
  form: { kind: "authorization" },
  apps: ["bot"],
  ...over,
});

async function office() {
  server = await startTestServer();
  const srv = server;
  const morgan = await srv.seedOwner("Morgan");
  const member = await srv.seedMember("Member");
  const other = await srv.seedMember("Other");
  const morganId = getUserByName(morgan.username)!.id;
  const memberId = getUserByName(member.username)!.id;
  const register = async (session: string, name: string) => {
    const res = await call(srv, "POST", "/api/apps", {
      session,
      body: { name, command: "true", cwd: srv.stateRoot },
    });
    expect([name, res.status]).toEqual([name, 201]);
  };
  // Member owns bot and helper; Other owns web.
  await register(member.rawSessionId, "bot");
  await register(member.rawSessionId, "helper");
  await register(other.rawSessionId, "web");
  srv.appSupervisor.calls.length = 0;
  return {
    srv,
    morgan,
    member,
    other,
    memberBase: `/api/users/${member.username}/secrets`,
    memberAgent: mintAgentToken("member-privileged", memberId, true),
    ownerAgent: mintAgentToken("morgan-privileged", morganId, true),
    memberApi: (
      await mintApiToken({
        userId: memberId,
        name: "Member API",
        expiresInDays: null,
      })
    ).token,
  };
}

type Office = Awaited<ReturnType<typeof office>>;

const restarts = (o: Office) =>
  o.srv.appSupervisor.calls.filter((c) => c.startsWith("restart:")).sort();

async function listed(o: Office, base: string, session: string) {
  const res = await call(o.srv, "GET", base, { session });
  expect(res.status).toBe(200);
  return Object.fromEntries(
    (res.body as { secrets: { name: string; apps: string[] }[] }).secrets.map(
      (s) => [s.name, s.apps],
    ),
  );
}

describe("a member gives a secret to their own app", () => {
  it("the file holds the value after create, rotate and delete, and the running app restarts each time", async () => {
    const o = await office();
    const session = o.member.rawSessionId;
    const created = await call(o.srv, "POST", o.memberBase, {
      session,
      body: secret(),
    });
    expect(created.status).toBe(201);
    expect(
      (created.body as { secret: { apps: string[] } }).secret.apps,
    ).toEqual(["bot"]);
    expect(created.text).not.toContain(VALUE);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
    expect(appEnv("helper")).toBeNull();
    expect(restarts(o)).toEqual(["restart:bot"]);

    o.srv.appSupervisor.calls.length = 0;
    const rotated = "fake-app-secret-rotated-0001";
    expect(
      (
        await call(o.srv, "PUT", `${o.memberBase}/BOT_TOKEN/value`, {
          session,
          body: { value: rotated },
        })
      ).status,
    ).toBe(200);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: rotated });
    expect(restarts(o)).toEqual(["restart:bot"]);

    o.srv.appSupervisor.calls.length = 0;
    expect(
      (await call(o.srv, "DELETE", `${o.memberBase}/BOT_TOKEN`, { session }))
        .status,
    ).toBe(204);
    expect(appEnv("bot")).toBeNull();
    expect(restarts(o)).toEqual(["restart:bot"]);
  });

  it("an API token of the member may add an app too", async () => {
    const o = await office();
    const res = await call(o.srv, "POST", o.memberBase, {
      bearer: o.memberApi,
      body: secret(),
    });
    expect(res.status).toBe(201);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
  });

  // The name rules for apps are the store's: secret-store-apps.test.ts.
  it("refuses another member's app, an unknown app, and no host and no app", async () => {
    const o = await office();
    const session = o.member.rawSessionId;
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [secret({ apps: ["web"] }), { field: "apps", reason: "invalid" }],
      [secret({ apps: ["nope"] }), { field: "apps", reason: "invalid" }],
      [secret({ apps: [] }), { field: "hosts", reason: "invalid" }],
    ];
    for (const [body, error] of cases) {
      const res = await call(o.srv, "POST", o.memberBase, { session, body });
      expect([body, res.status, errorOf(res)]).toEqual([
        body,
        400,
        expect.objectContaining({ code: "invalid_secret", ...error }),
      ]);
    }
    // The same checks on an update.
    expect(
      (
        await call(o.srv, "POST", o.memberBase, {
          session,
          body: secret({ hosts: ["api.example.com"], apps: [] }),
        })
      ).status,
    ).toBe(201);
    const patched = await call(o.srv, "PATCH", `${o.memberBase}/BOT_TOKEN`, {
      session,
      body: { apps: ["web"] },
    });
    expect([patched.status, errorOf(patched)]).toEqual([
      400,
      expect.objectContaining({
        code: "invalid_secret",
        field: "apps",
        reason: "invalid",
      }),
    ]);
    expect(await listed(o, o.memberBase, session)).toEqual({ BOT_TOKEN: [] });
    expect(appEnv("web")).toBeNull();
  });
});

describe("an office secret", () => {
  it("goes to any member's app, and refuses a name that app already reads from a member secret", async () => {
    const o = await office();
    const res = await call(o.srv, "POST", "/api/office/secrets", {
      session: o.morgan.rawSessionId,
      body: secret({ name: "OFFICE_KEY", apps: ["bot", "web"] }),
    });
    expect(res.status).toBe(201);
    expect(appEnv("web")).toEqual({ OFFICE_KEY: VALUE });
    expect(
      (
        await call(o.srv, "POST", o.memberBase, {
          session: o.member.rawSessionId,
          body: secret(),
        })
      ).status,
    ).toBe(201);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE, OFFICE_KEY: VALUE });
    const clash = await call(o.srv, "POST", "/api/office/secrets", {
      session: o.morgan.rawSessionId,
      body: secret(),
    });
    expect([clash.status, errorOf(clash)]).toEqual([
      400,
      expect.objectContaining({
        code: "invalid_secret",
        field: "apps",
        reason: "clash",
      }),
    ]);
  });
});

describe("an agent never gives a secret to an app", () => {
  it("is refused apps on create and an added app on update; it may keep or remove apps", async () => {
    const o = await office();
    const session = o.member.rawSessionId;
    for (const [bearer, base] of [
      [o.memberAgent, o.memberBase],
      [o.ownerAgent, "/api/office/secrets"],
    ] as const) {
      const res = await call(o.srv, "POST", base, {
        bearer,
        body: secret({ name: "AGENT_MADE" }),
      });
      expect([base, res.status, errorOf(res).code]).toEqual([
        base,
        403,
        "secret_app_add_refused",
      ]);
    }
    expect(await listed(o, o.memberBase, session)).toEqual({});
    expect(appEnv("bot")).toBeNull();

    expect(
      (
        await call(o.srv, "POST", o.memberBase, {
          session,
          body: secret({ hosts: ["api.example.com"], apps: ["bot"] }),
        })
      ).status,
    ).toBe(201);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
    const patch = (apps: string[]) =>
      call(o.srv, "PATCH", `${o.memberBase}/BOT_TOKEN`, {
        bearer: o.memberAgent,
        body: { apps },
      });
    const added = await patch(["bot", "helper"]);
    expect([added.status, errorOf(added).code]).toEqual([
      403,
      "secret_app_add_refused",
    ]);
    expect(appEnv("helper")).toBeNull();
    expect((await patch(["bot"])).status).toBe(200);
    expect((await patch([])).status).toBe(200);
    expect(appEnv("bot")).toBeNull();
    // Gone is gone: putting it back is an add.
    expect((await patch(["bot"])).status).toBe(403);
    expect(await listed(o, o.memberBase, session)).toEqual({ BOT_TOKEN: [] });
  });
});

describe("app delete", () => {
  it("removes the app's file and grants; a new app with the name gets nothing", async () => {
    const o = await office();
    const session = o.member.rawSessionId;
    expect(
      (await call(o.srv, "POST", o.memberBase, { session, body: secret() }))
        .status,
    ).toBe(201);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
    expect(
      (await call(o.srv, "DELETE", "/api/apps/bot", { session })).status,
    ).toBe(204);
    expect(appEnv("bot")).toBeNull();
    expect(await listed(o, o.memberBase, session)).toEqual({ BOT_TOKEN: [] });
    const again = await call(o.srv, "POST", "/api/apps", {
      session,
      body: { name: "bot", command: "true", cwd: o.srv.stateRoot },
    });
    expect(again.status).toBe(201);
    expect(appEnv("bot")).toBeNull();
    expect(await listed(o, o.memberBase, session)).toEqual({ BOT_TOKEN: [] });
  });
});

describe("member removal", () => {
  it("takes the member's secrets out of their apps' files; office secrets stay", async () => {
    const o = await office();
    const saved = [
      await call(o.srv, "POST", o.memberBase, {
        session: o.member.rawSessionId,
        body: secret(),
      }),
      await call(o.srv, "POST", "/api/office/secrets", {
        session: o.morgan.rawSessionId,
        body: secret({ name: "OFFICE_KEY" }),
      }),
    ];
    expect(saved.map((res) => res.status)).toEqual([201, 201]);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE, OFFICE_KEY: VALUE });
    o.srv.appSupervisor.calls.length = 0;
    const removed = await call(
      o.srv,
      "DELETE",
      `/api/users/${o.member.username}`,
      { session: o.morgan.rawSessionId },
    );
    expect(removed.status).toBeLessThan(300);
    expect(appEnv("bot")).toEqual({ OFFICE_KEY: VALUE });
    expect(restarts(o)).toEqual(["restart:bot"]);
  });
});

describe("boot", () => {
  it("writes a lost file again and regenerates a unit that does not read it", async () => {
    const o = await office();
    const created = await call(o.srv, "POST", o.memberBase, {
      session: o.member.rawSessionId,
      body: secret(),
    });
    expect(created.status).toBe(201);
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
    rmSync(appSecretsPath(appSecretsDir(STATE_ROOT), "bot"));
    o.srv.appSupervisor.unitsInjectingSecrets.delete("bot");
    o.srv.appSupervisor.calls.length = 0;
    server = await o.srv.restart();
    expect(appEnv("bot")).toEqual({ BOT_TOKEN: VALUE });
    expect(server.appSupervisor.calls).toContain("regenerate:bot");
    expect(server.appSupervisor.calls).not.toContain("regenerate:helper");
  });
});

describe("the app logs route", () => {
  it("returns no vault value, the app's own or any other", async () => {
    const o = await office();
    const session = o.member.rawSessionId;
    const saved = [
      await call(o.srv, "POST", o.memberBase, { session, body: secret() }),
      await call(o.srv, "POST", "/api/office/secrets", {
        session: o.morgan.rawSessionId,
        body: secret({
          name: "HOSTED",
          value: HOST_VALUE,
          hosts: ["api.example.com"],
          apps: [],
        }),
      }),
    ];
    expect(saved.map((res) => res.status)).toEqual([201, 201]);
    o.srv.appSupervisor.logLines = [
      "listening",
      `token=${VALUE}`,
      `{"key":"${HOST_VALUE}"}`,
    ];
    for (const auth of [{ session }, { bearer: o.memberAgent }]) {
      const res = await call(o.srv, "GET", "/api/apps/bot/logs", auth);
      expect(res.status).toBe(200);
      const lines = (res.body as { lines: string[] }).lines;
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe("listening");
      expect(res.text).not.toContain(VALUE);
      expect(res.text).not.toContain(HOST_VALUE);
    }
  });
});
