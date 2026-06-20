// Phase 2.2 — Guard catalog contract tests (TDD red→green for NEW code).
//
// Asserts the contract from internal-docs/generic-runtime-refactor.md →
// "Guard catalog" table, "Identities and capabilities", and Conventions →
// two-stage authz + error envelope. These are PURE T0 unit tests: no server,
// no FS, no LLM. The guards are exercised DIRECTLY (they are not wired into the
// live dispatchCommand switch or any HTTP handler in 2.2 — additive only).
//
// Three contract themes, each tested explicitly:
//   1. Spec mapping: each guard allows/denies per its catalog row.
//   2. Impossibility-by-construction (the Reviewer4 posture): a non-user
//      identity can NEVER be authorized via role, and a USER/RUN can never
//      satisfy an AGENT-keyed guard, etc. — proven even when a matching userId
//      or a forced role would naively pass, because every owner/self/cron-owner
//      guard is scope-gated.
//   3. Non-leak (Conventions → error envelope): a hidden resource and a missing
//      one deny with the IDENTICAL {status, code}; the guard never reveals which.
//
// INVENTORY NOTE (surfaced during 2.2 scoping; changes nothing here):
//   - 1:1 strangle targets the Phase-3 strangler will replace with these guards:
//     the reorder_rooms `sessionHasFullRoomAccess` gate, the officeOwner/
//     selfOrOwner user-edit checks, and the allowedRooms field-gate in
//     server/index.ts dispatchCommand.
//   - cron mutate/run/delete/prompt currently have NO authz (any authenticated
//     session). cronjobOwnerOrOfficeOwner + cron.setPrompt→officeOwner are
//     deliberate Phase-3 TIGHTENINGS, already captured as [behavior-change] rows
//     in the spec (and Follow-up 6 for the unreachable "Room not found"); no new
//     doc follow-up is needed.

import { describe, it, expect } from "bun:test";
import {
  publicGuard,
  authenticated,
  officeOwner,
  selfUser,
  selfOrOwner,
  agentParamMustEqualTokenAgent,
  senderMustEqualTokenAgent,
  runParamMustEqualTokenRun,
  requiresRoomAccess,
  cronjobOwnerOrOfficeOwner,
  messageSend,
  type GuardDeps,
  type GuardContext,
} from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";

// --- Fixtures ---------------------------------------------------------------

const userOwner: Identity = {
  scope: "user",
  userId: "u-owner",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};
const userMember: Identity = {
  scope: "user",
  userId: "u-mem",
  role: "member",
  capabilities: USER_CAPABILITIES,
};
const agent: Identity = {
  scope: "agent",
  userId: "u-spawn",
  agentId: "a-1",
  role: "member",
  capabilities: AGENT_CAPABILITIES,
};
const run: Identity = {
  scope: "cron-run",
  userId: "u-cron",
  cronjobId: "job-1",
  runId: "run-1",
  role: "member",
  capabilities: RUN_CAPABILITIES,
};

const OK = { ok: true } as const;
const DENY = { ok: false, status: 403, code: "forbidden" } as const;

function makeDeps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    hasRoomAccess: () => false,
    roomIdForAgent: () => null,
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => null,
    ...over,
  };
}

function ctx(
  identity: Identity,
  params: Record<string, string | undefined> = {},
  body: unknown = undefined,
  deps: GuardDeps = makeDeps(),
): GuardContext {
  return { identity, params, body, deps };
}

// --- public / authenticated -------------------------------------------------

describe("guard: public", () => {
  it("always allows (it is the declared marker for the pre-authn surface)", () => {
    expect(publicGuard(ctx(userMember))).toEqual(OK);
    expect(publicGuard(ctx(agent))).toEqual(OK);
  });
});

describe("guard: authenticated", () => {
  it("allows any resolved identity (the 401 is the dispatcher's null check)", () => {
    expect(authenticated(ctx(userOwner))).toEqual(OK);
    expect(authenticated(ctx(agent))).toEqual(OK);
    expect(authenticated(ctx(run))).toEqual(OK);
  });
});

