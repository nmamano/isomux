// Phase 2.1 - Identity & capabilities: the token store + capability sets.
//
// TDD red-green for NEW code (not characterization). Asserts the contract from
// the API spec (generic-runtime-refactor.md → "Identities and capabilities"):
// three capability scopes, an in-memory token store that mints/rotates/revokes
// and resolves a raw bearer to an Identity, and the stateless auth helpers
// (readBearerToken, identityFromSession). Zero LLM, no server, no FS.
//
// ADDITIVE phase: these assert tokens are issued/resolved/rotated/revoked. They
// do NOT assert anything is rejected at the transport layer (that is Phase 3 /
// loopback-bypass removal). Redaction of the raw across real exposure surfaces
// is covered separately by the lifecycle/redaction harness test.

import { describe, it, expect, afterEach } from "bun:test";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  agentCapabilities,
  capabilitiesForScope,
  identityHasCapability,
  identityFromSession,
  readBearerToken,
  type Capability,
} from "../identity/index.ts";
import {
  mintAgentToken,
  getAgentTokenRaw,
  revokeAgentToken,
  mintRunToken,
  getRunTokenRaw,
  revokeRunToken,
  resolveToken,
  redactTokens,
  _testResetTokens,
} from "../identity/tokens.ts";

afterEach(() => _testResetTokens());

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { headers });
}

describe("identity: capability sets (Phase 2.1)", () => {
  it("AGENT scope holds exactly the agent-identity + shared task/memory capabilities", () => {
    expect([...AGENT_CAPABILITIES].sort()).toEqual(
      (
        [
          "agent:send-as-self",
          "self:affordance",
          "task:read",
          "task:write",
          "memory:read",
          "memory:write",
          // Conversation-log reads (GET /api/agents/:id/logs). Its own
          // capability rather than office:read, which an agent token does not
          // carry - see the Capability union.
          "log:read",
        ] as Capability[]
      ).sort(),
    );
  });

  it("RUN scope holds the self-affordances plus the task board", () => {
    // task:read/task:write are here because the cron system prompt hands a run
    // the office-global board; it reached it over the retired loopback /tasks
    // route before. Nothing else: a run cannot spawn, converse, or read cron -
    // and NOT log:read either: a run has no room, no chat, and no history.
    expect([...RUN_CAPABILITIES]).toEqual([
      "self:affordance",
      "task:read",
      "task:write",
    ]);
  });

  it("USER (browser) scope holds the management caps but NOT the agent-identity caps", () => {
    // Spot-check representative management capabilities are present...
    for (const c of [
      "office:read",
      "agent:manage",
      "agent:converse",
      "room:manage",
      "office:admin",
      "user:admin",
      "task:write",
      "editor:use",
      "terminal:use",
    ] as Capability[]) {
      expect(USER_CAPABILITIES).toContain(c);
    }
    // ...and the two agent-identity caps are deliberately absent (a human is
    // not an agent and has no own-chat).
    expect(USER_CAPABILITIES).not.toContain("agent:send-as-self" as Capability);
    expect(USER_CAPABILITIES).not.toContain("self:affordance" as Capability);
  });

  it("PRIVILEGED agent set = AGENT base + the curated operator caps, and EXCLUDES the escalation caps", () => {
    // The whole baseline AGENT set is included...
    for (const c of AGENT_CAPABILITIES) {
      expect(PRIVILEGED_AGENT_CAPABILITIES).toContain(c);
    }
    // ...plus exactly the curated operator delta (drive other agents' sessions
    // + full cron over own jobs). Nil-locked set (task 98d63ef7).
    for (const c of [
      "agent:converse",
      "office:read",
      "agent:manage",
      "room:manage",
      "editor:use",
      "file:upload",
      "cron:read",
      "cron:manage",
    ] as Capability[]) {
      expect(PRIVILEGED_AGENT_CAPABILITIES).toContain(c);
    }
    // The escalation / owner-admin caps are DELIBERATELY absent - this is the
    // crux of the audit. invites.* (durable login mint), sessions.* (kill the
    // human's browser session), user/office administration, view prefs, and the
    // privilege-toggle cap itself must never reach a privileged agent. (room:manage
    // was added by Nil-approved expansion - it is now INCLUDED above.)
    for (const c of [
      "invite:manage",
      "session:manage",
      "user:self",
      "user:admin",
      "office:admin",
      "view:manage",
      "terminal:use",
      "agent:privilege",
    ] as Capability[]) {
      expect(PRIVILEGED_AGENT_CAPABILITIES).not.toContain(c);
    }
  });

  it("agent:privilege is held by USER scope only - not AGENT, not the privileged set", () => {
    // The stage-1 half of the agents.setPrivileged double-gate: only a user can
    // even clear stage 1, so no agent (privileged or not) can flip the flag.
    expect(USER_CAPABILITIES).toContain("agent:privilege" as Capability);
    expect(AGENT_CAPABILITIES).not.toContain("agent:privilege" as Capability);
    expect(PRIVILEGED_AGENT_CAPABILITIES).not.toContain(
      "agent:privilege" as Capability,
    );
  });

  it("agentCapabilities maps the privileged flag to the set", () => {
    expect(agentCapabilities(false)).toBe(AGENT_CAPABILITIES);
    expect(agentCapabilities(true)).toBe(PRIVILEGED_AGENT_CAPABILITIES);
  });

  it("capabilitiesForScope maps scope -> set", () => {
    expect(capabilitiesForScope("user")).toBe(USER_CAPABILITIES);
    expect(capabilitiesForScope("agent")).toBe(AGENT_CAPABILITIES);
    expect(capabilitiesForScope("cron-run")).toBe(RUN_CAPABILITIES);
  });

  it("identityHasCapability checks membership", () => {
    const agent = resolveToken(mintAgentToken("agent-x", "user-1"))!;
    expect(identityHasCapability(agent, "self:affordance")).toBe(true);
    expect(identityHasCapability(agent, "agent:manage")).toBe(false);
  });
});

