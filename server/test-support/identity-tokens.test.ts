// Phase 2.1 - Identity & capabilities: the token store + capability sets.
//
// TDD red-green for NEW code (not characterization). Asserts the contract from
// the API spec (generic-runtime-refactor.md → "Identities and capabilities"):
// three capability scopes, an in-memory token store that mints/rotates/revokes
// and resolves a raw bearer to an Identity, and the stateless auth helpers
// (readBearerToken, identityFromSession). Zero LLM, no server, no FS.
//
// Rotation and revocation through the agent lifecycle are owned by
// identity-lifecycle.test.ts, and run tokens by cronjob-manager.di.test.ts.

import { describe, it, expect, afterEach } from "bun:test";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  APP_CAPABILITIES,
  API_CAPABILITIES,
  identityHasCapability,
  readBearerToken,
  type Capability,
} from "../identity/index.ts";
import {
  mintAgentToken,
  revokeAgentToken,
  resolveToken,
  redactTokens,
  _testResetTokens,
} from "../identity/tokens.ts";

afterEach(() => _testResetTokens());

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { headers });
}

// Every capability set, pinned exactly. A capability added to or removed from
// any set fails here; this is the only test that sees, for example, app:message
// given to agents (appScope would still refuse it on the route).
const AGENT_EXACT: Capability[] = [
  "agent:send-as-self",
  "agent:send-to-api-token",
  "self:affordance",
  "task:read",
  "task:write",
  "memory:read",
  "memory:write",
  // Conversation-log reads (GET /api/agents/:id/logs). Its own capability
  // rather than office:read, which an agent token does not carry.
  "log:read",
  // The app registry. BASELINE, not a privileged extra: an ordinary agent
  // registering the app it just built is the whole feature. Who may touch
  // WHICH app is the appOwnerOrOfficeOwner guard's job.
  "app:read",
  "app:write",
  // The pager: an agent raises pages to its manager and acts on pages in
  // rooms its manager can access.
  "pager:raise",
  "pager:read",
  "pager:write",
  // The webhook registry, baseline like apps; the webhookOwnerOrOfficeOwner
  // guard scopes it.
  "webhook:read",
  "webhook:write",
  // Voice through OpenAI; each call spends the manager's voice key.
  "voice:use",
];
const EXACT_SETS: Array<[string, readonly Capability[], Capability[]]> = [
  ["AGENT", AGENT_CAPABILITIES, AGENT_EXACT],
  [
    // The AGENT base plus the curated operator delta (Nil-locked, task
    // 98d63ef7). The escalation caps (invite:manage, secret:show, user:env,
    // session:manage, user:self, user:admin, office:admin, view:manage,
    // terminal:use, agent:privilege) never reach a privileged agent.
    "PRIVILEGED_AGENT",
    PRIVILEGED_AGENT_CAPABILITIES,
    [
      ...AGENT_EXACT,
      "audit:read",
      "agent:converse",
      "office:read",
      "chat:members",
      "agent:manage",
      "room:manage",
      "editor:use",
      "file:upload",
      "cron:read",
      "cron:manage",
      "user:create",
      "user:prompt",
      "integration:manage",
      "office:settings",
    ],
  ],
  [
    // A run has no room, no chat and no history: self-affordances, cron
    // messaging, and the office-global task board its prompt hands it.
    "RUN",
    RUN_CAPABILITIES,
    ["self:affordance", "agent:send-as-cron", "task:read", "task:write"],
  ],
  [
    // The narrowest set: the app-self message route and the app pager routes.
    // An app manages nothing, INCLUDING itself.
    "APP",
    APP_CAPABILITIES,
    ["app:message", "pager:raise"],
  ],
  [
    // A human is not an agent or a cron run and has no own-chat; only a user
    // can clear stage 1 of agents.setPrivileged (agent:privilege).
    "USER",
    USER_CAPABILITIES,
    [
      "audit:read",
      "office:read",
      "chat:members",
      "agent:manage",
      "agent:converse",
      "agent:privilege",
      "room:manage",
      "view:manage",
      "user:self",
      "user:env",
      "integration:manage",
      "user:admin",
      "office:admin",
      "office:settings",
      "invite:manage",
      "secret:show",
      "session:manage",
      "cron:read",
      "cron:manage",
      "editor:use",
      "file:upload",
      "terminal:use",
      "task:read",
      "task:write",
      "memory:read",
      "memory:write",
      "log:read",
      "app:read",
      "app:write",
      "pager:read",
      "pager:write",
      "webhook:read",
      "webhook:write",
      "voice:use",
    ],
  ],
  [
    // The explicit remote-member operational capabilities.
    "API",
    API_CAPABILITIES,
    [
      "audit:read",
      "user:env",
      "integration:manage",
      "office:settings",
      "user:prompt",
      "secret:show",
      "api:discover-agents",
      "api:send-message",
      "api:drain-inbox",
      "office:read",
      "chat:members",
      "agent:manage",
      "agent:converse",
      "room:manage",
      "editor:use",
      "file:upload",
      "cron:read",
      "cron:manage",
      "user:create",
      "task:read",
      "task:write",
      "memory:read",
      "memory:write",
      "log:read",
      "app:read",
      "app:write",
      "pager:read",
      "pager:write",
      "webhook:read",
      "webhook:write",
      "voice:use",
    ],
  ],
];

