// The secret request core (secrets loop, B4): what the agent may ask, who may
// answer, that an open request is an ask that survives a restart, what the
// outcome line says, and that no answer, ask, event or line carries the value.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SECRET_MIN_VALUE_LENGTH } from "../shared/secret-hosts.ts";
import type { AskEntry } from "../shared/types.ts";
import {
  askVisibleTo,
  createAskFilePersistence,
  createAskStore,
  type AskChange,
  type AskPersistence,
} from "./asks.ts";
import {
  createSecretRequests,
  SECRET_REQUESTS_OPEN_MAX,
} from "./secret-requests.ts";
import type { SecretScope } from "./secret-store.ts";
import { msg, type LogMessage } from "../shared/i18n/log-message.ts";
import { createConnectionWrites } from "./connection-writes.ts";
import { createMcpOAuth } from "./mcp-oauth.ts";
import { createMcpServerSources } from "./mcp-servers.ts";
import { serializeManagedUserEnv } from "./user-env.ts";

const VALUE = "ghp_FAKErequestFAKErequestFAKErequest012";
const ASK = {
  name: "GH_TOKEN",
  hosts: ["api.github.com"],
  reason: "To open the pull request.",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// The asks file, with a switch that makes every write fail.
function asksFile(path: string) {
  const file = createAskFilePersistence(path);
  const control = { failWrites: false };
  const persistence: AskPersistence = {
    ...file,
    save(entries) {
      if (control.failWrites) throw new Error("disk full");
      file.save(entries);
    },
  };
  return { persistence, control };
}

// Members by username, office owners, apps by name, and who cannot reach
// the agents' room. Tests change apps and owners in place.
const MEMBERS: Record<string, string> = {
  Nil: "u-owner",
  Dana: "u-owner2",
  Alice: "u-alice",
  Bob: "u-bob",
  Carol: "u-carol",
  Eve: "u-eve",
};
// A member removed after the agent asked: the id resolves to no name.
const GONE = "u-gone";
type App = { createdAt: number; userId: string | null };
type Settled = {
  agentId: string;
  requestId: string;
  outcome: "saved" | "declined";
  line: LogMessage;
  answeredBy: string;
};

function setup(
  agents: Record<string, string | null> = { a1: "u-alice" },
  apps: Record<string, App> = {},
) {
  const owners = new Set(["u-owner", "u-owner2"]);
  const audience = {
    isOfficeOwner: (userId: string) => owners.has(userId),
    agentRoomId: (agentId: string) =>
      Object.hasOwn(agents, agentId) ? "r1" : null,
    canSeeRoom: (userId: string) => userId !== "u-eve",
  };
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-requests-"));
  roots.push(root);
  // The MCP servers and the secrets they name share one store, as in the
  // office.
  const sources = createMcpServerSources(root);
  const store = sources.secrets;
  const asksPath = join(root, "asks.json");
  // The managed variables, written through the real name and value check.
  const env: {
    office: Record<string, string>;
    users: Record<string, Record<string, string>>;
  } = { office: {}, users: {} };
  // Each OpenCode push: its scope, and the variable and server names that
  // scope held when it ran.
  const pushes: {
    scope: SecretScope;
    variables: string[];
    servers: string[];
  }[] = [];
  const variablesOf = (scope: SecretScope) =>
    scope.kind === "office" ? env.office : (env.users[scope.userId] ?? {});
  const oauth = createMcpOAuth({
    servers: sources.servers,
    secrets: sources.secrets,
    fetch: () => {
      throw new Error("no network in this test");
    },
    redirectUri: () => "https://office.example.com/api/mcp-oauth/callback",
  });
  const writes = createConnectionWrites({
    setUserVariable: (userId, name, value) => {
      const next = { ...env.users[userId], [name]: value };
      serializeManagedUserEnv(next);
      env.users[userId] = next;
      return { ok: true };
    },
    setOfficeVariable: (name, value) => {
      const next = { ...env.office, [name]: value };
      serializeManagedUserEnv(next);
      env.office = next;
      return { ok: true };
    },
    oauth: () => oauth,
    pushOpenCodeSettings: (scope) =>
      pushes.push({
        scope,
        variables: Object.keys(variablesOf(scope)),
        servers: sources.servers.list(scope).map((s) => s.name),
      }),
  });
  const events: AskChange[] = [];
  const settled: Settled[] = [];
  let changes = 0;
  // While set, the proxy push waits on it (holdChanges).
  let gate: Promise<void> | null = null;
  // A store and the requests over it, as one server boot builds them.
  function boot() {
    const { persistence, control } = asksFile(asksPath);
    const asks = createAskStore({
      persistence,
      onChange: (change) => events.push(change),
    });
    const requests = createSecretRequests({
      store,
      asks,
      audience,
      onChanged: async () => {
        changes++;
        if (gate) await gate;
      },
      agentUserId: (agentId) =>
        Object.hasOwn(agents, agentId) ? agents[agentId] : undefined,
      appFor: (name) =>
        Object.hasOwn(apps, name) ? { name, ...apps[name] } : null,
      memberByName: (name) => {
        const found = Object.keys(MEMBERS).find(
          (m) => m.toLowerCase() === name.toLowerCase(),
        );
        return found ? { id: MEMBERS[found], name: found } : null;
      },
      memberName: (userId) =>
        Object.keys(MEMBERS).find((m) => MEMBERS[m] === userId) ?? null,
      writes,
      variableExists: (scope, name) => Object.hasOwn(variablesOf(scope), name),
      mcpServerExists: (scope, name) =>
        sources.servers.list(scope).some((s) => s.name === name),
      settled: (agentId, requestId, outcome, line, answeredBy) =>
        settled.push({ agentId, requestId, outcome, line, answeredBy }),
    });
    return { asks, requests, control };
  }
  const first = boot();
  return {
    ...first,
    store,
    servers: sources.servers,
    env,
    pushes,
    asksPath,
    owners,
    audience,
    events,
    settled,
    boot,
    changes: () => changes,
    // Hold the next proxy push until the returned function runs.
    holdChanges: () => {
      let release = () => {};
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

function opened(
  result: ReturnType<ReturnType<typeof setup>["requests"]["open"]>,
) {
  if (!result.ok) throw new Error(`open refused: ${result.code}`);
  return result.requestId;
}

const code = (result: { ok: boolean; code?: string }) =>
  result.ok ? "ok" : result.code;
const failure = (result: { ok: boolean; status?: number; code?: string }) =>
  result.ok ? "ok" : `${result.status} ${result.code}`;
// Each outcome without its line: [agent, request, outcome, answered by].
const outcomes = (t: { settled: Settled[] }) =>
  t.settled.map((s) => [s.agentId, s.requestId, s.outcome, s.answeredBy]);

// Everything that leaves the request besides the secret store: the asks
// file, the ask events, and console output during the call.
async function captureConsole<T>(
  run: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const lines: unknown[][] = [];
  const saved = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  for (const key of ["log", "error", "warn", "info"] as const)
    console[key] = (...args: unknown[]) => lines.push(args);
  try {
    const result = await run();
    return { result, output: JSON.stringify(lines) };
  } finally {
    Object.assign(console, saved);
  }
}

describe("the agent's ask", () => {
  it("opens an ask for the manager with the proposed name, hosts, form and reason", () => {
    const { requests, asks } = setup();
    const requestId = opened(requests.open("a1", ASK));
    const [entry] = asks.listAll();
    expect(entry).toMatchObject({
      agentId: "a1",
      memberUserId: "u-alice",
      prompt: "To open the pull request.",
      secret: {
        requestId,
        scope: "personal",
        name: "GH_TOKEN",
        hosts: ["api.github.com"],
        form: { kind: "authorization" },
        reason: "To open the pull request.",
      },
    });
    expect(asks.listAll()).toHaveLength(1);
  });

  it("opens an office request for no one member, so every owner sees it", () => {
    const { requests, asks } = setup({ lone: null });
    opened(requests.open("lone", { ...ASK, scope: "office" }));
    const [entry] = asks.listAll();
    expect(entry.secret?.scope).toBe("office");
    expect("memberUserId" in entry).toBe(false);
  });

  it("refuses a second open request for the same secret, and allows it once the first settles", () => {
    const { requests } = setup();
    const first = opened(requests.open("a1", ASK));
    expect(code(requests.open("a1", ASK))).toBe("request_open");
    // Another name, or the office scope, is another secret.
    opened(requests.open("a1", { ...ASK, name: "OTHER_TOKEN" }));
    opened(requests.open("a1", { ...ASK, scope: "office" }));
    requests.decline("u-alice", "a1", first);
    opened(requests.open("a1", ASK));
  });

  it("refuses what the store would refuse, before the member sees a form", () => {
    const { requests, asks, store } = setup({ a1: "u-alice", lone: null });
    const codeOf = (agentId: string, body: unknown) =>
      code(requests.open(agentId, body));
    expect(codeOf("a1", { ...ASK, hosts: ["api.anthropic.com"] })).toBe(
      "host_not_allowed",
    );
    expect(codeOf("a1", { ...ASK, name: "not a name" })).toBe("invalid_secret");
    expect(codeOf("a1", { ...ASK, name: "AKIAIOSFODNN7EXAMPLE" })).toBe(
      "invalid_secret",
    );
    // A requested secret always has a host, so a model sign-in key name is
    // refused (task f51e4ab9).
    const modelKey = requests.open("a1", { ...ASK, name: "OPENAI_API_KEY" });
    expect(modelKey).toEqual(
      expect.objectContaining({
        ok: false,
        code: "invalid_secret",
        detail: { field: "name", reason: "model_key" },
      }),
    );
    expect(codeOf("a1", { ...ASK, reason: "" })).toBe("invalid_request");
    expect(codeOf("a1", { ...ASK, reason: `use ${VALUE}` })).toBe(
      "invalid_request",
    );
    expect(codeOf("a1", { ...ASK, value: VALUE })).toBe("invalid_request");
    expect(codeOf("a1", { ...ASK, scope: "team" })).toBe("invalid_request");
    expect(codeOf("nobody", ASK)).toBe("not_found");
    // An agent with no manager has no personal scope.
    expect(codeOf("lone", ASK)).toBe("no_member");
    expect(codeOf("lone", { ...ASK, scope: "office" })).toBe("ok");
    store.create(
      { kind: "user", userId: "u-alice" },
      { ...ASK, value: VALUE, form: { kind: "authorization" } },
    );
    expect(codeOf("a1", ASK)).toBe("secret_exists");
    expect(asks.listAll()).toHaveLength(1);
  });

  it("answers a full list with too_many_requests, whether its secret requests or all its asks", () => {
    const t = setup({ a1: "u-alice", a2: "u-alice" });
    for (let i = 0; i < SECRET_REQUESTS_OPEN_MAX; i++)
      opened(t.requests.open("a1", { ...ASK, name: `TOKEN_${i}` }));
    expect(code(t.requests.open("a1", { ...ASK, name: "ONE_MORE" }))).toBe(
      "too_many_requests",
    );
    // The ask store's own bound counts the agent's plain asks too.
    for (let i = 0; i < 50; i++)
      t.asks.create({ agentId: "a2", memberUserId: "u-alice", prompt: "Go?" });
    expect(code(t.requests.open("a2", ASK))).toBe("too_many_requests");
  });

  it("answers request_failed when the asks store is unavailable", async () => {
    const { store } = setup();
    const broken = createSecretRequests({
      store,
      // The file could not be read: the store refuses every call.
      asks: createAskStore({
        persistence: {
          load: () => ({ kind: "unreadable" }),
          save: () => {},
          quarantine: () => false,
        },
      }),
      audience: {
        isOfficeOwner: () => false,
        agentRoomId: () => "r1",
        canSeeRoom: () => true,
      },
      agentUserId: () => "u-alice",
      appFor: () => null,
      memberByName: () => null,
      memberName: () => null,
      // The variable and MCP server writes (task c71cb60f): unused here.
      writes: {
        setVariable: () => {
          throw new Error("unused");
        },
        createMcpServer: () => {
          throw new Error("unused");
        },
      },
      variableExists: () => false,
      mcpServerExists: () => false,
      settled: () => {},
    });
    expect(code(broken.open("a1", ASK))).toBe("request_failed");
    expect(
      code(await broken.save("u-alice", "a1", "x", { value: VALUE })),
    ).toBe("request_failed");
    expect(code(broken.decline("u-alice", "a1", "x"))).toBe("request_failed");
  });
});

// Where the value must not be: the asks file, every ask event, the store's
// entries, and whatever else the caller collected.
function expectNoValue(t: ReturnType<typeof setup>, ...more: unknown[]) {
  let file = "";
  try {
    file = readFileSync(t.asksPath, "utf-8");
  } catch {
    // No file yet.
  }
  expect(file).not.toContain(VALUE);
  expect(JSON.stringify(t.events)).not.toContain(VALUE);
  expect(JSON.stringify(t.asks.listAll())).not.toContain(VALUE);
  expect(JSON.stringify(more)).not.toContain(VALUE);
}

describe("the member's answer", () => {
  it("the manager saves with edited hosts; the outcome never carries the value", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, {
        value: VALUE,
        hosts: ["api.github.com", "uploads.github.com"],
      }),
    );
    expect(result).toEqual({ ok: true, name: "GH_TOKEN" });
    const scope = { kind: "user", userId: "u-alice" } as const;
    expect(t.store.readSecretValues(scope, "GH_TOKEN")).toEqual({
      value: VALUE,
      hosts: ["api.github.com", "uploads.github.com"],
      form: { kind: "authorization" },
    });
    expect(t.changes()).toBe(1);
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
    // The save closed the ask: an upsert and then a removal.
    expect(t.asks.listAll()).toEqual([]);
    expect(t.events.map((e) => e.kind)).toEqual(["upserted", "removed"]);
    // The value is in the secret store and nowhere else.
    expectNoValue(t, result, output, t.settled);
    // Settled: a second answer finds nothing.
    const again = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(code(again)).toBe("not_found");
  });

  it("only the manager answers a personal request, and only an owner an office one", async () => {
    const t = setup();
    const personal = opened(t.requests.open("a1", ASK));
    const office = opened(
      t.requests.open("a1", { ...ASK, name: "OFFICE_TOKEN", scope: "office" }),
    );
    const codeOf = async (userId: string | null, requestId: string) =>
      code(await t.requests.save(userId, "a1", requestId, { value: VALUE }));
    expect(await codeOf("u-bob", personal)).toBe("forbidden");
    expect(await codeOf(null, personal)).toBe("forbidden");
    expect(await codeOf("u-owner", personal)).toBe("forbidden");
    expect(await codeOf("u-alice", office)).toBe("forbidden");
    expect(t.requests.decline("u-bob", "a1", personal).ok).toBe(false);
    // Another agent's path does not reach the request.
    const wrongAgent = await t.requests.save("u-alice", "a2", personal, {
      value: VALUE,
    });
    expect(code(wrongAgent)).toBe("not_found");
    expect(await codeOf("u-owner", office)).toBe("ok");
    expect(t.store.list({ kind: "office" }).map((s) => s.name)).toEqual([
      "OFFICE_TOKEN",
    ]);
    expect(t.store.list({ kind: "user", userId: "u-bob" })).toEqual([]);
  });

  it("a refused value keeps the request open, and says nothing of the value", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const { result: bad, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, { value: ` ${VALUE}` }),
    );
    expect(code(bad)).toBe("invalid_secret");
    const { result: neverListed, output: output2 } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, {
        value: VALUE,
        hosts: ["api.openai.com"],
      }),
    );
    expect(code(neverListed)).toBe("host_not_allowed");
    expectNoValue(t, bad, neverListed, output, output2);
    const short = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE.slice(0, SECRET_MIN_VALUE_LENGTH - 1),
    });
    expect(short.ok ? null : short.detail).toEqual({
      field: "value",
      reason: "too_short",
    });
    expect(t.settled).toEqual([]);
    expect(t.asks.listAll()).toHaveLength(1);
    expect(
      (await t.requests.save("u-alice", "a1", requestId, { value: VALUE })).ok,
    ).toBe(true);
  });

  it("the manager declines; the outcome is settled, the ask closes and nothing is stored", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    expect(t.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "GH_TOKEN",
    });
    expect(outcomes(t)).toEqual([["a1", requestId, "declined", "u-alice"]]);
    expect(t.asks.listAll()).toEqual([]);
    expect(t.store.list({ kind: "user", userId: "u-alice" })).toEqual([]);
    expect(t.changes()).toBe(0);
    const late = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(code(late)).toBe("not_found");
  });

  it("a save closes the request before it waits on the proxy: nothing else answers it meanwhile", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const [entry] = t.asks.listAll();
    const release = t.holdChanges();
    const saving = t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    // The save waits on the proxy push now; the agent hears nothing until it
    // lands, so its confirmation reaches the process that has the secret.
    expect(t.changes()).toBe(1);
    expect(t.settled).toEqual([]);
    expect(code(t.requests.decline("u-alice", "a1", requestId))).toBe(
      "not_found",
    );
    expect(t.asks.remove(entry.id, { outcome: "withdrawn" })).toBeNull();
    expect(
      code(await t.requests.save("u-alice", "a1", requestId, { value: VALUE })),
    ).toBe("not_found");
    release();
    expect(await saving).toEqual({ ok: true, name: "GH_TOKEN" });
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
  });

  it("the agent's delete of the ask withdraws the request", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const [entry] = t.asks.listAll();
    t.asks.remove(entry.id, { outcome: "withdrawn" });
    expect(
      code(await t.requests.save("u-alice", "a1", requestId, { value: VALUE })),
    ).toBe("not_found");
    expect(code(t.requests.decline("u-alice", "a1", requestId))).toBe(
      "not_found",
    );
    expect(t.store.list({ kind: "user", userId: "u-alice" })).toEqual([]);
  });
});

