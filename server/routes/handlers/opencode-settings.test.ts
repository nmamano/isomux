// Task d4a7031e: a saved env variable, secret or MCP server goes to the
// OpenCode servers its scope reaches, after the store write. The answers are
// as before, and a push that fails never fails the save.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { userEnvHandlers, type UserEnvDeps } from "./user-env.ts";
import { secretsHandlers } from "./secrets.ts";
import { mcpServersHandlers, type McpServersDeps } from "./mcp-servers.ts";
import type { PushOpenCodeSettings } from "./opencode-settings.ts";
import { createSecretStore, type SecretScope } from "../../secret-store.ts";
import type { HandlerResult, RouteHandlerContext } from "../executor.ts";
import type { Identity } from "../../identity/index.ts";
import { USER_CAPABILITIES } from "../../identity/index.ts";

// The caller is u1 ("boss"); "member" is u2.
const identity: Identity = {
  scope: "user",
  userId: "u1",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};
const userIdForUsername = (username: string) =>
  username === "boss" ? "u1" : username === "member" ? "u2" : null;

function ctx(
  params: Record<string, string>,
  body?: unknown,
): RouteHandlerContext {
  return {
    identity,
    params,
    body,
    rawBody: "",
    query: new URLSearchParams(),
    req: new Request("http://localhost/"),
  };
}

// A push that records what it saw: the scope and the state of the store
// when it ran.
function recorder(answer: "ok" | "throw", seen: () => unknown) {
  const calls: { scope: SecretScope; store: unknown }[] = [];
  const push: PushOpenCodeSettings = (scope) => {
    calls.push({ scope, store: seen() });
    if (answer === "throw") throw new Error("push failed");
  };
  return { calls, push };
}

const json = (result: HandlerResult) => {
  if (result.kind !== "json") throw new Error(`a ${result.kind} answer`);
  return { status: result.status ?? 200, body: result.body };
};
const kindOf = (result: HandlerResult) => result.kind;

function envSetup(push?: PushOpenCodeSettings) {
  const member: Record<string, Record<string, string>> = {};
  let office: Record<string, string> = {};
  const deps: UserEnvDeps = {
    get: () => ({ mode: "managed", values: {}, notes: {} }),
    names: async () => null,
    replace: (userId, values) => {
      member[userId] = { ...values };
      return { ok: true };
    },
    setOne: (userId, name, value) => {
      member[userId] = { ...member[userId], [name]: value };
      return { ok: true };
    },
    removeOne: (userId, name) => {
      if (!member[userId] || !(name in member[userId])) return false;
      delete member[userId][name];
      return { ok: true };
    },
    userIdForUsername,
    getOffice: () => ({ mode: "managed", values: office, notes: {} }),
    replaceOffice: (values) => {
      office = { ...values };
      return { ok: true };
    },
    setOfficeOne: (name, value) => {
      office = { ...office, [name]: value };
      return { ok: true };
    },
    removeOfficeOne: (name) => {
      if (!(name in office)) return false;
      delete office[name];
      return { ok: true };
    },
    ...(push ? { pushOpenCodeSettings: push } : {}),
  };
  return {
    handlers: userEnvHandlers(deps),
    stored: () => ({ member: structuredClone(member), office: { ...office } }),
  };
}