// --- officeOwner ------------------------------------------------------------

describe("guard: officeOwner", () => {
  it("allows a USER owner", () => {
    expect(officeOwner(ctx(userOwner))).toEqual(OK);
  });
  it("denies a USER member", () => {
    expect(officeOwner(ctx(userMember))).toEqual(DENY);
  });
  it("denies AGENT and CRON-RUN (role is inert filler for non-user scope)", () => {
    expect(officeOwner(ctx(agent))).toEqual(DENY);
    expect(officeOwner(ctx(run))).toEqual(DENY);
  });
  it("scope-gate: a non-user identity with role forced to 'owner' is STILL denied", () => {
    // Impossibility-by-construction: authz never keys on role for non-user scope.
    const ownerRoleAgent: Identity = { ...agent, role: "owner" };
    const ownerRoleRun: Identity = { ...run, role: "owner" };
    expect(officeOwner(ctx(ownerRoleAgent))).toEqual(DENY);
    expect(officeOwner(ctx(ownerRoleRun))).toEqual(DENY);
  });
});

// --- selfUser ---------------------------------------------------------------

describe("guard: selfUser", () => {
  const deps = makeDeps({
    userIdForUsername: (u) => (u === "self" ? "u-mem" : "u-other"),
  });
  it("allows when :username resolves to the caller's own userId", () => {
    expect(
      selfUser(ctx(userMember, { username: "self" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("denies when :username resolves to a different userId", () => {
    expect(
      selfUser(ctx(userMember, { username: "bob" }, undefined, deps)),
    ).toEqual(DENY);
  });
  it("denies on a missing :username param or an unknown username", () => {
    expect(selfUser(ctx(userMember, {}, undefined, deps))).toEqual(DENY);
    const unknownDeps = makeDeps({ userIdForUsername: () => null });
    expect(
      selfUser(ctx(userMember, { username: "ghost" }, undefined, unknownDeps)),
    ).toEqual(DENY);
  });
  it("scope-gate: an AGENT whose userId equals the target is STILL denied", () => {
    // The agent carries its spawning user's userId; selfUser must not let it
    // impersonate that user. scope!=="user" => deny regardless of userId match.
    const agentMatchesTarget = makeDeps({ userIdForUsername: () => "u-spawn" });
    expect(
      selfUser(
        ctx(agent, { username: "spawnuser" }, undefined, agentMatchesTarget),
      ),
    ).toEqual(DENY);
  });
  it("scope-gate: a CRON-RUN identity is denied even if its userId matches the target", () => {
    const runMatchesTarget = makeDeps({ userIdForUsername: () => "u-cron" });
    expect(
      selfUser(ctx(run, { username: "cronuser" }, undefined, runMatchesTarget)),
    ).toEqual(DENY);
  });
});

// --- selfOrOwner ------------------------------------------------------------

describe("guard: selfOrOwner", () => {
  const deps = makeDeps({
    userIdForUsername: (u) => (u === "mine" ? "u-mem" : "u-x"),
  });
  it("allows an office owner editing anyone", () => {
    expect(
      selfOrOwner(ctx(userOwner, { username: "anyone" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("allows a member editing their own record", () => {
    expect(
      selfOrOwner(ctx(userMember, { username: "mine" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("denies a member editing someone else", () => {
    expect(
      selfOrOwner(ctx(userMember, { username: "other" }, undefined, deps)),
    ).toEqual(DENY);
  });
  it("scope-gate: an AGENT cannot pass via owner OR self branch", () => {
    const agentMatches = makeDeps({ userIdForUsername: () => "u-spawn" });
    expect(
      selfOrOwner(
        ctx(agent, { username: "spawnuser" }, undefined, agentMatches),
      ),
    ).toEqual(DENY);
  });
  it("scope-gate: a CRON-RUN identity cannot pass via owner OR self branch", () => {
    const runMatches = makeDeps({ userIdForUsername: () => "u-cron" });
    expect(
      selfOrOwner(ctx(run, { username: "cronuser" }, undefined, runMatches)),
    ).toEqual(DENY);
  });
});

// --- agentParamMustEqualTokenAgent ------------------------------------------

describe("guard: agentParamMustEqualTokenAgent", () => {
  it("allows an AGENT whose :id equals its token agentId", () => {
    expect(agentParamMustEqualTokenAgent(ctx(agent, { id: "a-1" }))).toEqual(
      OK,
    );
  });
  it("denies an AGENT acting on another agent's :id", () => {
    expect(agentParamMustEqualTokenAgent(ctx(agent, { id: "a-2" }))).toEqual(
      DENY,
    );
  });
  it("denies on a missing :id", () => {
    expect(agentParamMustEqualTokenAgent(ctx(agent, {}))).toEqual(DENY);
  });
  it("impossible-by-construction: USER and CRON-RUN have no agentId => always denied", () => {
    expect(
      agentParamMustEqualTokenAgent(ctx(userOwner, { id: "a-1" })),
    ).toEqual(DENY);
    expect(agentParamMustEqualTokenAgent(ctx(run, { id: "a-1" }))).toEqual(
      DENY,
    );
  });
  it("hardening: a fabricated agent with a blank agentId cannot match a blank :id", () => {
    const blankAgent: Identity = { ...agent, agentId: "" };
    expect(agentParamMustEqualTokenAgent(ctx(blankAgent, { id: "" }))).toEqual(
      DENY,
    );
  });
});

// --- senderMustEqualTokenAgent ----------------------------------------------

describe("guard: senderMustEqualTokenAgent", () => {
  it("allows an AGENT with no body / no senderAgentId (sender authority is the token)", () => {
    expect(senderMustEqualTokenAgent(ctx(agent))).toEqual(OK);
    expect(senderMustEqualTokenAgent(ctx(agent, {}, {}))).toEqual(OK);
    expect(senderMustEqualTokenAgent(ctx(agent, {}, { text: "hi" }))).toEqual(
      OK,
    );
  });
  it("allows when the legacy senderAgentId matches the token agentId", () => {
    expect(
      senderMustEqualTokenAgent(ctx(agent, {}, { senderAgentId: "a-1" })),
    ).toEqual(OK);
  });
  it("denies when the legacy senderAgentId is present and mismatched", () => {
    expect(
      senderMustEqualTokenAgent(ctx(agent, {}, { senderAgentId: "a-2" })),
    ).toEqual(DENY);
  });
  it("impossible-by-construction: USER and CRON-RUN can never satisfy it", () => {
    expect(
      senderMustEqualTokenAgent(ctx(userOwner, {}, { senderAgentId: "a-1" })),
    ).toEqual(DENY);
    expect(senderMustEqualTokenAgent(ctx(run, {}, {}))).toEqual(DENY);
  });
  it("hardening: a fabricated agent with a blank agentId is not a valid sender", () => {
    const blankAgent: Identity = { ...agent, agentId: "" };
    expect(senderMustEqualTokenAgent(ctx(blankAgent))).toEqual(DENY);
    expect(
      senderMustEqualTokenAgent(ctx(blankAgent, {}, { senderAgentId: "" })),
    ).toEqual(DENY);
  });
});

// --- runParamMustEqualTokenRun ----------------------------------------------

describe("guard: runParamMustEqualTokenRun", () => {
  it("allows a RUN whose {:id,:runId} equal the token {cronjobId,runId}", () => {
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-1", runId: "run-1" })),
    ).toEqual(OK);
  });
  it("denies a RUN with a mismatched cronjob or run", () => {
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-2", runId: "run-1" })),
    ).toEqual(DENY);
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-1", runId: "run-9" })),
    ).toEqual(DENY);
  });
  it("impossible-by-construction: USER and AGENT have no run binding => denied", () => {
    expect(
      runParamMustEqualTokenRun(
        ctx(userOwner, { id: "job-1", runId: "run-1" }),
      ),
    ).toEqual(DENY);
    expect(
      runParamMustEqualTokenRun(ctx(agent, { id: "job-1", runId: "run-1" })),
    ).toEqual(DENY);
  });
  it("hardening: a fabricated run with blank ids cannot match blank params", () => {
    const blankRun: Identity = { ...run, cronjobId: "", runId: "" };
    expect(
      runParamMustEqualTokenRun(ctx(blankRun, { id: "", runId: "" })),
    ).toEqual(DENY);
  });
});

// --- requiresRoomAccess -----------------------------------------------------

describe("guard: requiresRoomAccess (paramRoomId)", () => {
  const guard = requiresRoomAccess({ kind: "paramRoomId", name: "roomId" });
  it("allows when the caller has access to the room param", () => {
    const deps = makeDeps({ hasRoomAccess: (_id, r) => r === "r-1" });
    expect(guard(ctx(userMember, { roomId: "r-1" }, undefined, deps))).toEqual(
      OK,
    );
  });
  it("denies an inaccessible room, a missing param, and a blank param identically", () => {
    const deps = makeDeps({ hasRoomAccess: () => false });
    const allow = makeDeps({ hasRoomAccess: () => true });
    expect(guard(ctx(userMember, { roomId: "r-1" }, undefined, deps))).toEqual(
      DENY,
    );
    expect(guard(ctx(userMember, {}, undefined, deps))).toEqual(DENY);
    // A blank param never reaches deps (would-allow deps still denies).
    expect(guard(ctx(userMember, { roomId: "" }, undefined, allow))).toEqual(
      DENY,
    );
  });
});

describe("guard: requiresRoomAccess (paramAgentId, agent→room)", () => {
  const guard = requiresRoomAccess({ kind: "paramAgentId", name: "id" });
  it("allows when the agent's room is accessible", () => {
    const deps = makeDeps({
      roomIdForAgent: () => "r-7",
      hasRoomAccess: (_i, r) => r === "r-7",
    });
    expect(guard(ctx(userMember, { id: "a-9" }, undefined, deps))).toEqual(OK);
  });
  it("NON-LEAK: unknown agent and accessible-but-hidden room deny IDENTICALLY", () => {
    const hidden = guard(
      ctx(
        userMember,
        { id: "a-9" },
        undefined,
        makeDeps({
          roomIdForAgent: () => "r-hidden",
          hasRoomAccess: () => false,
        }),
      ),
    );
    const missing = guard(
      ctx(
        userMember,
        { id: "a-9" },
        undefined,
        makeDeps({ roomIdForAgent: () => null }),
      ),
    );
    const missingParam = guard(ctx(userMember, {}, undefined, makeDeps()));
    // A blank :id never reaches deps, yet denies identically (no leak).
    const blankParam = guard(
      ctx(
        userMember,
        { id: "" },
        undefined,
        makeDeps({ roomIdForAgent: () => "r-x", hasRoomAccess: () => true }),
      ),
    );
    expect(hidden).toEqual(DENY);
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual(missingParam);
    expect(hidden).toEqual(blankParam);
  });
});

describe("guard: requiresRoomAccess (bodyRoomId)", () => {
  const guard = requiresRoomAccess({ kind: "bodyRoomId", name: "roomId" });
  it("allows when body.roomId is accessible", () => {
    const deps = makeDeps({ hasRoomAccess: (_i, r) => r === "r-2" });
    expect(guard(ctx(userMember, {}, { roomId: "r-2" }, deps))).toEqual(OK);
  });
  it("denies a wrong body shape (null / non-object / missing field) without leaking", () => {
    const deps = makeDeps({ hasRoomAccess: () => true });
    expect(guard(ctx(userMember, {}, null, deps))).toEqual(DENY);
    expect(guard(ctx(userMember, {}, "nope", deps))).toEqual(DENY);
    expect(guard(ctx(userMember, {}, {}, deps))).toEqual(DENY);
  });
});

// --- cronjobOwnerOrOfficeOwner ----------------------------------------------

describe("guard: cronjobOwnerOrOfficeOwner", () => {
  const guard = cronjobOwnerOrOfficeOwner("id");
  it("allows an office owner regardless of creator", () => {
    const deps = makeDeps({ cronjobCreatorUserId: () => "someone-else" });
    expect(guard(ctx(userOwner, { id: "job-1" }, undefined, deps))).toEqual(OK);
  });
  it("allows the creating USER (member)", () => {
    const deps = makeDeps({ cronjobCreatorUserId: () => "u-mem" });
    expect(guard(ctx(userMember, { id: "job-1" }, undefined, deps))).toEqual(
      OK,
    );
  });
  it("denies a non-creator member, and an unknown/unowned cronjob", () => {
    expect(
      guard(
        ctx(
          userMember,
          { id: "job-1" },
          undefined,
          makeDeps({ cronjobCreatorUserId: () => "u-x" }),
        ),
      ),
    ).toEqual(DENY);
    expect(
      guard(
        ctx(
          userMember,
          { id: "job-1" },
          undefined,
          makeDeps({ cronjobCreatorUserId: () => null }),
        ),
      ),
    ).toEqual(DENY);
    expect(guard(ctx(userMember, {}, undefined, makeDeps()))).toEqual(DENY);
  });
  it("scope-gate / no confused deputy: an AGENT whose userId equals the creator is STILL denied", () => {
    const deps = makeDeps({ cronjobCreatorUserId: () => "u-spawn" });
    expect(guard(ctx(agent, { id: "job-1" }, undefined, deps))).toEqual(DENY);
    expect(guard(ctx(run, { id: "job-1" }, undefined, deps))).toEqual(DENY);
  });
});

// --- messageSend (composite, caller-authz only) -----------------------------

describe("guard: messageSend", () => {
  it("USER: delegates to requiresRoomAccess(:id-as-agent)", () => {
    const accessible = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(
      messageSend(ctx(userMember, { id: "a-recip" }, undefined, accessible)),
    ).toEqual(OK);
  });
  it("USER: absent recipient and hidden recipient collapse to the same deny", () => {
    const hidden = messageSend(
      ctx(
        userMember,
        { id: "a-recip" },
        undefined,
        makeDeps({ roomIdForAgent: () => "r-h", hasRoomAccess: () => false }),
      ),
    );
    const absent = messageSend(
      ctx(
        userMember,
        { id: "a-recip" },
        undefined,
        makeDeps({ roomIdForAgent: () => null }),
      ),
    );
    expect(hidden).toEqual(DENY);
    expect(hidden).toEqual(absent);
  });
  it("AGENT: sender-bound, cross-room delivery allowed (NO room-access check)", () => {
    // hasRoomAccess is false for everything; an agent sender must STILL pass,
    // proving messageSend applies no room check to an agent.
    const noAccess = makeDeps({
      hasRoomAccess: () => false,
      roomIdForAgent: () => "r-any",
    });
    expect(
      messageSend(ctx(agent, { id: "a-recip" }, { text: "hi" }, noAccess)),
    ).toEqual(OK);
  });
  it("AGENT: a mismatched legacy senderAgentId is rejected", () => {
    expect(
      messageSend(ctx(agent, { id: "a-recip" }, { senderAgentId: "a-2" })),
    ).toEqual(DENY);
  });
  it("CRON-RUN: denied (a run has no chat to send into)", () => {
    expect(messageSend(ctx(run, { id: "a-recip" }, { text: "hi" }))).toEqual(
      DENY,
    );
  });
});