describe("identity: identityFromSession (cookie -> user identity) (Phase 2.1)", () => {
  it("maps a session lookup to a USER-scope identity with the browser set", () => {
    const id = identityFromSession({ userId: "user-7", role: "owner" });
    expect(id.scope).toBe("user");
    expect(id.userId).toBe("user-7");
    expect(id.role).toBe("owner");
    expect(id.capabilities).toBe(USER_CAPABILITIES);
    expect(id.agentId).toBeUndefined();
  });
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

describe("identity: agent token mint/resolve/rotate/revoke (Phase 2.1)", () => {
  it("mints a raw, resolves it to an AGENT identity, and stores hash-only retrievably", () => {
    const raw = mintAgentToken("agent-1", "user-1");
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(20);
    expect(getAgentTokenRaw("agent-1")).toBe(raw);

    const id = resolveToken(raw)!;
    expect(id.scope).toBe("agent");
    expect(id.agentId).toBe("agent-1");
    expect(id.userId).toBe("user-1");
    expect(id.role).toBe("member"); // inert filler for non-user scope
    expect([...id.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
  });

  it("resolveToken returns null for garbage / empty input", () => {
    mintAgentToken("agent-1", "user-1");
    expect(resolveToken("not-a-real-token")).toBeNull();
    expect(resolveToken("")).toBeNull();
  });

  it("rotation: re-minting the same agent invalidates the old raw and issues a new one", () => {
    const first = mintAgentToken("agent-1", "user-1");
    const second = mintAgentToken("agent-1", "user-1");
    expect(second).not.toBe(first);
    expect(resolveToken(first)).toBeNull(); // old raw dead
    expect(resolveToken(second)?.agentId).toBe("agent-1");
    expect(getAgentTokenRaw("agent-1")).toBe(second);
  });

  it("revoke: a revoked agent token no longer resolves and has no raw", () => {
    const raw = mintAgentToken("agent-1", "user-1");
    revokeAgentToken("agent-1");
    expect(resolveToken(raw)).toBeNull();
    expect(getAgentTokenRaw("agent-1")).toBeNull();
  });

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
    expect([...a.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
    expect([...b.capabilities].sort()).toEqual([...AGENT_CAPABILITIES].sort());
  });

  it("toggling GRANT re-mints: old token dead, new one carries the privileged set", () => {
    const before = mintAgentToken("agent-x", "user-1", false);
    expect([...resolveToken(before)!.capabilities].sort()).toEqual(
      [...AGENT_CAPABILITIES].sort(),
    );
    const after = mintAgentToken("agent-x", "user-1", true); // re-mint = toggle
    expect(after).not.toBe(before);
    expect(resolveToken(before)).toBeNull(); // old token revoked by rotation
    expect([...resolveToken(after)!.capabilities].sort()).toEqual(
      [...PRIVILEGED_AGENT_CAPABILITIES].sort(),
    );
  });

  it("toggling REVOKE re-mints back down to the narrow set; old privileged token dead", () => {
    const priv = mintAgentToken("agent-x", "user-1", true);
    expect(identityHasCapability(resolveToken(priv)!, "agent:manage")).toBe(
      true,
    );
    const narrowed = mintAgentToken("agent-x", "user-1", false);
    expect(resolveToken(priv)).toBeNull(); // privileged token no longer resolves
    expect([...resolveToken(narrowed)!.capabilities].sort()).toEqual(
      [...AGENT_CAPABILITIES].sort(),
    );
  });
});

describe("identity: cron-run token mint/resolve/revoke (Phase 2.1)", () => {
  it("mints a RUN token bound to {cronjobId, runId} with the RUN capability set", () => {
    const raw = mintRunToken("job-1", "run-1", "user-9");
    expect(getRunTokenRaw("job-1", "run-1")).toBe(raw);
    const id = resolveToken(raw)!;
    expect(id.scope).toBe("cron-run");
    expect(id.cronjobId).toBe("job-1");
    expect(id.runId).toBe("run-1");
    expect(id.userId).toBe("user-9");
    expect([...id.capabilities]).toEqual([
      "self:affordance",
      "task:read",
      "task:write",
    ]);
    expect(id.agentId).toBeUndefined();
  });

  it("revoke ends the run token", () => {
    const raw = mintRunToken("job-1", "run-1", "user-9");
    revokeRunToken("job-1", "run-1");
    expect(resolveToken(raw)).toBeNull();
    expect(getRunTokenRaw("job-1", "run-1")).toBeNull();
  });

  it("agent and run tokens coexist and resolve to their own scopes", () => {
    const a = mintAgentToken("agent-1", "user-1");
    const r = mintRunToken("job-1", "run-1", "user-1");
    expect(resolveToken(a)?.scope).toBe("agent");
    expect(resolveToken(r)?.scope).toBe("cron-run");
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

  it("a revoked token is no longer redacted (no longer a live secret to scrub)", () => {
    const raw = mintAgentToken("agent-1", "user-1");
    revokeAgentToken("agent-1");
    // Not a live secret anymore; redactTokens only scrubs active tokens.
    expect(redactTokens(`x ${raw} y`)).toContain(raw);
  });
});