describe("a store that cannot write", () => {
  it("a save still settles: the secret exists", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    t.control.failWrites = true;
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, { value: VALUE }),
    );
    expect(result.ok).toBe(true);
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
    // The ask stays until the store can write; a second save is refused.
    expect(t.asks.listAll()).toHaveLength(1);
    expect(output).not.toContain(VALUE);
    expect(
      code(await t.requests.save("u-alice", "a1", requestId, { value: VALUE })),
    ).toBe("secret_exists");
  });

  it("a decline fails with nothing settled, and the ask stays", () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    t.control.failWrites = true;
    expect(code(t.requests.decline("u-alice", "a1", requestId))).toBe(
      "request_failed",
    );
    expect(t.settled).toEqual([]);
    expect(t.asks.listAll()).toHaveLength(1);
  });
});

describe("a restart", () => {
  it("keeps an open request: the next boot's store answers the save, and settles it", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const next = t.boot();
    const entries: AskEntry[] = next.asks.listAll();
    expect(entries.map((e) => e.secret?.requestId)).toEqual([requestId]);
    const saved = await next.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(saved).toEqual({ ok: true, name: "GH_TOKEN" });
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
    expect(next.asks.listAll()).toEqual([]);
    expectNoValue({ ...t, asks: next.asks }, saved);
  });
});

