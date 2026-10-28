// The secret request core (secrets loop, B4): what the agent may ask, who may
// answer, that an open request is an ask that survives a restart, and that
// no answer, ask, event or message carries the value.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createSecretStore } from "./secret-store.ts";

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
type App = { createdAt: number; userId: string | null };

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
  const store = createSecretStore(root);
  const asksPath = join(root, "asks.json");
  const events: AskChange[] = [];
  const settled: unknown[][] = [];
  const told: { agentId: string; userId: string; text: string }[] = [];
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
      placeholderOf: (scope, name) =>
        `ghp_PLACEHOLDER${scope.kind}${name}`.slice(0, 40),
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
      emitSettled: (...args) => settled.push(args),
      tellAgent: (agentId, userId, text) =>
        told.push({ agentId, userId, text }),
    });
    return { asks, requests, control };
  }
  const first = boot();
  return {
    ...first,
    store,
    asksPath,
    owners,
    audience,
    events,
    settled,
    told,
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
      placeholderOf: () => null,
      agentUserId: () => "u-alice",
      appFor: () => null,
      memberByName: () => null,
      emitSettled: () => {},
      tellAgent: () => {},
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
  it("the manager saves with edited hosts; the agent gets the placeholder, never the value", async () => {
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
    expect(t.settled).toEqual([["a1", requestId, "saved", "GH_TOKEN"]]);
    expect(t.told).toHaveLength(1);
    expect(t.told[0].userId).toBe("u-alice");
    expect(t.told[0].text).toContain("ghp_PLACEHOLDERuserGH_TOKEN");
    // The save closed the ask: an upsert and then a removal.
    expect(t.asks.listAll()).toEqual([]);
    expect(t.events.map((e) => e.kind)).toEqual(["upserted", "removed"]);
    // The value is in the secret store and nowhere else.
    expectNoValue(t, result, output, t.settled, t.told);
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

  it("the manager declines; the agent is told, the ask closes and nothing is stored", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    expect(t.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "GH_TOKEN",
    });
    expect(t.settled).toEqual([["a1", requestId, "declined", "GH_TOKEN"]]);
    expect(t.told).toHaveLength(1);
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
    expect(t.told).toEqual([]);
    expect(t.settled).toEqual([]);
    expect(code(t.requests.decline("u-alice", "a1", requestId))).toBe(
      "not_found",
    );
    expect(t.asks.remove(entry.id)).toBeNull();
    expect(
      code(await t.requests.save("u-alice", "a1", requestId, { value: VALUE })),
    ).toBe("not_found");
    release();
    expect(await saving).toEqual({ ok: true, name: "GH_TOKEN" });
    expect(t.settled).toEqual([["a1", requestId, "saved", "GH_TOKEN"]]);
    expect(t.told).toHaveLength(1);
  });

  it("the agent's delete of the ask withdraws the request", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const [entry] = t.asks.listAll();
    t.asks.remove(entry.id);
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
  it("a save still settles and tells the agent: the secret exists", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    t.control.failWrites = true;
    const { result, output } = await captureConsole(() =>
      t.requests.save("u-alice", "a1", requestId, { value: VALUE }),
    );
    expect(result.ok).toBe(true);
    expect(t.settled).toEqual([["a1", requestId, "saved", "GH_TOKEN"]]);
    expect(t.told).toHaveLength(1);
    // The ask stays until the store can write; a second save is refused.
    expect(t.asks.listAll()).toHaveLength(1);
    expect(output).not.toContain(VALUE);
    expect(
      code(await t.requests.save("u-alice", "a1", requestId, { value: VALUE })),
    ).toBe("secret_exists");
  });

  it("a decline fails with nothing settled or told, and the ask stays", () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    t.control.failWrites = true;
    expect(code(t.requests.decline("u-alice", "a1", requestId))).toBe(
      "request_failed",
    );
    expect(t.settled).toEqual([]);
    expect(t.told).toEqual([]);
    expect(t.asks.listAll()).toHaveLength(1);
  });
});

describe("a restart", () => {
  it("keeps an open request: the next boot's store answers the save, and the agent is told", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const next = t.boot();
    const entries: AskEntry[] = next.asks.listAll();
    expect(entries.map((e) => e.secret?.requestId)).toEqual([requestId]);
    const saved = await next.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(saved).toEqual({ ok: true, name: "GH_TOKEN" });
    expect(t.told.map((m) => m.agentId)).toEqual(["a1"]);
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
    expect(t.settled).toEqual([
      ["a3", requestId, "saved", "YOUTUBE_CLIENT_SECRET"],
    ]);
    // The agent hears it from the member who saved, about the app; with no
    // host there is no placeholder to give.
    expect(t.told).toHaveLength(1);
    expect(t.told[0].userId).toBe("u-owner");
    expect(t.told[0].text).toContain("game-video");
    expect(t.told[0].text).not.toContain("ghp_PLACEHOLDER");
    expectNoValue(t, result, output, t.settled, t.told);
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
    // The secret is for the agent: it gets its placeholder.
    expect(t.told[0].text).toContain("ghp_PLACEHOLDERuserGH_TOKEN");
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
    expect(t.settled).toEqual([["a3", officeId, "saved", "OFFICE_ONE"]]);
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