describe("env variable saves", () => {
  it("push after the write, with the subject's or the office scope, and answer 204 as before", async () => {
    let stored: () => unknown = () => null;
    const { calls, push } = recorder("ok", () => stored());
    const env = envSetup(push);
    stored = env.stored;
    const answers = [
      await env.handlers["userEnv.set"](
        ctx({ username: "member", name: "TZ" }, { value: "UTC" }),
      ),
      await env.handlers["userEnv.remove"](
        ctx({ username: "member", name: "TZ" }),
      ),
      await env.handlers["userEnv.replace"](
        ctx({ username: "boss" }, { values: { A: "1" } }),
      ),
      await env.handlers["officeEnv.set"](ctx({ name: "O" }, { value: "1" })),
      await env.handlers["officeEnv.replace"](ctx({}, { values: { O: "2" } })),
      await env.handlers["officeEnv.remove"](ctx({ name: "O" })),
    ];
    expect(answers.map(kindOf)).toEqual(Array(6).fill("noContent"));
    expect(calls).toEqual([
      {
        scope: { kind: "user", userId: "u2" },
        store: { member: { u2: { TZ: "UTC" } }, office: {} },
      },
      {
        scope: { kind: "user", userId: "u2" },
        store: { member: { u2: {} }, office: {} },
      },
      {
        scope: { kind: "user", userId: "u1" },
        store: { member: { u2: {}, u1: { A: "1" } }, office: {} },
      },
      {
        scope: { kind: "office" },
        store: { member: { u2: {}, u1: { A: "1" } }, office: { O: "1" } },
      },
      {
        scope: { kind: "office" },
        store: { member: { u2: {}, u1: { A: "1" } }, office: { O: "2" } },
      },
      {
        scope: { kind: "office" },
        store: { member: { u2: {}, u1: { A: "1" } }, office: {} },
      },
    ]);
  });

  it("push nothing on a refused write", async () => {
    const { calls, push } = recorder("ok", () => null);
    const env = envSetup(push);
    const missing = await env.handlers["userEnv.remove"](
      ctx({ username: "member", name: "NOPE" }),
    );
    expect(missing).toMatchObject({ kind: "error", status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("keep a save whose push throws", async () => {
    const { calls, push } = recorder("throw", () => null);
    const env = envSetup(push);
    expect(
      kindOf(
        await env.handlers["officeEnv.set"](ctx({ name: "O" }, { value: "1" })),
      ),
    ).toBe("noContent");
    expect(calls).toHaveLength(1);
    expect(env.stored().office).toEqual({ O: "1" });
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const SECRET = {
  name: "GH_TOKEN",
  value: "ghp_FAKEpushFAKEpushFAKEpushFAKEpush01",
  hosts: ["api.github.com"],
  form: { kind: "authorization" },
};

describe("secret saves", () => {
  it("push after the store write and the runtime, on a save and a delete, with the answers as before", async () => {
    const root = mkdtempSync(join(tmpdir(), "isomux-opencode-push-"));
    roots.push(root);
    const store = createSecretStore(root);
    const order: string[] = [];
    const { calls, push } = recorder("ok", () =>
      store.list({ kind: "user", userId: "u1" }).map((s) => s.name),
    );
    const handlers = secretsHandlers({
      store,
      userIdForUsername,
      isOfficeOwnerUserId: () => true,
      auditReveal: () => {},
      onChanged: async () => {
        order.push("runtime");
      },
      pushOpenCodeSettings: (scope) => {
        order.push("push");
        push(scope);
      },
    });
    const saved = json(
      await handlers["secrets.create"](ctx({ username: "boss" }, SECRET)),
    );
    expect(saved.status).toBe(201);
    expect(Object.keys(saved.body as object)).toEqual(["secret"]);
    expect(
      kindOf(
        await handlers["secrets.delete"](
          ctx({ username: "boss", name: "GH_TOKEN" }),
        ),
      ),
    ).toBe("noContent");
    expect(order).toEqual(["runtime", "push", "runtime", "push"]);
    expect(calls).toEqual([
      { scope: { kind: "user", userId: "u1" }, store: ["GH_TOKEN"] },
      { scope: { kind: "user", userId: "u1" }, store: [] },
    ]);
    // A refused change pushes nothing.
    await handlers["secrets.delete"](
      ctx({ username: "boss", name: "GH_TOKEN" }),
    );
    expect(calls).toHaveLength(2);
  });
});

describe("MCP server saves", () => {
  it("push after the write on a save, an edit and a delete, with the answers as before", async () => {
    const written: string[] = [];
    const server = (name: string) => ({
      name,
      url: "https://mcp.example.com/mcp",
      secret: null,
      createdAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:00.000Z",
      note: null,
      oauth: null,
    });
    const oauth = {
      create: (_scope: SecretScope, body: { name: string }) => {
        written.push(`create ${body.name}`);
        return { ok: true, change: { ok: true, server: server(body.name) } };
      },
      update: (_scope: SecretScope, name: string) => {
        written.push(`update ${name}`);
        return { ok: true, change: { ok: true, server: server(name) } };
      },
      remove: (_scope: SecretScope, name: string) => {
        written.push(`remove ${name}`);
        return true;
      },
    };
    const { calls, push } = recorder("ok", () => [...written]);
    const handlers = mcpServersHandlers({
      store: {} as McpServersDeps["store"],
      oauth: oauth as unknown as McpServersDeps["oauth"],
      auditSignIn: () => {},
      isOfficeOwnerUserId: () => true,
      userIdForUsername,
      usernameForUserId: () => null,
      pushOpenCodeSettings: push,
    });
    const body = {
      name: "docs",
      url: "https://mcp.example.com/mcp",
      secret: null,
    };
    const created = json(
      await handlers["officeMcpServers.create"](ctx({}, body)),
    );
    expect(created.status).toBe(201);
    expect(Object.keys(created.body as object)).toEqual(["server"]);
    expect(
      json(
        await handlers["mcpServers.update"](
          ctx({ username: "member", name: "docs" }, { note: "n" }),
        ),
      ).status,
    ).toBe(200);
    expect(
      kindOf(
        await handlers["mcpServers.delete"](
          ctx({ username: "member", name: "docs" }),
        ),
      ),
    ).toBe("noContent");
    expect(calls).toEqual([
      { scope: { kind: "office" }, store: ["create docs"] },
      {
        scope: { kind: "user", userId: "u2" },
        store: ["create docs", "update docs"],
      },
      {
        scope: { kind: "user", userId: "u2" },
        store: ["create docs", "update docs", "remove docs"],
      },
    ]);
  });
});