// An app secret request (task 315a62c0): the value goes to an app's
// environment, saved in the app owner's secrets (or the office's) with the
// app's grant, and the request can go to a member other than the manager.
// The answerer must be allowed to write the target secrets: that member, or
// an office owner.
describe("an app secret request", () => {
  const GAME = { createdAt: 1000, userId: "u-carol" };
  const APP_ASK = {
    name: "YOUTUBE_CLIENT_SECRET",
    app: "game-video",
    reason: "The video app signs in to YouTube.",
  };
  const carol = { kind: "user", userId: "u-carol" } as const;
  const entryOf = (t: ReturnType<typeof setup>, requestId: string) => {
    const entry = t.asks
      .listAll()
      .find((e) => e.secret?.requestId === requestId);
    if (!entry) throw new Error(`no ask for ${requestId}`);
    return entry;
  };
  const saveAs = async (
    t: ReturnType<typeof setup>,
    userId: string,
    agentId: string,
    requestId: string,
    body: Record<string, unknown> = { value: VALUE },
  ) => failure(await t.requests.save(userId, agentId, requestId, body));

  it("an office owner named on the request saves it into the app owner's secrets, with the grant and no hosts", async () => {
    const t = setup({ a3: "u-carol" }, { "game-video": GAME });
    // The member name resolves whatever its case.
    const requestId = opened(
      t.requests.open("a3", { ...APP_ASK, member: "nil" }),
    );
    const entry = entryOf(t, requestId);
    expect(entry.memberUserId).toBe("u-owner");
    expect(entry.secret).toMatchObject({
      scope: "personal",
      name: "YOUTUBE_CLIENT_SECRET",
      hosts: [],
      app: { name: "game-video", createdAt: 1000 },
      ownerUserId: "u-carol",
    });
    // Only the named member answers: not the manager, not another owner.
    expect(await saveAs(t, "u-carol", "a3", requestId)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner2", "a3", requestId)).toBe("403 forbidden");
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-owner", "a3", requestId, { value: VALUE }),
    );
    expect(result).toEqual({ ok: true, name: "YOUTUBE_CLIENT_SECRET" });
    expect(t.store.list(carol)).toMatchObject([
      { name: "YOUTUBE_CLIENT_SECRET", hosts: [], apps: ["game-video"] },
    ]);
    expect(
      t.store.readSecretValues(carol, "YOUTUBE_CLIENT_SECRET")?.value,
    ).toBe(VALUE);
    expect(t.store.list({ kind: "user", userId: "u-owner" })).toEqual([]);
    expect(t.changes()).toBe(1);
    expect(t.asks.listAll()).toEqual([]);
    // Settled as answered by the member who saved, not the manager.
    expect(outcomes(t)).toEqual([["a3", requestId, "saved", "u-owner"]]);
    expectNoValue(t, result, output, t.settled);
  });

  it("goes to the manager by default; a named member instead; and only to one who may write the app owner's secrets", async () => {
    const t = setup({ a1: "u-alice", a3: "u-carol" }, { "game-video": GAME });
    // The app's owner manages the agent: the request is theirs.
    const own = opened(t.requests.open("a3", { ...APP_ASK, name: "OWN" }));
    expect(entryOf(t, own).memberUserId).toBe("u-carol");
    expect(await saveAs(t, "u-carol", "a3", own)).toBe("ok");
    expect(t.store.list(carol).map((s) => [s.name, s.apps])).toEqual([
      ["OWN", ["game-video"]],
    ]);
    // Alice manages a1 but may not write Carol's secrets, and neither may
    // Bob; Carol and an office owner may.
    expect(
      failure(t.requests.open("a1", { ...APP_ASK, name: "BY_ALICE" })),
    ).toBe("403 member_not_allowed");
    expect(
      failure(
        t.requests.open("a1", { ...APP_ASK, name: "BY_BOB", member: "Bob" }),
      ),
    ).toBe("403 member_not_allowed");
    expect(t.asks.listAll()).toEqual([]);
    const byCarol = opened(
      t.requests.open("a1", { ...APP_ASK, name: "BY_CAROL", member: "Carol" }),
    );
    expect(entryOf(t, byCarol).memberUserId).toBe("u-carol");
    const byNil = opened(
      t.requests.open("a1", { ...APP_ASK, name: "BY_NIL", member: "Nil" }),
    );
    expect(entryOf(t, byNil).secret?.ownerUserId).toBe("u-carol");
    expect(await saveAs(t, "u-alice", "a1", byNil)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner", "a1", byNil)).toBe("ok");
    expect(await saveAs(t, "u-carol", "a1", byCarol)).toBe("ok");
    expect(
      t.store
        .list(carol)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["BY_CAROL", "BY_NIL", "OWN"]);
    expect(t.store.list({ kind: "user", userId: "u-alice" })).toEqual([]);
  });

  it("an office app request goes to every owner, or to the one owner named; a named non-owner is refused", async () => {
    const t = setup({ a1: "u-alice" }, { "game-video": GAME });
    const office = { kind: "office" } as const;
    const anyOwner = opened(
      t.requests.open("a1", { ...APP_ASK, name: "ANY_OWNER", scope: "office" }),
    );
    const any = entryOf(t, anyOwner);
    expect("memberUserId" in any).toBe(false);
    expect(any.secret?.answerUserId).toBeUndefined();
    expect(await saveAs(t, "u-alice", "a1", anyOwner)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner2", "a1", anyOwner)).toBe("ok");
    const named = opened(
      t.requests.open("a1", {
        ...APP_ASK,
        name: "NAMED_OWNER",
        scope: "office",
        member: "Nil",
      }),
    );
    // The named owner rides on the request, never in memberUserId, which an
    // older server refuses on an office request (its whole asks file would
    // be set aside after a rollback).
    const one = entryOf(t, named);
    expect("memberUserId" in one).toBe(false);
    expect(one.secret?.answerUserId).toBe("u-owner");
    expect(await saveAs(t, "u-owner2", "a1", named)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner", "a1", named)).toBe("ok");
    expect(t.store.list(office).map((s) => [s.name, s.apps])).toEqual([
      ["ANY_OWNER", ["game-video"]],
      ["NAMED_OWNER", ["game-video"]],
    ]);
    // Carol owns the app but not the office.
    expect(
      failure(
        t.requests.open("a1", {
          ...APP_ASK,
          name: "BY_CAROL",
          scope: "office",
          member: "Carol",
        }),
      ),
    ).toBe("403 member_not_allowed");
  });

  it("a named member answers a request for the agent's own use, saved in the manager's secrets", async () => {
    const t = setup({ a1: "u-alice" });
    const requestId = opened(t.requests.open("a1", { ...ASK, member: "Nil" }));
    expect(entryOf(t, requestId).memberUserId).toBe("u-owner");
    expect(await saveAs(t, "u-alice", "a1", requestId)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner", "a1", requestId)).toBe("ok");
    expect(
      t.store.list({ kind: "user", userId: "u-alice" }).map((s) => s.name),
    ).toEqual(["GH_TOKEN"]);
    expect(t.store.list({ kind: "user", userId: "u-owner" })).toEqual([]);
    expect(
      failure(t.requests.open("a1", { ...ASK, name: "OTHER", member: "Bob" })),
    ).toBe("403 member_not_allowed");
  });

  it("refuses at open what the save could not do, checked against the target secrets", () => {
    const t = setup(
      { a1: "u-alice", a3: "u-carol", lone: null },
      { "game-video": GAME, orphan: { createdAt: 5, userId: null } },
    );
    const open = (agentId: string, body: Record<string, unknown>) =>
      t.requests.open(agentId, { ...APP_ASK, ...body });
    expect(failure(open("a3", { app: "no-such-app" }))).toBe("422 unknown_app");
    expect(failure(open("a3", { member: "Zed" }))).toBe("422 unknown_member");
    expect(failure(open("a3", { member: "Eve" }))).toBe("422 member_no_access");
    // The app reads the value from its environment: a request for an app
    // takes no hosts.
    expect(failure(open("a3", { hosts: ["api.github.com"] }))).toBe(
      "400 invalid_request",
    );
    // An unowned app has no member secrets to save into.
    expect(failure(open("a3", { app: "orphan" }))).toBe("409 no_app_owner");
    // An agent with no manager has no default answerer.
    expect(failure(open("lone", {}))).toBe("409 no_manager");
    const reserved = open("a3", { name: "PORT" });
    expect(reserved.ok ? null : reserved.detail).toEqual({
      field: "name",
      reason: "reserved",
    });
    // The office already gives this name to the app.
    t.store.create(
      { kind: "office" },
      {
        name: "SHARED",
        value: VALUE,
        hosts: [],
        form: { kind: "authorization" },
        apps: [{ name: "game-video", createdAt: 1000 }],
      },
    );
    const clash = open("a3", { name: "SHARED" });
    expect(clash.ok ? null : [clash.code, clash.detail]).toEqual([
      "invalid_secret",
      { field: "apps", reason: "clash" },
    ]);
    // Exists in the app owner's secrets, which are not the manager's.
    t.store.create(carol, {
      name: "EXISTING",
      value: VALUE,
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
    });
    expect(failure(open("a1", { name: "EXISTING", member: "Nil" }))).toBe(
      "409 secret_exists",
    );
    expect(t.asks.listAll()).toEqual([]);
    // What may open: hosts given as an empty list, an office request for an
    // unowned app, and a manager-less agent's request to a named member.
    opened(open("a3", { name: "EMPTY_HOSTS", hosts: [] }));
    opened(open("a3", { name: "ORPHAN", app: "orphan", scope: "office" }));
    const lone = opened(open("lone", { name: "LONE", member: "Nil" }));
    expect(entryOf(t, lone)).toMatchObject({
      memberUserId: "u-owner",
      secret: { ownerUserId: "u-carol" },
    });
  });

  it("one open request per target secret, whichever agent asks", () => {
    const t = setup({ a1: "u-alice", a3: "u-carol" }, { "game-video": GAME });
    opened(t.requests.open("a3", { ...APP_ASK, name: "DUP" }));
    // Same name, same target (Carol's secrets), another agent and answerer.
    expect(
      failure(
        t.requests.open("a1", { ...APP_ASK, name: "DUP", member: "Nil" }),
      ),
    ).toBe("409 request_open");
    // Same name in Alice's secrets is another secret.
    opened(t.requests.open("a1", { ...ASK, name: "DUP" }));
  });

  it("a save re-checks the app: gone, re-created or given to another owner is app_gone, and the request stays", async () => {
    const apps: Record<string, App> = { "game-video": { ...GAME } };
    const t = setup({ a3: "u-carol" }, apps);
    const requestId = opened(t.requests.open("a3", APP_ASK));
    const officeId = opened(
      t.requests.open("a3", {
        ...APP_ASK,
        name: "OFFICE_ONE",
        scope: "office",
      }),
    );
    delete apps["game-video"];
    expect(await saveAs(t, "u-carol", "a3", requestId)).toBe("409 app_gone");
    apps["game-video"] = { createdAt: 2000, userId: "u-carol" };
    expect(await saveAs(t, "u-carol", "a3", requestId)).toBe("409 app_gone");
    apps["game-video"] = { createdAt: 1000, userId: "u-bob" };
    expect(await saveAs(t, "u-carol", "a3", requestId)).toBe("409 app_gone");
    // The owner limits only member secrets: the office's still save.
    expect(await saveAs(t, "u-owner", "a3", officeId)).toBe("ok");
    expect(t.store.list(carol)).toEqual([]);
    expect(t.asks.listAll().map((e) => e.secret?.requestId)).toEqual([
      requestId,
    ]);
    expect(outcomes(t)).toEqual([["a3", officeId, "saved", "u-owner"]]);
    // A member cannot add hosts to it either.
    apps["game-video"] = { ...GAME };
    expect(
      await saveAs(t, "u-carol", "a3", requestId, {
        value: VALUE,
        hosts: ["api.github.com"],
      }),
    ).toBe("400 invalid_request");
    expect(t.store.list(carol)).toEqual([]);
    expect(await saveAs(t, "u-carol", "a3", requestId)).toBe("ok");
    expect(t.store.list(carol).map((s) => [s.name, s.apps])).toEqual([
      ["YOUTUBE_CLIENT_SECRET", ["game-video"]],
    ]);
  });

  it("the answerer's right is decided live: an owner who loses the role stops seeing and answering it", async () => {
    const t = setup({ a1: "u-alice" }, { "game-video": GAME });
    const personal = opened(
      t.requests.open("a1", { ...APP_ASK, member: "Nil" }),
    );
    const office = opened(
      t.requests.open("a1", {
        ...APP_ASK,
        name: "OFFICE_ONE",
        scope: "office",
        member: "Nil",
      }),
    );
    const visible = () =>
      [personal, office].map((id) =>
        askVisibleTo(entryOf(t, id), "u-owner", t.audience),
      );
    expect(visible()).toEqual([true, true]);
    t.owners.delete("u-owner");
    expect(visible()).toEqual([false, false]);
    expect(await saveAs(t, "u-owner", "a1", personal)).toBe("403 forbidden");
    expect(await saveAs(t, "u-owner", "a1", office)).toBe("403 forbidden");
    t.owners.add("u-owner");
    expect(await saveAs(t, "u-owner", "a1", personal)).toBe("ok");
    expect(await saveAs(t, "u-owner", "a1", office)).toBe("ok");
  });

  it("survives a restart: the next boot loads both kinds and saves them", async () => {
    const t = setup({ a1: "u-alice" }, { "game-video": GAME });
    const personal = opened(
      t.requests.open("a1", { ...APP_ASK, member: "Nil" }),
    );
    const office = opened(
      t.requests.open("a1", {
        ...APP_ASK,
        name: "OFFICE_ONE",
        scope: "office",
        member: "Nil",
      }),
    );
    const next = t.boot();
    // Loaded, not set aside: the store answers.
    expect(next.asks.listAll().map((e) => e.secret?.requestId)).toEqual([
      personal,
      office,
    ]);
    expect(
      failure(
        await next.requests.save("u-owner2", "a1", office, { value: VALUE }),
      ),
    ).toBe("403 forbidden");
    expect(
      failure(
        await next.requests.save("u-owner", "a1", personal, { value: VALUE }),
      ),
    ).toBe("ok");
    expect(
      failure(
        await next.requests.save("u-owner", "a1", office, { value: VALUE }),
      ),
    ).toBe("ok");
    expect(t.store.list(carol).map((s) => s.apps)).toEqual([["game-video"]]);
    expect(t.store.list({ kind: "office" }).map((s) => s.apps)).toEqual([
      ["game-video"],
    ]);
  });
});

// What the chat and the agent are told (task 9019f2f8): one line that says
// what happened - the secret, and the app or the secrets it went to - and
// nothing on how to use it.
describe("the outcome line", () => {
  const GAME = { createdAt: 1000, userId: "u-carol" };
  const APP_ASK = {
    name: "YOUTUBE_CLIENT_SECRET",
    app: "game-video",
    reason: "The video app signs in to YouTube.",
  };
  const lineOf = (t: { settled: Settled[] }, requestId: string) =>
    t.settled.find((s) => s.requestId === requestId)?.line;
  const save = async (
    t: ReturnType<typeof setup>,
    userId: string,
    agentId: string,
    requestId: string,
  ) => {
    const saved = await t.requests.save(userId, agentId, requestId, {
      value: VALUE,
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  };

  it("a personal save names the member whose secrets hold it, not the member who answered", async () => {
    const t = setup({ a1: "u-alice" });
    const own = opened(t.requests.open("a1", ASK));
    const byNil = opened(
      t.requests.open("a1", { ...ASK, name: "BY_NIL", member: "Nil" }),
    );
    await save(t, "u-alice", "a1", own);
    await save(t, "u-owner", "a1", byNil);
    expect(lineOf(t, own)).toEqual(
      msg("systemEntries.secretRequest.savedPersonal", {
        name: "GH_TOKEN",
        member: "Alice",
      }),
    );
    expect(lineOf(t, byNil)).toEqual(
      msg("systemEntries.secretRequest.savedPersonal", {
        name: "BY_NIL",
        member: "Alice",
      }),
    );
    expect(outcomes(t).map((o) => o[3])).toEqual(["u-alice", "u-owner"]);
  });

  it("an office save says the office secrets", async () => {
    const t = setup({ a1: "u-alice" });
    const office = opened(t.requests.open("a1", { ...ASK, scope: "office" }));
    await save(t, "u-owner", "a1", office);
    expect(lineOf(t, office)).toEqual(
      msg("systemEntries.secretRequest.savedOffice", { name: "GH_TOKEN" }),
    );
  });

  it("an app save names the app, whichever secrets hold it", async () => {
    const t = setup({ a3: "u-carol" }, { "game-video": GAME });
    const personal = opened(t.requests.open("a3", APP_ASK));
    const office = opened(
      t.requests.open("a3", {
        ...APP_ASK,
        name: "OFFICE_ONE",
        scope: "office",
      }),
    );
    await save(t, "u-carol", "a3", personal);
    await save(t, "u-owner", "a3", office);
    expect(lineOf(t, personal)).toEqual(
      msg("systemEntries.secretRequest.savedForApp", {
        name: "YOUTUBE_CLIENT_SECRET",
        app: "game-video",
      }),
    );
    expect(lineOf(t, office)).toEqual(
      msg("systemEntries.secretRequest.savedForApp", {
        name: "OFFICE_ONE",
        app: "game-video",
      }),
    );
  });

  it("a personal save into the secrets of a member with no name left says only the secret", async () => {
    const t = setup({ a9: GONE });
    const requestId = opened(t.requests.open("a9", ASK));
    await save(t, GONE, "a9", requestId);
    expect(lineOf(t, requestId)).toEqual(
      msg("systemEntries.secretRequest.saved", { name: "GH_TOKEN" }),
    );
  });

  it("a decline names the secret, for an agent's own request and an app's", () => {
    const t = setup({ a3: "u-carol" }, { "game-video": GAME });
    const own = opened(t.requests.open("a3", ASK));
    const app = opened(t.requests.open("a3", APP_ASK));
    expect(t.requests.decline("u-carol", "a3", own).ok).toBe(true);
    expect(t.requests.decline("u-carol", "a3", app).ok).toBe(true);
    expect(t.settled.map((s) => [s.outcome, s.line])).toEqual([
      [
        "declined",
        msg("systemEntries.secretRequest.declined", { name: "GH_TOKEN" }),
      ],
      [
        "declined",
        msg("systemEntries.secretRequest.declined", {
          name: "YOUTUBE_CLIENT_SECRET",
        }),
      ],
    ]);
  });
});

// A variable request (task c71cb60f): the member types the value of one
// managed variable in the ask, model sign-in keys included, and it is saved
// with the same after-effects as the Integrations page. It rides on the
// secret request (AskEntry.secret, kind "variable"), so every rule that keeps
// a value out of the chat applies to it.
describe("a variable request", () => {
  const VAR_ASK = {
    kind: "variable",
    name: "OPENAI_API_KEY",
    reason: "OpenCode needs an OpenAI key.",
  };
  const alice = { kind: "user", userId: "u-alice" } as const;

  it("opens an ask for the manager, model keys included; on disk it keeps what an older server's load check needs", () => {
    const t = setup({ a1: "u-alice", lone: null });
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    const [entry] = t.asks.listAll();
    expect(entry).toMatchObject({
      agentId: "a1",
      memberUserId: "u-alice",
      prompt: VAR_ASK.reason,
      secret: {
        requestId,
        kind: "variable",
        scope: "personal",
        name: "OPENAI_API_KEY",
        reason: VAR_ASK.reason,
        ownerUserId: "u-alice",
      },
    });
    // An older server loads it as a secret request (a masked form, never a
    // reply box), so the fields its check requires are on disk.
    const [stored] = JSON.parse(readFileSync(t.asksPath, "utf-8"));
    expect(stored.secret).toMatchObject({
      kind: "variable",
      hosts: [],
      form: { kind: "authorization" },
    });
    // An office request has no member: every owner answers.
    opened(t.requests.open("lone", { ...VAR_ASK, scope: "office" }));
    const office = t.asks.listAll().find((e) => e.agentId === "lone")!;
    expect(office.secret).toMatchObject({ kind: "variable", scope: "office" });
    expect("memberUserId" in office).toBe(false);
    // kind "secret" is today's request, stored with no kind.
    opened(t.requests.open("a1", { ...ASK, kind: "secret" }));
    const secret = t.asks.listAll().find((e) => e.secret?.name === "GH_TOKEN")!;
    expect(secret.secret).toMatchObject({ hosts: ["api.github.com"] });
    expect(secret.secret && "kind" in secret.secret).toBe(false);
  });

  it("refuses at open what the variable cannot be, and what only a secret takes", () => {
    const t = setup({ a1: "u-alice", lone: null });
    const failureOf = (agentId: string, body: unknown) =>
      failure(t.requests.open(agentId, body));
    const refused: [string, unknown][] = [
      ["not a variable name", { ...VAR_ASK, name: "not a name" }],
      [
        "a name shaped like a key",
        { ...VAR_ASK, name: "AKIAIOSFODNN7EXAMPLE" },
      ],
      ["hosts", { ...VAR_ASK, hosts: ["api.openai.com"] }],
      ["a form", { ...VAR_ASK, form: { kind: "authorization" } }],
      ["an app", { ...VAR_ASK, app: "game-video" }],
      ["a url", { ...VAR_ASK, url: "https://mcp.example.com/mcp" }],
      ["a secret", { ...VAR_ASK, secret: "GH_TOKEN" }],
      ["a value", { ...VAR_ASK, value: VALUE }],
      ["an unknown kind", { ...VAR_ASK, kind: "token" }],
      ["no reason", { ...VAR_ASK, reason: "" }],
      ["a credential in the reason", { ...VAR_ASK, reason: `use ${VALUE}` }],
    ];
    expect(
      refused.map(([what, body]) => [what, failureOf("a1", body)]),
    ).toEqual(refused.map(([what]) => [what, "400 invalid_request"]));
    expect(failureOf("lone", VAR_ASK)).toBe("409 no_member");
    // Set in the target scope: the member edits it on the page instead.
    t.env.users["u-alice"] = { OPENAI_API_KEY: "set-before" };
    expect(failureOf("a1", VAR_ASK)).toBe("409 variable_exists");
    // The office scope is another variable.
    expect(failureOf("a1", { ...VAR_ASK, scope: "office" })).toBe("ok");
    t.env.office = { TZ: "UTC" };
    expect(failureOf("lone", { ...VAR_ASK, name: "TZ", scope: "office" })).toBe(
      "409 variable_exists",
    );
    expect(t.asks.listAll()).toHaveLength(1);
    expect(t.env.users["u-alice"]).toEqual({ OPENAI_API_KEY: "set-before" });
  });

  it("one open request per variable; a secret of the same name is another request", () => {
    const t = setup();
    opened(t.requests.open("a1", VAR_ASK));
    expect(failure(t.requests.open("a1", VAR_ASK))).toBe("409 request_open");
    opened(t.requests.open("a1", { ...ASK, name: "DEPLOY_TOKEN" }));
    opened(t.requests.open("a1", { ...VAR_ASK, name: "DEPLOY_TOKEN" }));
    expect(t.asks.listAll()).toHaveLength(3);
  });

  it("goes to a named member only when they may write the target variables", () => {
    const t = setup();
    expect(failure(t.requests.open("a1", { ...VAR_ASK, member: "Bob" }))).toBe(
      "403 member_not_allowed",
    );
    expect(
      failure(
        t.requests.open("a1", { ...VAR_ASK, scope: "office", member: "Alice" }),
      ),
    ).toBe("403 member_not_allowed");
    opened(t.requests.open("a1", { ...VAR_ASK, member: "Nil" }));
    const [entry] = t.asks.listAll();
    expect([entry.memberUserId, entry.secret?.ownerUserId]).toEqual([
      "u-owner",
      "u-alice",
    ]);
  });

  it("the manager saves the value into their variables; the OpenCode push follows the write; the value is nowhere else", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    // Only the member the ask names answers it.
    expect(
      failure(
        await t.requests.save("u-bob", "a1", requestId, { value: VALUE }),
      ),
    ).toBe("403 forbidden");
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, { value: VALUE }),
    );
    expect(result).toEqual({ ok: true, name: "OPENAI_API_KEY" });
    expect(t.env.users["u-alice"]).toEqual({ OPENAI_API_KEY: VALUE });
    // A variable, not a secret.
    expect(t.store.list(alice)).toEqual([]);
    expect(t.pushes).toEqual([
      { scope: alice, variables: ["OPENAI_API_KEY"], servers: [] },
    ]);
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
    expect(t.settled[0].line).toEqual(
      msg("systemEntries.secretRequest.variableSavedPersonal", {
        name: "OPENAI_API_KEY",
        member: "Alice",
      }),
    );
    expect(t.asks.listAll()).toEqual([]);
    expectNoValue(t, result, output, t.settled);
  });

  it("an owner saves an office request into the office variables", async () => {
    const t = setup();
    const requestId = opened(
      t.requests.open("a1", { ...VAR_ASK, scope: "office" }),
    );
    expect(
      failure(
        await t.requests.save("u-alice", "a1", requestId, { value: VALUE }),
      ),
    ).toBe("403 forbidden");
    expect(
      await t.requests.save("u-owner", "a1", requestId, { value: VALUE }),
    ).toEqual({ ok: true, name: "OPENAI_API_KEY" });
    expect([t.env.office, t.env.users]).toEqual([
      { OPENAI_API_KEY: VALUE },
      {},
    ]);
    expect(t.pushes).toEqual([
      { scope: { kind: "office" }, variables: ["OPENAI_API_KEY"], servers: [] },
    ]);
    expect(t.settled[0].line).toEqual(
      msg("systemEntries.secretRequest.variableSavedOffice", {
        name: "OPENAI_API_KEY",
      }),
    );
  });

  it("a refused save keeps the request open, writes and pushes nothing, and says nothing of the value", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    const save = (body: unknown) =>
      captureConsole(() => t.requests.save("u-alice", "a1", requestId, body));
    const refused: [unknown, string][] = [
      [{}, "400 invalid_request"],
      [{ value: 5 }, "400 invalid_request"],
      [{ value: VALUE, hosts: [] }, "400 invalid_request"],
      [
        { value: VALUE, form: { kind: "authorization" } },
        "400 invalid_request",
      ],
      // A control character: the managed env refuses it, as on the page.
      [{ value: `${VALUE}\n` }, "400 invalid_env"],
    ];
    const seen: unknown[] = [];
    for (const [body, expected] of refused) {
      const { result, output } = await save(body);
      expect([body, failure(result)]).toEqual([body, expected]);
      seen.push(result, output);
    }
    expectNoValue(t, ...seen);
    expect([t.env.users, t.pushes, t.settled]).toEqual([{}, [], []]);
    expect(t.asks.listAll()).toHaveLength(1);
    expect(
      (await t.requests.save("u-alice", "a1", requestId, { value: VALUE })).ok,
    ).toBe(true);
  });

  it("a variable set since the request is not replaced: variable_exists, and the request stays", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    t.env.users["u-alice"] = { OPENAI_API_KEY: "set-on-the-page" };
    expect(
      failure(
        await t.requests.save("u-alice", "a1", requestId, { value: VALUE }),
      ),
    ).toBe("409 variable_exists");
    expect(t.env.users["u-alice"]).toEqual({
      OPENAI_API_KEY: "set-on-the-page",
    });
    expect([t.pushes, t.settled]).toEqual([[], []]);
    expect(t.asks.listAll()).toHaveLength(1);
  });

  it("a decline names the variable and writes nothing", () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    expect(t.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "OPENAI_API_KEY",
    });
    expect(t.settled.map((s) => [s.outcome, s.line])).toEqual([
      [
        "declined",
        msg("systemEntries.secretRequest.declined", { name: "OPENAI_API_KEY" }),
      ],
    ]);
    expect([t.env.users, t.pushes, t.asks.listAll()]).toEqual([{}, [], []]);
  });

  it("survives a restart as a variable request: the next boot saves a variable, not a secret", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", VAR_ASK));
    const next = t.boot();
    expect(next.asks.listAll().map((e) => e.secret?.kind)).toEqual([
      "variable",
    ]);
    expect(
      await next.requests.save("u-alice", "a1", requestId, { value: VALUE }),
    ).toEqual({ ok: true, name: "OPENAI_API_KEY" });
    expect(t.env.users["u-alice"]).toEqual({ OPENAI_API_KEY: VALUE });
    expect(t.store.list(alice)).toEqual([]);
  });
});