describe("identity: capability sets", () => {
  for (const [label, actual, expected] of EXACT_SETS) {
    it(`${label} scope holds exactly its capabilities`, () => {
      // toStrictEqual on sorted copies: order is free, duplicates are not.
      expect([...actual].sort()).toStrictEqual([...expected].sort());
    });
  }
});

describe("identity: readBearerToken (Phase 2.1)", () => {
  it("parses Authorization: Bearer <token> case-insensitively and trims", () => {
    expect(readBearerToken(req({ Authorization: "Bearer abc123" }))).toBe(
      "abc123",
    );
    expect(readBearerToken(req({ Authorization: "bearer   abc123  " }))).toBe(
      "abc123",
    );
    expect(readBearerToken(req({ authorization: "BEARER tok" }))).toBe("tok");
  });

  it("returns null for missing / empty / non-bearer / scheme-only headers", () => {
    expect(readBearerToken(req({}))).toBeNull();
    expect(readBearerToken(req({ Authorization: "" }))).toBeNull();
    expect(readBearerToken(req({ Authorization: "Basic xyz" }))).toBeNull();
    expect(readBearerToken(req({ Authorization: "Bearer" }))).toBeNull();
    expect(readBearerToken(req({ Authorization: "Bearer    " }))).toBeNull();
  });
});

describe("identity: agent tokens", () => {
  it("two agents get distinct tokens that resolve to their own ids", () => {
    const a = mintAgentToken("agent-a", "user-1");
    const b = mintAgentToken("agent-b", "user-2");
    expect(a).not.toBe(b);
    expect(resolveToken(a)?.agentId).toBe("agent-a");
    expect(resolveToken(b)?.agentId).toBe("agent-b");
    // revoking one leaves the other intact
    revokeAgentToken("agent-a");
    expect(resolveToken(a)).toBeNull();
    expect(resolveToken(b)?.agentId).toBe("agent-b");
  });
});

describe("identity: privileged agent tokens (task 98d63ef7)", () => {
  it("a privileged-minted token resolves to an AGENT identity with the PRIVILEGED set (scope STILL agent)", () => {
    const raw = mintAgentToken("agent-p", "user-1", true);
    const id = resolveToken(raw)!;
    expect(id.scope).toBe("agent"); // privilege never changes scope (no impersonation)
    expect(id.agentId).toBe("agent-p");
    expect([...id.capabilities].sort()).toEqual(
      [...PRIVILEGED_AGENT_CAPABILITIES].sort(),
    );
    // Operator caps present; the toggle cap + escalation caps absent.
    expect(identityHasCapability(id, "agent:manage")).toBe(true);
    expect(identityHasCapability(id, "cron:manage")).toBe(true);
    expect(identityHasCapability(id, "agent:privilege")).toBe(false);
    expect(identityHasCapability(id, "invite:manage")).toBe(false);
    expect(identityHasCapability(id, "session:manage")).toBe(false);
  });

  it("the default (and explicit false) mint is the narrow AGENT set", () => {
    const a = resolveToken(mintAgentToken("agent-a", "user-1"))!; // default
    const b = resolveToken(mintAgentToken("agent-b", "user-1", false))!;
    expect(a.scope).toBe("agent");
    expect(a.userId).toBe("user-1");
    expect(a.role).toBe("member"); // inert filler for non-user scope
    expect([...a.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
    expect([...b.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
  });
});

describe("identity: redactTokens (Phase 2.1)", () => {
  it("replaces any active raw token embedded in text; leaves token-free text untouched", () => {
    const raw = mintAgentToken("agent-1", "user-1");
    const dirty = `prefix ${raw} suffix`;
    const clean = redactTokens(dirty);
    expect(clean).not.toContain(raw);
    expect(clean).toContain("prefix ");
    expect(clean).toContain(" suffix");
    expect(redactTokens("nothing secret here")).toBe("nothing secret here");
  });
});
