// Phase 2.2 - Guard catalog contract tests (TDD red→green for NEW code).
//
// Asserts the contract from internal-docs/generic-runtime-refactor.md →
// "Guard catalog" table, "Identities and capabilities", and Conventions →
// two-stage authz + error envelope. These are PURE T0 unit tests: no server,
// no FS, no LLM. The guards are exercised DIRECTLY (they are not wired into the
// live dispatchCommand switch or any HTTP handler in 2.2 - additive only).
//
// Three contract themes, each tested explicitly:
//   1. Spec mapping: each guard allows/denies per its catalog row.
//   2. Impossibility-by-construction (the Reviewer4 posture): a non-user
//      identity can NEVER be authorized via role, and a USER/RUN can never
//      satisfy an AGENT-keyed guard, etc. - proven even when a matching userId
//      or a forced role would naively pass, because every owner/self/cron-owner
//      guard is scope-gated.
//   3. Non-leak (Conventions → error envelope): a hidden resource and a missing
//      one deny with the IDENTICAL {status, code}; the guard never reveals which.
//
// INVENTORY NOTE (surfaced during 2.2 scoping; changes nothing here):
//   - 1:1 strangle targets the Phase-3 strangler will replace with these guards:
//     the reorder_rooms `sessionHasFullRoomAccess` gate, the officeOwner/
//     selfOrOwner user-edit checks, and the allowedRooms field-gate in
//     server/isomux-office.ts dispatchCommand.
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
  userScope,
  selfUser,
  selfOrOwner,
  agentParamMustEqualTokenAgent,
  agentManagerMatch,
  senderMustEqualTokenAgent,
  runParamMustEqualTokenRun,
  requiresRoomAccess,
  cronjobOwnerOrOfficeOwner,
  appOwnerOrOfficeOwner,
  appScope,
  hasOwningUser,
  messageSend,
  scheduledMessagesOwner,
  conversationReset,
  logSearchAccess,
  killedAgentLogAccess,
  taskDelete,
  and,
  or,
  type GuardDeps,
  type GuardContext,
} from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  APP_CAPABILITIES,
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
// A privileged agent: scope STILL "agent" (no impersonation), but carrying the
// privileged operator capability set (includes cron:manage). Same spawning
// userId as `agent` so the cron owner-match fixtures line up.
const privilegedAgent: Identity = {
  scope: "agent",
  userId: "u-spawn",
  agentId: "a-1",
  role: "member",
  capabilities: PRIVILEGED_AGENT_CAPABILITIES,
};
const run: Identity = {
  scope: "cron-run",
  userId: "u-cron",
  cronjobId: "job-1",
  runId: "run-1",
  role: "member",
  capabilities: RUN_CAPABILITIES,
};
// A registered app's own server process. Its userId is its OWNER's - truthful
// attribution, deliberately the same id every owner-matching fixture below uses
// - so every denial here is proof the guard keyed on scope and not on a
// matching userId it could have inherited.
const app: Identity = {
  scope: "app",
  userId: "u-owner",
  appName: "hello",
  role: "member",
  capabilities: APP_CAPABILITIES,
};

const OK = { ok: true } as const;
const DENY = { ok: false, status: 403, code: "forbidden" } as const;

function makeDeps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    hasRoomAccess: () => false,
    roomIdForAgent: () => null,
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => null,
    appOwnerUserId: () => null,
    agentManagerUserId: () => null,
    killedAgentManagerUserId: () => null,
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
  it("allows any resolved OFFICE identity (the 401 is the dispatcher's null check)", () => {
    expect(authenticated(ctx(userOwner))).toEqual(OK);
    expect(authenticated(ctx(agent))).toEqual(OK);
    expect(authenticated(ctx(run))).toEqual(OK);
  });
  it("denies an APP - on the routes that ask only for an identity, this IS the gate", () => {
    // system.version and sessions.logout carry no capability, so an app token
    // would reach them on the strength of existing. An app opts in to a route
    // deliberately, through appScope, never by being merely authenticated.
    expect(authenticated(ctx(app))).toEqual(DENY);
  });
});

// --- appScope ---------------------------------------------------------------