// An MCP server request (task c71cb60f): the agent proposes a name, and
// optionally a URL and a secret of the target scope; the member types or
// edits the URL and picks the secret in the ask, and the server is created as
// the Integrations page creates it. The URL can carry a token, so no line,
// answer or log holds it.
describe("an MCP server request", () => {
  const URL = "https://mcp.example.com/mcp";
  // A URL with a key in its query, as some servers take it.
  const KEYED_URL = `https://mcp.example.com/mcp?key=${VALUE}`;
  const MCP_ASK = {
    kind: "mcp-server",
    name: "docs",
    reason: "To read the docs server.",
    url: URL,
  };
  const alice = { kind: "user", userId: "u-alice" } as const;
  // A secret for the server's host, and one for another host.
  function secrets(t: ReturnType<typeof setup>, scope: SecretScope = alice) {
    t.store.create(scope, {
      name: "DOCS_TOKEN",
      value: VALUE,
      hosts: ["mcp.example.com"],
      form: { kind: "authorization" },
    });
    t.store.create(scope, {
      name: "GH_TOKEN",
      value: VALUE,
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
    });
  }
  const serversOf = (t: ReturnType<typeof setup>, scope: SecretScope) =>
    t.servers.list(scope).map((s) => [s.name, s.url, s.secret]);

  it("opens an ask with the proposals; on disk it keeps what an older server's load check needs", () => {
    const t = setup();
    secrets(t);
    // The secret's host need not match the proposed URL: the member can
    // change either.
    const requestId = opened(
      t.requests.open("a1", { ...MCP_ASK, secret: "GH_TOKEN" }),
    );
    const [entry] = t.asks.listAll();
    expect(entry).toMatchObject({
      agentId: "a1",
      memberUserId: "u-alice",
      secret: {
        requestId,
        kind: "mcp-server",
        scope: "personal",
        name: "docs",
        url: URL,
        secret: "GH_TOKEN",
        ownerUserId: "u-alice",
      },
    });
    const [stored] = JSON.parse(readFileSync(t.asksPath, "utf-8"));
    expect(stored.secret).toMatchObject({
      kind: "mcp-server",
      hosts: [],
      form: { kind: "authorization" },
    });
    // No proposal at all is a request too.
    opened(
      t.requests.open("a1", {
        kind: "mcp-server",
        name: "linear",
        reason: "To read the issues.",
      }),
    );
  });

  it("refuses at open what the server cannot be", () => {
    const t = setup({ a1: "u-alice", lone: null });
    secrets(t, { kind: "office" });
    const failureOf = (agentId: string, body: unknown) =>
      failure(t.requests.open(agentId, body));
    const refused: [string, unknown, string][] = [
      [
        "a bad name",
        { ...MCP_ASK, name: "bad name!" },
        "400 invalid_mcp_server",
      ],
      [
        "plain http to another machine",
        { ...MCP_ASK, url: "http://mcp.example.com/mcp" },
        "400 invalid_mcp_server",
      ],
      [
        "a secret of no such name",
        { ...MCP_ASK, secret: "NOPE" },
        "422 secret_not_found",
      ],
      [
        "a secret of another scope",
        { ...MCP_ASK, secret: "DOCS_TOKEN" },
        "422 secret_not_found",
      ],
      [
        "hosts",
        { ...MCP_ASK, hosts: ["mcp.example.com"] },
        "400 invalid_request",
      ],
      [
        "a form",
        { ...MCP_ASK, form: { kind: "authorization" } },
        "400 invalid_request",
      ],
      ["an app", { ...MCP_ASK, app: "game-video" }, "400 invalid_request"],
      ["a value", { ...MCP_ASK, value: VALUE }, "400 invalid_request"],
      ["an OAuth setup", { ...MCP_ASK, oauth: {} }, "400 invalid_request"],
      ["no reason", { ...MCP_ASK, reason: "" }, "400 invalid_request"],
    ];
    expect(
      refused.map(([what, body]) => [what, failureOf("a1", body)]),
    ).toEqual(refused.map(([what, , expected]) => [what, expected]));
    expect(failureOf("lone", MCP_ASK)).toBe("409 no_member");
    // The office secret is good for an office request.
    expect(
      failureOf("lone", { ...MCP_ASK, scope: "office", secret: "DOCS_TOKEN" }),
    ).toBe("ok");
    t.servers.create(alice, { name: "docs", url: URL, secret: null });
    expect(failureOf("a1", MCP_ASK)).toBe("409 mcp_server_exists");
    expect(failureOf("a1", { ...MCP_ASK, name: "docs2" })).toBe("ok");
    expect(failureOf("a1", { ...MCP_ASK, name: "docs2" })).toBe(
      "409 request_open",
    );
  });

  it("the manager saves the URL as typed, with no secret; the push follows the create; the URL is in no line, answer or log", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", MCP_ASK));
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, {
        url: KEYED_URL,
        secret: null,
      }),
    );
    expect(result).toEqual({ ok: true, name: "docs" });
    expect(serversOf(t, alice)).toEqual([["docs", KEYED_URL, null]]);
    expect(t.pushes).toEqual([
      { scope: alice, variables: [], servers: ["docs"] },
    ]);
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
    expect(t.settled[0].line).toEqual(
      msg("systemEntries.secretRequest.mcpServerSavedPersonal", {
        name: "docs",
        member: "Alice",
      }),
    );
    expect(t.asks.listAll()).toEqual([]);
    // VALUE is the key inside the URL.
    expectNoValue(t, result, output, t.settled);
  });

  it("saves with the secret the member picked, checked as the page checks it", async () => {
    const t = setup();
    secrets(t);
    const requestId = opened(t.requests.open("a1", MCP_ASK));
    const save = (body: unknown) =>
      t.requests.save("u-alice", "a1", requestId, body);
    const refused: [unknown, string][] = [
      [{ url: URL, secret: "GH_TOKEN" }, "422 secret_host_mismatch"],
      [{ url: URL, secret: "NOPE" }, "422 secret_not_found"],
      [
        { url: "http://mcp.example.com/mcp", secret: null },
        "400 invalid_mcp_server",
      ],
      [{ url: URL, secret: null, value: VALUE }, "400 invalid_request"],
      [{ url: URL, secret: null, oauth: {} }, "400 invalid_request"],
      [{ url: URL, secret: null, name: "other" }, "400 invalid_request"],
    ];
    for (const [body, expected] of refused)
      expect([body, failure(await save(body))]).toEqual([body, expected]);
    expect([serversOf(t, alice), t.pushes, t.settled]).toEqual([[], [], []]);
    expect(t.asks.listAll()).toHaveLength(1);
    expect(await save({ url: URL, secret: "DOCS_TOKEN" })).toEqual({
      ok: true,
      name: "docs",
    });
    expect(serversOf(t, alice)).toEqual([["docs", URL, "DOCS_TOKEN"]]);
  });

  it("a server made since the request is not replaced: mcp_server_exists, and the request stays", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", MCP_ASK));
    t.servers.create(alice, {
      name: "docs",
      url: "https://other.example.com/mcp",
      secret: null,
    });
    expect(
      failure(
        await t.requests.save("u-alice", "a1", requestId, {
          url: URL,
          secret: null,
        }),
      ),
    ).toBe("409 mcp_server_exists");
    expect(serversOf(t, alice)).toEqual([
      ["docs", "https://other.example.com/mcp", null],
    ]);
    expect([t.pushes, t.settled]).toEqual([[], []]);
    expect(t.asks.listAll()).toHaveLength(1);
  });

  it("an owner saves an office request into the office servers", async () => {
    const t = setup();
    const requestId = opened(
      t.requests.open("a1", { ...MCP_ASK, scope: "office" }),
    );
    expect(
      failure(
        await t.requests.save("u-alice", "a1", requestId, {
          url: URL,
          secret: null,
        }),
      ),
    ).toBe("403 forbidden");
    expect(
      await t.requests.save("u-owner", "a1", requestId, {
        url: URL,
        secret: null,
      }),
    ).toEqual({ ok: true, name: "docs" });
    expect([serversOf(t, { kind: "office" }), serversOf(t, alice)]).toEqual([
      [["docs", URL, null]],
      [],
    ]);
    expect(t.pushes).toEqual([
      { scope: { kind: "office" }, variables: [], servers: ["docs"] },
    ]);
    expect(t.settled[0].line).toEqual(
      msg("systemEntries.secretRequest.mcpServerSavedOffice", { name: "docs" }),
    );
  });

  it("a decline names the server and creates nothing", () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", MCP_ASK));
    expect(t.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "docs",
    });
    expect(t.settled.map((s) => [s.outcome, s.line])).toEqual([
      [
        "declined",
        msg("systemEntries.secretRequest.declined", { name: "docs" }),
      ],
    ]);
    expect([serversOf(t, alice), t.pushes]).toEqual([[], []]);
  });

  // A server that signs in with OAuth (task acf443f4): the agent says so
  // instead of proposing a secret, and the save makes a server the member
  // signs in to.
  it("an OAuth request: the ask keeps the flag, and the save makes a signed-out OAuth server with no secret", async () => {
    const t = setup();
    const requestId = opened(
      t.requests.open("a1", { ...MCP_ASK, oauth: true }),
    );
    const [entry] = t.asks.listAll();
    expect(entry.secret).toMatchObject({ kind: "mcp-server", oauth: true });
    expect(entry.secret).not.toHaveProperty("secret");
    expect(
      await t.requests.save("u-alice", "a1", requestId, {
        url: URL,
        secret: null,
        oauth: true,
      }),
    ).toEqual({ ok: true, name: "docs" });
    expect(
      t.servers.list(alice).map((s) => [s.name, s.secret, s.oauth]),
    ).toEqual([["docs", null, { clientId: null, signedIn: false }]]);
    expect(t.pushes).toEqual([
      { scope: alice, variables: [], servers: ["docs"] },
    ]);
    expect(outcomes(t)).toEqual([["a1", requestId, "saved", "u-alice"]]);
  });

  it("refuses at open an OAuth flag with a secret, a flag that is not true, and an OAuth server on plain http", () => {
    const t = setup();
    secrets(t);
    const LOOPBACK = "http://127.0.0.1:8080/mcp";
    const refused: [string, unknown, string][] = [
      [
        "OAuth and a secret",
        { ...MCP_ASK, oauth: true, secret: "DOCS_TOKEN" },
        "400 invalid_request",
      ],
      ["oauth false", { ...MCP_ASK, oauth: false }, "400 invalid_request"],
      ["oauth a string", { ...MCP_ASK, oauth: "yes" }, "400 invalid_request"],
      // A server that signs in sends a credential: the URL rules of a
      // secret, so not even loopback http.
      [
        "OAuth on loopback http",
        { ...MCP_ASK, oauth: true, url: LOOPBACK },
        "400 invalid_mcp_server",
      ],
    ];
    expect(
      refused.map(([what, body]) => [
        what,
        failure(t.requests.open("a1", body)),
      ]),
    ).toEqual(refused.map(([what, , expected]) => [what, expected]));
    expect(t.asks.listAll()).toEqual([]);
    // The same loopback URL with no sign-in is a request.
    expect(failure(t.requests.open("a1", { ...MCP_ASK, url: LOOPBACK }))).toBe(
      "ok",
    );
  });

  it("the member picks the sign-in: the request's flag is only a proposal, and OAuth with a secret is refused at the save", async () => {
    const t = setup();
    secrets(t);
    const plain = opened(t.requests.open("a1", MCP_ASK));
    const signIn = opened(
      t.requests.open("a1", { ...MCP_ASK, name: "notes", oauth: true }),
    );
    const refused: [unknown, string][] = [
      [{ url: URL, secret: "DOCS_TOKEN", oauth: true }, "400 invalid_request"],
      [{ url: URL, secret: null, oauth: false }, "400 invalid_request"],
      [
        { url: "http://127.0.0.1:8080/mcp", secret: null, oauth: true },
        "400 invalid_mcp_server",
      ],
    ];
    for (const [body, expected] of refused)
      expect([
        body,
        failure(await t.requests.save("u-alice", "a1", plain, body)),
      ]).toEqual([body, expected]);
    expect([t.servers.list(alice), t.pushes, t.settled]).toEqual([[], [], []]);
    // OAuth on a request that proposed none; none on one that proposed it.
    expect(
      await t.requests.save("u-alice", "a1", plain, {
        url: URL,
        secret: null,
        oauth: true,
      }),
    ).toEqual({ ok: true, name: "docs" });
    expect(
      await t.requests.save("u-alice", "a1", signIn, {
        url: URL,
        secret: "DOCS_TOKEN",
      }),
    ).toEqual({ ok: true, name: "notes" });
    expect(
      t.servers.list(alice).map((s) => [s.name, s.secret, s.oauth !== null]),
    ).toEqual([
      ["docs", null, true],
      ["notes", "DOCS_TOKEN", false],
    ]);
  });

  it("survives a restart as an MCP server request: the next boot creates the server", async () => {
    const t = setup();
    const requestId = opened(
      t.requests.open("a1", { ...MCP_ASK, url: undefined }),
    );
    const next = t.boot();
    expect(next.asks.listAll().map((e) => e.secret?.kind)).toEqual([
      "mcp-server",
    ]);
    expect(
      await next.requests.save("u-alice", "a1", requestId, {
        url: URL,
        secret: null,
      }),
    ).toEqual({ ok: true, name: "docs" });
    expect(serversOf(t, alice)).toEqual([["docs", URL, null]]);
    expect(t.store.list(alice)).toEqual([]);
  });
});

