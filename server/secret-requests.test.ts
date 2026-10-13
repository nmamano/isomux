// The secret request core (secrets loop, B4): what the agent may ask, who may
// answer, and that no answer, entry or message carries the value.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecretRequestPayload } from "../shared/types.ts";
import { createSecretRequests, SERVER_BOOT_ID } from "./secret-requests.ts";
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

function setup(agents: Record<string, string | null> = { a1: "u-alice" }) {
  const root = mkdtempSync(join(tmpdir(), "isomux-secret-requests-"));
  roots.push(root);
  const store = createSecretStore(root);
  const cards: { agentId: string; payload: SecretRequestPayload }[] = [];
  const settled: unknown[][] = [];
  const told: { agentId: string; userId: string; text: string }[] = [];
  let changes = 0;
  const requests = createSecretRequests({
    store,
    onChanged: async () => {
      changes++;
    },
    placeholderOf: (scope, name) =>
      `ghp_PLACEHOLDER${scope.kind}${name}`.slice(0, 40),
    agentUserId: (agentId) =>
      Object.hasOwn(agents, agentId) ? agents[agentId] : undefined,
    isOfficeOwnerUserId: (userId) => userId === "u-owner",
    emitRequest: (agentId, payload) => {
      cards.push({ agentId, payload });
      return true;
    },
    emitSettled: (...args) => settled.push(args),
    tellAgent: (agentId, userId, text) => told.push({ agentId, userId, text }),
  });
  return {
    store,
    requests,
    cards,
    settled,
    told,
    changes: () => changes,
  };
}

function opened(
  result: ReturnType<ReturnType<typeof setup>["requests"]["open"]>,
) {
  if (!result.ok) throw new Error(`open refused: ${result.code}`);
  return result.requestId;
}

describe("the agent's ask", () => {
  it("opens a card with the proposed name, hosts, form and reason", () => {
    const { requests, cards } = setup();
    const requestId = opened(requests.open("a1", ASK));
    expect(cards).toHaveLength(1);
    expect(cards[0].payload).toEqual({
      requestId,
      scope: "personal",
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      reason: "To open the pull request.",
      // full_state carries the same id: a card from another boot is closed.
      bootId: SERVER_BOOT_ID,
    });
  });

  it("refuses a second open request for the same secret, and allows it once the first settles", () => {
    const { requests } = setup();
    const first = opened(requests.open("a1", ASK));
    const again = requests.open("a1", ASK);
    expect(again.ok ? "ok" : again.code).toBe("request_open");
    // Another name, or the office scope, is another secret.
    opened(requests.open("a1", { ...ASK, name: "OTHER_TOKEN" }));
    opened(requests.open("a1", { ...ASK, scope: "office" }));
    requests.decline("u-alice", "a1", first);
    opened(requests.open("a1", ASK));
  });

  it("refuses what the store would refuse, before the member sees a card", () => {
    const { requests, cards, store } = setup({ a1: "u-alice", lone: null });
    const code = (agentId: string, body: unknown) => {
      const result = requests.open(agentId, body);
      return result.ok ? "ok" : result.code;
    };
    expect(code("a1", { ...ASK, hosts: ["api.anthropic.com"] })).toBe(
      "host_not_allowed",
    );
    expect(code("a1", { ...ASK, name: "not a name" })).toBe("invalid_secret");
    expect(code("a1", { ...ASK, name: "AKIAIOSFODNN7EXAMPLE" })).toBe(
      "invalid_secret",
    );
    expect(code("a1", { ...ASK, reason: "" })).toBe("invalid_request");
    expect(code("a1", { ...ASK, reason: `use ${VALUE}` })).toBe(
      "invalid_request",
    );
    expect(code("a1", { ...ASK, value: VALUE })).toBe("invalid_request");
    expect(code("a1", { ...ASK, scope: "team" })).toBe("invalid_request");
    expect(code("nobody", ASK)).toBe("not_found");
    // An agent with no manager has no personal scope.
    expect(code("lone", ASK)).toBe("no_member");
    expect(code("lone", { ...ASK, scope: "office" })).toBe("ok");
    store.create(
      { kind: "user", userId: "u-alice" },
      { ...ASK, value: VALUE, form: { kind: "authorization" } },
    );
    expect(code("a1", ASK)).toBe("secret_exists");
    expect(cards).toHaveLength(1);
  });
});

describe("the member's answer", () => {
  it("the manager saves with edited hosts; the agent gets the placeholder, never the value", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const result = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
      hosts: ["api.github.com", "uploads.github.com"],
    });
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
    // The value is in the store and nowhere else.
    const everything = JSON.stringify([result, t.cards, t.settled, t.told]);
    expect(everything).not.toContain(VALUE);
    // Settled: a second answer finds nothing.
    const again = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(again.ok ? "ok" : again.code).toBe("not_found");
  });

  it("only the manager answers a personal request, and only an owner an office one", async () => {
    const t = setup();
    const personal = opened(t.requests.open("a1", ASK));
    const office = opened(
      t.requests.open("a1", { ...ASK, name: "OFFICE_TOKEN", scope: "office" }),
    );
    const code = async (userId: string | null, requestId: string) => {
      const result = await t.requests.save(userId, "a1", requestId, {
        value: VALUE,
      });
      return result.ok ? "ok" : result.code;
    };
    expect(await code("u-bob", personal)).toBe("forbidden");
    expect(await code(null, personal)).toBe("forbidden");
    expect(await code("u-owner", personal)).toBe("forbidden");
    expect(await code("u-alice", office)).toBe("forbidden");
    expect(t.requests.decline("u-bob", "a1", personal).ok).toBe(false);
    // Another agent's path does not reach the request.
    const wrongAgent = await t.requests.save("u-alice", "a2", personal, {
      value: VALUE,
    });
    expect(wrongAgent.ok ? "ok" : wrongAgent.code).toBe("not_found");
    expect(await code("u-owner", office)).toBe("ok");
    expect(t.store.list({ kind: "office" }).map((s) => s.name)).toEqual([
      "OFFICE_TOKEN",
    ]);
    expect(t.store.list({ kind: "user", userId: "u-bob" })).toEqual([]);
  });

  it("a refused value keeps the request open, and says nothing of the value", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    const bad = await t.requests.save("u-alice", "a1", requestId, {
      value: ` ${VALUE}`,
    });
    expect(bad.ok ? "ok" : bad.code).toBe("invalid_secret");
    expect(JSON.stringify(bad)).not.toContain(VALUE);
    const neverListed = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
      hosts: ["api.openai.com"],
    });
    expect(neverListed.ok ? "ok" : neverListed.code).toBe("host_not_allowed");
    expect(t.settled).toEqual([]);
    expect(
      (await t.requests.save("u-alice", "a1", requestId, { value: VALUE })).ok,
    ).toBe(true);
  });

  it("the manager declines; the agent is told and nothing is stored", async () => {
    const t = setup();
    const requestId = opened(t.requests.open("a1", ASK));
    expect(t.requests.decline("u-alice", "a1", requestId)).toEqual({
      ok: true,
      name: "GH_TOKEN",
    });
    expect(t.settled).toEqual([["a1", requestId, "declined", "GH_TOKEN"]]);
    expect(t.told).toHaveLength(1);
    expect(t.store.list({ kind: "user", userId: "u-alice" })).toEqual([]);
    expect(t.changes()).toBe(0);
    const late = await t.requests.save("u-alice", "a1", requestId, {
      value: VALUE,
    });
    expect(late.ok ? "ok" : late.code).toBe("not_found");
  });
});