describe("guard: appScope", () => {
  it("allows an APP identity carrying its name", () => {
    expect(appScope(ctx(app))).toEqual(OK);
  });
  it("denies every other scope - including the owner the app belongs to", () => {
    // The app's userId IS userOwner's id in these fixtures, so a guard that
    // owner-matched instead of scope-gating would pass here.
    expect(appScope(ctx(userOwner))).toEqual(DENY);
    expect(appScope(ctx(userMember))).toEqual(DENY);
    expect(appScope(ctx(agent))).toEqual(DENY);
    expect(appScope(ctx(privilegedAgent))).toEqual(DENY);
    expect(appScope(ctx(run))).toEqual(DENY);
  });
  it("denies an APP identity with no appName - the handler has nothing to resolve", () => {
    expect(appScope(ctx({ ...app, appName: undefined }))).toEqual(DENY);
    expect(appScope(ctx({ ...app, appName: "" }))).toEqual(DENY);
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

// --- userScope --------------------------------------------------------------

describe("guard: userScope", () => {
  it("allows any USER (owner OR member)", () => {
    expect(userScope(ctx(userOwner))).toEqual(OK);
    expect(userScope(ctx(userMember))).toEqual(OK);
  });
  it("denies AGENT and CRON-RUN - including a PRIVILEGED agent (scope stays 'agent')", () => {
    expect(userScope(ctx(agent))).toEqual(DENY);
    expect(userScope(ctx(privilegedAgent))).toEqual(DENY);
    expect(userScope(ctx(run))).toEqual(DENY);
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

// --- hasOwningUser ----------------------------------------------------------

describe("guard: hasOwningUser", () => {
  it("allows any identity that has an owning user", () => {
    expect(hasOwningUser(ctx(userOwner, {}, undefined, makeDeps()))).toEqual(
      OK,
    );
    expect(hasOwningUser(ctx(userMember, {}, undefined, makeDeps()))).toEqual(
      OK,
    );
    expect(hasOwningUser(ctx(agent, {}, undefined, makeDeps()))).toEqual(OK);
  });
  it("denies an agent token minted with a NULL userId", () => {
    // mintAgentToken's userId parameter is nullable, so this identity is real,
    // not hypothetical. An app registered by it would belong to nobody and be
    // unreachable to its own creator, so registration is refused at the door.
    const ownerless: Identity = { ...agent, userId: null };
    expect(hasOwningUser(ctx(ownerless, {}, undefined, makeDeps()))).toEqual(
      DENY,
    );
  });
});

// --- appOwnerOrOfficeOwner --------------------------------------------------
// Written as a deliberate CONTRAST to cronjobOwnerOrOfficeOwner below, because
// the two guards look alike and are not: `cron:manage` is a privileged extra,
// so a narrow agent is denied there, while `app:read` is BASELINE, so an
// ordinary agent IS allowed here on an owner match. That difference is the
// feature (an agent must manage the apps it registers for its user), and the
// owner match is what keeps it from being a confused deputy. Copying the cron
// guard without re-deriving this is exactly the mistake these cases catch.

describe("guard: appOwnerOrOfficeOwner", () => {
  const guard = appOwnerOrOfficeOwner("name");
  it("allows an office owner regardless of who owns the app", () => {
    const deps = makeDeps({ appOwnerUserId: () => "someone-else" });
    expect(guard(ctx(userOwner, { name: "hello" }, undefined, deps))).toEqual(
      OK,
    );
  });
  it("allows the owning USER (member)", () => {
    const deps = makeDeps({ appOwnerUserId: () => "u-mem" });
    expect(guard(ctx(userMember, { name: "hello" }, undefined, deps))).toEqual(
      OK,
    );
  });
  it("denies a member who does not own it", () => {
    const deps = makeDeps({ appOwnerUserId: () => "u-x" });
    expect(guard(ctx(userMember, { name: "hello" }, undefined, deps))).toEqual(
      DENY,
    );
  });
  it("denies an unknown app and an unowned one identically (no existence oracle)", () => {
    const unknown = guard(
      ctx(
        userMember,
        { name: "never-registered" },
        undefined,
        makeDeps({ appOwnerUserId: () => null }),
      ),
    );
    const notMine = guard(
      ctx(
        userMember,
        { name: "hello" },
        undefined,
        makeDeps({ appOwnerUserId: () => "u-x" }),
      ),
    );
    expect(unknown).toEqual(DENY);
    expect(unknown).toEqual(notMine);
    // A missing :name param denies too, rather than falling through.
    expect(guard(ctx(userMember, {}, undefined, makeDeps()))).toEqual(DENY);
  });
  it("allows an ORDINARY agent on an owner match - app:* is baseline, not a privilege", () => {
    const deps = makeDeps({ appOwnerUserId: () => "u-spawn" }); // == agent.userId
    expect(guard(ctx(agent, { name: "hello" }, undefined, deps))).toEqual(OK);
    expect(
      guard(ctx(privilegedAgent, { name: "hello" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("denies an agent whose MANAGER does not own the app", () => {
    const deps = makeDeps({ appOwnerUserId: () => "u-other" });
    expect(guard(ctx(agent, { name: "hello" }, undefined, deps))).toEqual(DENY);
  });
  it("denies a CRON-RUN even on a userId match (it holds no app capability)", () => {
    // run.userId is "u-cron"; make the app owned by exactly that user, so the
    // ONLY thing standing between the run and the app is the capability check.
    const deps = makeDeps({ appOwnerUserId: () => "u-cron" });
    expect(guard(ctx(run, { name: "hello" }, undefined, deps))).toEqual(DENY);
  });
  it("gives an agent NO office-owner shortcut: it only ever owner-matches", () => {
    // officeOwner requires scope==="user" + owner, so an agent spawned by the
    // office owner still reaches only the apps that owner owns - never the
    // office-wide branch.
    const ownerAgent: Identity = { ...agent, userId: "u-owner" };
    expect(
      guard(
        ctx(
          ownerAgent,
          { name: "hello" },
          undefined,
          makeDeps({ appOwnerUserId: () => "someone-else" }),
        ),
      ),
    ).toEqual(DENY);
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
  it("scope-gate / no confused deputy: a NARROW agent whose userId equals the creator is STILL denied", () => {
    // A normal agent lacks cron:manage, so it is not a privileged agent and is
    // denied even on a userId match - the confused-deputy guard the narrow token
    // exists for. (cron-run likewise.)
    const deps = makeDeps({ cronjobCreatorUserId: () => "u-spawn" });
    expect(guard(ctx(agent, { id: "job-1" }, undefined, deps))).toEqual(DENY);
    expect(guard(ctx(run, { id: "job-1" }, undefined, deps))).toEqual(DENY);
  });
  it("privileged agent owner-match: a PRIVILEGED agent whose userId created the job is ALLOWED (Nil-approved loosening)", () => {
    const deps = makeDeps({ cronjobCreatorUserId: () => "u-spawn" }); // == privilegedAgent.userId
    expect(
      guard(ctx(privilegedAgent, { id: "job-1" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("privileged agent NON-owner: a privileged agent whose userId did NOT create the job is denied", () => {
    const deps = makeDeps({ cronjobCreatorUserId: () => "someone-else" });
    expect(
      guard(ctx(privilegedAgent, { id: "job-1" }, undefined, deps)),
    ).toEqual(DENY);
  });
  it("privileged agent gets NO office-owner shortcut: it only ever own-matches, never the officeOwner branch", () => {
    // officeOwner requires scope==="user"+owner, so a privileged agent (scope
    // "agent") can never inherit office-wide cron powers - only its own jobs.
    // Force a creator mismatch: if the officeOwner branch leaked, this would OK.
    const deps = makeDeps({ cronjobCreatorUserId: () => "not-u-spawn" });
    expect(
      guard(ctx(privilegedAgent, { id: "job-1" }, undefined, deps)),
    ).toEqual(DENY);
  });
});

// --- agentManagerMatch (+ the agents.setPrivileged composition) -------------

describe("guard: agentManagerMatch", () => {
  const guard = agentManagerMatch("id");
  it("allows the user who MANAGES the agent (userId === agent's manager)", () => {
    const deps = makeDeps({ agentManagerUserId: () => "u-mem" });
    expect(guard(ctx(userMember, { id: "a-1" }, undefined, deps))).toEqual(OK);
  });
  it("denies a non-manager, an unknown/unowned agent, and a missing :id", () => {
    expect(
      guard(
        ctx(
          userMember,
          { id: "a-1" },
          undefined,
          makeDeps({ agentManagerUserId: () => "u-other" }),
        ),
      ),
    ).toEqual(DENY);
    expect(
      guard(
        ctx(
          userMember,
          { id: "a-1" },
          undefined,
          makeDeps({ agentManagerUserId: () => null }),
        ),
      ),
    ).toEqual(DENY);
    expect(
      guard(
        ctx(
          userMember,
          {},
          undefined,
          makeDeps({ agentManagerUserId: () => "u-mem" }),
        ),
      ),
    ).toEqual(DENY);
  });

  // The agents.setPrivileged composition: and(userScope, or(officeOwner, this)).
  // This pins WHY agentManagerMatch must compose under userScope - bare, it is
  // scope-agnostic and an agent with a coincidental userId match would pass.
  describe("composed as the agents.setPrivileged gate", () => {
    const composed = and(userScope, or(officeOwner, guard));
    it("an AGENT whose userId matches the manager passes the BARE match but is blocked by userScope", () => {
      const deps = makeDeps({ agentManagerUserId: () => "u-spawn" }); // == agent.userId
      expect(guard(ctx(agent, { id: "a-1" }, undefined, deps))).toEqual(OK); // bare: passes
      expect(composed(ctx(agent, { id: "a-1" }, undefined, deps))).toEqual(
        DENY,
      ); // composed: userScope blocks
      expect(
        composed(ctx(privilegedAgent, { id: "a-1" }, undefined, deps)),
      ).toEqual(DENY);
    });
    it("a member toggles only agents they manage; an owner toggles any", () => {
      const mine = makeDeps({ agentManagerUserId: () => "u-mem" });
      const theirs = makeDeps({ agentManagerUserId: () => "u-other" });
      expect(composed(ctx(userMember, { id: "a-1" }, undefined, mine))).toEqual(
        OK,
      );
      expect(
        composed(ctx(userMember, { id: "a-1" }, undefined, theirs)),
      ).toEqual(DENY); // cross-user conferral blocked
      expect(
        composed(ctx(userOwner, { id: "a-1" }, undefined, theirs)),
      ).toEqual(OK); // owner via officeOwner
    });
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

describe("guard: conversationReset", () => {
  it("USER: delegates to room access on the target agent", () => {
    const accessible = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(
      conversationReset(ctx(userMember, { id: "a-x" }, undefined, accessible)),
    ).toEqual(OK);
    const hidden = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => false,
    });
    expect(
      conversationReset(ctx(userMember, { id: "a-x" }, undefined, hidden)),
    ).toEqual(DENY);
  });
  it("PRIVILEGED AGENT: clears another agent in an accessible room (room-based)", () => {
    const accessible = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(
      conversationReset(
        ctx(privilegedAgent, { id: "a-other" }, undefined, accessible),
      ),
    ).toEqual(OK);
  });
  it("PRIVILEGED AGENT: denied when the target's room is inaccessible", () => {
    const hidden = makeDeps({
      roomIdForAgent: () => "r-h",
      hasRoomAccess: () => false,
    });
    expect(
      conversationReset(
        ctx(privilegedAgent, { id: "a-other" }, undefined, hidden),
      ),
    ).toEqual(DENY);
  });
  it("ORDINARY AGENT: may clear ITSELF (:id === token agentId)", () => {
    // hasRoomAccess deliberately true - proves the self branch does NOT depend
    // on room access, it binds to the token agentId.
    const anyRoom = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(
      conversationReset(ctx(agent, { id: "a-1" }, undefined, anyRoom)),
    ).toEqual(OK);
  });
  it("CONFUSED-DEPUTY BLOCK: ordinary agent CANNOT clear another agent even when its spawning user has room access", () => {
    // The escalation trap: hasRoomAccess keys on the spawning-user id, which is
    // true for every agent that user owns. An ordinary agent (no agent:converse)
    // must STILL be denied clearing a different agent - self-branch only.
    const roomTrue = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(
      conversationReset(ctx(agent, { id: "a-other" }, undefined, roomTrue)),
    ).toEqual(DENY);
  });
  it("CRON-RUN: denied (a run has no session to reset)", () => {
    expect(conversationReset(ctx(run, { id: "a-1" }))).toEqual(DENY);
  });
});

// --- logSearchAccess, including the KILLED-agent path (task ffb90761) --------
// The live half is the room rule; the killed half is a different rule entirely
// (the dead agent's own boss, or an office owner), so both halves are pinned in
// BOTH directions - a room-only implementation and a killed-only one each fail
// a test here.

describe("guard: logSearchAccess", () => {
  // A live agent in an accessible room: nothing is killed.
  const liveVisible = makeDeps({
    roomIdForAgent: () => "r-1",
    hasRoomAccess: () => true,
  });
  // The target is KILLED: gone from the roster (roomIdForAgent null, the same
  // answer an unknown id gets), spawned by u-mem.
  const killedByMember = makeDeps({
    roomIdForAgent: () => null,
    hasRoomAccess: () => true, // deliberately generous - the room path is dead anyway
    killedAgentManagerUserId: () => "u-mem",
  });

  it("USER: room access on a LIVE target, unchanged", () => {
    expect(
      logSearchAccess(ctx(userMember, { id: "a-x" }, undefined, liveVisible)),
    ).toEqual(OK);
    const hidden = makeDeps({
      roomIdForAgent: () => "r-h",
      hasRoomAccess: () => false,
    });
    expect(
      logSearchAccess(ctx(userMember, { id: "a-x" }, undefined, hidden)),
    ).toEqual(DENY);
  });
  it("AGENT: itself, and a target in a room its boss can reach", () => {
    const noRoom = makeDeps({ roomIdForAgent: () => null });
    expect(
      logSearchAccess(ctx(agent, { id: "a-1" }, undefined, noRoom)),
    ).toEqual(OK); // self, no room needed
    expect(
      logSearchAccess(ctx(agent, { id: "a-other" }, undefined, liveVisible)),
    ).toEqual(OK);
  });
  it("KILLED target: its own boss reads it, though the room path denies", () => {
    expect(
      logSearchAccess(
        ctx(userMember, { id: "a-dead" }, undefined, killedByMember),
      ),
    ).toEqual(OK);
  });
  it("KILLED target: an AGENT of the same boss reads it (its userId is that boss)", () => {
    const killedBySpawner = makeDeps({
      roomIdForAgent: () => null,
      killedAgentManagerUserId: () => "u-spawn", // == agent.userId
    });
    expect(
      logSearchAccess(ctx(agent, { id: "a-dead" }, undefined, killedBySpawner)),
    ).toEqual(OK);
  });
  it("KILLED target: an office OWNER reads any of them", () => {
    const killedByStranger = makeDeps({
      roomIdForAgent: () => null,
      killedAgentManagerUserId: () => "u-someone-else",
    });
    expect(
      logSearchAccess(
        ctx(userOwner, { id: "a-dead" }, undefined, killedByStranger),
      ),
    ).toEqual(OK);
  });
  it("KILLED target: another boss is denied - a room-mate of the dead agent is NOT enough", () => {
    const killedByOther = makeDeps({
      roomIdForAgent: () => null,
      hasRoomAccess: () => true,
      killedAgentManagerUserId: () => "u-other",
    });
    expect(
      logSearchAccess(
        ctx(userMember, { id: "a-dead" }, undefined, killedByOther),
      ),
    ).toEqual(DENY);
    // Same for an agent whose boss is not the dead agent's boss.
    expect(
      logSearchAccess(ctx(agent, { id: "a-dead" }, undefined, killedByOther)),
    ).toEqual(DENY);
  });
  it("NON-LEAK: an unknown id denies exactly like a killed one belonging to someone else", () => {
    const unknown = makeDeps({
      roomIdForAgent: () => null,
      killedAgentManagerUserId: () => null,
    });
    const foreignDead = makeDeps({
      roomIdForAgent: () => null,
      killedAgentManagerUserId: () => "u-other",
    });
    const a = logSearchAccess(
      ctx(userMember, { id: "a-ghost" }, undefined, unknown),
    );
    const b = logSearchAccess(
      ctx(userMember, { id: "a-dead" }, undefined, foreignDead),
    );
    expect(a).toEqual(DENY);
    expect(a).toEqual(b);
  });
  it("CRON-RUN: denied even for a killed agent its cron user spawned", () => {
    const killedByRunUser = makeDeps({
      roomIdForAgent: () => null,
      hasRoomAccess: () => true,
      killedAgentManagerUserId: () => "u-cron", // == run.userId
    });
    expect(
      logSearchAccess(ctx(run, { id: "a-dead" }, undefined, killedByRunUser)),
    ).toEqual(DENY);
  });
});

// --- APP scope: the guard catalog, from the outside -------------------------
//
// One block rather than a clause in each guard's describe, because the property
// is about the CATALOG, not about any one guard: an app token authorizes
// nothing. The fixtures are deliberately generous - every dep answers the way
// it would for the app's own owner - so a guard that merely forgot to check
// scope fails here rather than passing on a technicality.

describe("guard catalog: an APP identity is denied everywhere", () => {
  // As permissive as the guard deps can be: the app's userId owns everything,
  // every room is accessible, and every lookup answers with a match.
  const generous = makeDeps({
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r-1",
    userIdForUsername: () => "u-owner",
    cronjobCreatorUserId: () => "u-owner",
    appOwnerUserId: () => "u-owner",
    agentManagerUserId: () => "u-owner",
    killedAgentManagerUserId: () => "u-owner",
  });
  const appCtx = ctx(
    app,
    { id: "a-1", name: "hello", username: "alice", roomId: "r-1" },
    { senderAgentId: "a-1", roomId: "r-1" },
    generous,
  );

  // Guards an app must never satisfy. Each one is scope-keyed, so the generous
  // deps above (which hand it its owner's every match) change nothing.
  const scopeGated: Array<[string, (c: GuardContext) => unknown]> = [
    ["authenticated", authenticated],
    ["officeOwner", officeOwner],
    ["userScope", userScope],
    ["selfUser", selfUser],
    ["selfOrOwner", selfOrOwner],
    ["agentParamMustEqualTokenAgent", agentParamMustEqualTokenAgent],
    ["senderMustEqualTokenAgent", senderMustEqualTokenAgent],
    ["runParamMustEqualTokenRun", runParamMustEqualTokenRun],
    ["appOwnerOrOfficeOwner", appOwnerOrOfficeOwner()],
    ["cronjobOwnerOrOfficeOwner", cronjobOwnerOrOfficeOwner()],
    ["messageSend", messageSend],
    ["scheduledMessagesOwner", scheduledMessagesOwner],
    ["conversationReset", conversationReset],
    ["logSearchAccess", logSearchAccess],
    ["taskDelete", taskDelete],
  ];

  for (const [name, guard] of scopeGated) {
    it(`${name} denies`, () => {
      expect(guard(appCtx)).toEqual(DENY);
    });
  }

  // The three COMPOSE-ONLY helpers, asserted as what they are rather than bent
  // to fit. Each answers one narrow question about the caller and is documented
  // as never standing alone; an app answers those questions the same way a cron
  // run does, so singling the app out here would be inventing a promise the
  // catalog does not make. What actually gates each one is named beside it, and
  // pinned where it lives.
  const composeOnly: Array<[string, (c: GuardContext) => unknown, string]> = [
    [
      "hasOwningUser",
      hasOwningUser,
      "asks only whether the caller has an owning user, and an app does; apps.register composes it with app:write, which an app does not hold",
    ],
    [
      "agentManagerMatch",
      agentManagerMatch(),
      "keys on userId alone by design; its only route wraps it in and(userScope, ...)",
    ],
    [
      "killedAgentLogAccess",
      killedAgentLogAccess,
      "keys on userId alone; reached only from inside logSearchAccess (which denies an app) behind the log:read capability (which an app lacks)",
    ],
  ];

  for (const [name, guard, why] of composeOnly) {
    it(`${name} allows in isolation - ${why}`, () => {
      expect(guard(appCtx)).toEqual(OK);
      // Same answer for a cron run: this is a property of the helper, not a
      // hole that opened when app scope arrived.
      expect(
        guard(
          ctx(
            { ...run, userId: "u-owner" },
            { id: "a-1", name: "hello" },
            undefined,
            generous,
          ),
        ),
      ).toEqual(OK);
    });
  }

  it("requiresRoomAccess denies even when the room-access dep says yes to everything", () => {
    // The dep CANNOT express this: hasRoomAccess keys on identity.userId, and
    // an app's userId is its owner's - so with the office's real adapter an app
    // would inherit every room its owner can reach. The scope check in the
    // guard is what closes it, which is why the fixture here hands the guard a
    // dep that says yes.
    for (const ref of [
      { kind: "paramRoomId", name: "roomId" },
      { kind: "paramAgentId", name: "id" },
      { kind: "bodyRoomId", name: "roomId" },
    ] as const) {
      expect(requiresRoomAccess(ref)(appCtx)).toEqual(DENY);
    }
  });
});