// A request of a kind this server does not know, written by a later release
// before a rollback (task c71cb60f): the asks file still loads, the request
// cannot be saved here, and the member can still decline it.
describe("a request of a later kind", () => {
  it("loads with the other asks; its save is request_unsupported and leaves it open; a decline settles it", async () => {
    const t = setup();
    const requestId = opened(
      t.requests.open("a1", {
        kind: "variable",
        name: "FUTURE_SETTING",
        reason: "A later release asked for it.",
      }),
    );
    const plain = t.asks.create({
      agentId: "a1",
      memberUserId: "u-alice",
      prompt: "Go?",
    });
    if (!plain.ok) throw new Error("plain ask refused");
    // A later release wrote the same request with a kind this one lacks.
    const file = JSON.parse(readFileSync(t.asksPath, "utf-8")) as AskEntry[];
    const future = file.map((e) =>
      e.secret ? { ...e, secret: { ...e.secret, kind: "later-kind" } } : e,
    );
    writeFileSync(t.asksPath, JSON.stringify(future, null, 2));
    const next = t.boot();
    // The whole file loaded: both asks, the later kind as written.
    expect(
      next.asks
        .listAll()
        .map((e) => [e.prompt, e.secret?.kind ?? null])
        .sort(),
    ).toEqual([
      ["A later release asked for it.", "later-kind"],
      ["Go?", null],
    ]);
    expect(
      failure(
        await next.requests.save("u-alice", "a1", requestId, { value: VALUE }),
      ),
    ).toBe("409 request_unsupported");
    expect([
      t.env.users,
      t.store.list({ kind: "user", userId: "u-alice" }),
    ]).toEqual([{}, []]);
    expect([t.pushes, t.settled]).toEqual([[], []]);
    expect(next.asks.listAll()).toHaveLength(2);
    expect(next.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "FUTURE_SETTING",
    });
    expect(t.settled.map((s) => [s.outcome, s.line])).toEqual([
      [
        "declined",
        msg("systemEntries.secretRequest.declined", { name: "FUTURE_SETTING" }),
      ],
    ]);
    expect(next.asks.listAll().map((e) => e.prompt)).toEqual(["Go?"]);
  });
});
