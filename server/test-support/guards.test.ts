// Guard catalog contract tests. PURE T0 unit tests: no server, no FS, no LLM.
// A guard's ordinary allow/deny answer is owned by the route tests that drive
// it over HTTP; this file keeps what a route test cannot reach:
//   1. Scope gates: a non-user identity is never authorized via role, and a
//      USER/RUN never satisfies an AGENT-keyed guard - proven even when a
//      matching userId or a forced role would naively pass. Stage 1 hides
//      most of these on a real route.
//   2. Non-leak: a hidden resource and a missing one deny with the IDENTICAL
//      {status, code}.
//   3. Hardening: blank ids and malformed bodies never match.
//   4. The APP catalog and the office-owner reach table.

import { describe, it, expect } from "bun:test";
import {
  authenticated,
  officeOwner,
  userScope,
  selfUser,
  selfOrOwner,
  agentParamMustEqualTokenAgent,
  senderMustEqualTokenAgent,
  runParamMustEqualTokenRun,
  requiresRoomAccess,
  cronjobOwnerOrOfficeOwner,
  appOwnerOrOfficeOwner,
  appScope,
  messageSend,
  scheduledMessagesOwner,
  queueCancelAccess,
  queueCancelAny,
  conversationReset,
  logSearchAccess,
  liveAgentReadAccess,
  taskDelete,
  integrationOfficeOwner,
  officeSettingsOwner,
  auditOwner,
  webhookOwnerOrOfficeOwner,
  ownerProxyMemberCreate,
  proxyMemberPrompt,
  type GuardDeps,
  type GuardContext,
} from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  APP_CAPABILITIES,
  API_CAPABILITIES,
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
const api: Identity = {
  scope: "api",
  userId: "u-mem",
  apiTokenId: "pat-1",
  apiTokenName: "Laptop",
  role: "member",
  capabilities: API_CAPABILITIES,
};

const OK = { ok: true } as const;
const DENY = { ok: false, status: 403, code: "forbidden" } as const;

function makeDeps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    hasRoomAccess: () => false,
    roomIdForAgent: () => null,
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => null,
    cronjobCreatorAgentId: () => null,
    appOwnerUserId: () => null,
    webhookOwnerUserId: () => null,
    webhookCreatorAgentId: () => null,
    isOfficeOwnerUserId: () => false,
    agentManagerUserId: () => null,
    killedAgentManagerUserId: () => null,
    killedAgentLastRoomId: () => null,
    roomExists: () => false,
    cronRunVisibleTo: () => false,
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

// --- authenticated -----------------------------------------------------------

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
  it("denies AGENT and CRON-RUN - including a PRIVILEGED agent (scope stays 'agent')", () => {
    expect(userScope(ctx(agent))).toEqual(DENY);
    expect(userScope(ctx(privilegedAgent))).toEqual(DENY);
    expect(userScope(ctx(run))).toEqual(DENY);
  });
});

// --- selfUser ---------------------------------------------------------------

describe("guard: selfUser", () => {
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
});

// --- selfOrOwner ------------------------------------------------------------

describe("guard: selfOrOwner", () => {
  it("scope-gate: an AGENT cannot pass via owner OR self branch", () => {
    // Stage 1 already keeps agents off users.update; this guard is the second
    // lock on it and on users.delete.
    const agentMatches = makeDeps({ userIdForUsername: () => "u-spawn" });
    for (const identity of [agent, privilegedAgent])
      expect(
        selfOrOwner(
          ctx(identity, { username: "spawnuser" }, undefined, agentMatches),
        ),
      ).toEqual(DENY);
  });
});

// --- agentParamMustEqualTokenAgent ------------------------------------------

describe("guard: agentParamMustEqualTokenAgent", () => {
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
  it("allows when the legacy senderAgentId matches the token agentId", () => {
    expect(
      senderMustEqualTokenAgent(ctx(agent, {}, { senderAgentId: "a-1" })),
    ).toEqual(OK);
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
  it("allows only the token's own run: another run or job of the same token is denied", () => {
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-1", runId: "run-1" })),
    ).toEqual(OK);
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-1", runId: "run-9" })),
    ).toEqual(DENY);
    expect(
      runParamMustEqualTokenRun(ctx(run, { id: "job-9", runId: "run-1" })),
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
  it("denies a wrong body shape (null / non-object / missing field) without leaking", () => {
    const deps = makeDeps({ hasRoomAccess: () => true });
    expect(guard(ctx(userMember, {}, null, deps))).toEqual(DENY);
    expect(guard(ctx(userMember, {}, "nope", deps))).toEqual(DENY);
    expect(guard(ctx(userMember, {}, {}, deps))).toEqual(DENY);
  });
});

// --- appOwnerOrOfficeOwner --------------------------------------------------
// Written as a deliberate CONTRAST to cronjobOwnerOrOfficeOwner below. App
// access includes the ordinary agent's owner match and, under task 3cd85856
// (Nil's 2026-08-31 ruling), an agent whose manager is an office owner. Cron access
// keeps its narrower privilege + creator rule. Copying either guard without
// re-deriving its scope is exactly the mistake these cases catch.

describe("guard: appOwnerOrOfficeOwner", () => {
  const guard = appOwnerOrOfficeOwner("name");
  it("allows an ORDINARY agent on an owner match - app:* is baseline, not a privilege", () => {
    const deps = makeDeps({ appOwnerUserId: () => "u-spawn" }); // == agent.userId
    expect(guard(ctx(agent, { name: "hello" }, undefined, deps))).toEqual(OK);
    expect(
      guard(ctx(privilegedAgent, { name: "hello" }, undefined, deps)),
    ).toEqual(OK);
  });
  it("allows an office owner's agent through before an unknown-app lookup", () => {
    const ownerAgent: Identity = { ...agent, userId: "u-owner" };
    expect(
      guard(
        ctx(
          ownerAgent,
          { name: "never-registered" },
          undefined,
          makeDeps({
            appOwnerUserId: () => null,
            isOfficeOwnerUserId: (userId) => userId === "u-owner",
          }),
        ),
      ),
    ).toEqual(OK);
  });
  it("denies a cron-run whose userId belongs to an office owner", () => {
    let ownerChecks = 0;
    const ownerRun: Identity = { ...run, userId: "u-owner" };
    expect(
      guard(
        ctx(
          ownerRun,
          { name: "hello" },
          undefined,
          makeDeps({
            appOwnerUserId: () => "u-owner",
            isOfficeOwnerUserId: () => {
              ownerChecks += 1;
              return true;
            },
          }),
        ),
      ),
    ).toEqual(DENY);
    expect(ownerChecks).toBe(0);
  });
});

// --- cronjobOwnerOrOfficeOwner ----------------------------------------------

describe("guard: cronjobOwnerOrOfficeOwner", () => {
  const guard = cronjobOwnerOrOfficeOwner("id");
  it("scope-gate / no confused deputy: a NARROW agent whose userId equals the creator is STILL denied", () => {
    // A normal agent lacks cron:manage, so it is not a privileged agent and is
    // denied even on a userId match - the confused-deputy guard the narrow token
    // exists for. (cron-run likewise.)
    const deps = makeDeps({ cronjobCreatorUserId: () => "u-spawn" });
    expect(guard(ctx(agent, { id: "job-1" }, undefined, deps))).toEqual(DENY);
    expect(guard(ctx(run, { id: "job-1" }, undefined, deps))).toEqual(DENY);
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

// --- messageSend (composite, caller-authz only) -----------------------------

describe("guard: messageSend", () => {
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
  it("AGENT: a mismatched legacy senderAgentId is rejected", () => {
    expect(
      messageSend(ctx(agent, { id: "a-recip" }, { senderAgentId: "a-2" })),
    ).toEqual(DENY);
  });
  it("CRON-RUN: unowned, access-revoked, and stale-owner jobs deny", () => {
    const target = { id: "a-recip" };
    const unowned = makeDeps({
      cronjobCreatorUserId: () => null,
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    const accessRevoked = makeDeps({
      cronjobCreatorUserId: () => "u-cron",
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => false,
    });
    const staleOwner = makeDeps({
      cronjobCreatorUserId: () => "u-other",
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    expect(messageSend(ctx(run, target, undefined, unowned))).toEqual(DENY);
    expect(messageSend(ctx(run, target, undefined, accessRevoked))).toEqual(
      DENY,
    );
    expect(messageSend(ctx(run, target, undefined, staleOwner))).toEqual(DENY);
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
  it("CRON-RUN: denied (a run has no session to reset)", () => {
    expect(conversationReset(ctx(run, { id: "a-1" }))).toEqual(DENY);
  });
});

// --- conversation reads: a cron run reads none -----------------------------

describe("guard: conversation reads refuse a cron run", () => {
  it("denies a run a LIVE agent in a room its creator can reach", () => {
    // Stage 1 hides this today (a run holds no log:read); the guard must still
    // refuse it. The same deps let a user through, so the room path is open.
    const reachable = makeDeps({
      roomIdForAgent: () => "r-1",
      hasRoomAccess: () => true,
    });
    for (const guard of [logSearchAccess, liveAgentReadAccess]) {
      expect(
        guard(ctx(userMember, { id: "a-1" }, undefined, reachable)),
      ).toEqual(OK);
      expect(guard(ctx(run, { id: "a-1" }, undefined, reachable))).toEqual(
        DENY,
      );
    }
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
    cronjobCreatorAgentId: () => null,
    appOwnerUserId: () => "u-owner",
    webhookOwnerUserId: () => "u-owner",
    webhookCreatorAgentId: () => null,
    isOfficeOwnerUserId: () => true,
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
    ["queueCancelAccess", queueCancelAccess],
    ["queueCancelAny", queueCancelAny],
    ["conversationReset", conversationReset],
    ["logSearchAccess", logSearchAccess],
    ["taskDelete", taskDelete],
  ];

  for (const [name, guard] of scopeGated) {
    it(`${name} denies`, () => {
      expect(guard(appCtx)).toEqual(DENY);
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

// --- office-owner reach ------------------------------------------------------
// One question, asked by seven guards: is the caller an office owner, or an
// agent, an app with a live owner agent, or an API token whose user is an
// office owner right now? A human's answer comes from the session role; every
// other caller's comes from the live user record, never from Identity.role.
// The proxy guards (ownerProxyMemberCreate, proxyMemberPrompt) admit the
// non-human half only: a human owner acts as themself.
//
// Every resource below belongs to someone else, so reach alone decides.

describe("office-owner reach: one answer across the guards", () => {
  const deps = makeDeps({
    isOfficeOwnerUserId: (userId) => userId === "u-owner",
    appOwnerUserId: () => "u-other",
    webhookOwnerUserId: () => "u-other",
    userIdForUsername: () => "u-other",
  });
  const params = { name: "hello", id: "h-1", username: "bob" };
  const body = { role: "member" };

  const reachGuards = {
    integrationOfficeOwner,
    officeSettingsOwner,
    auditOwner,
    appOwnerOrOfficeOwner: appOwnerOrOfficeOwner("name"),
    webhookOwnerOrOfficeOwner: webhookOwnerOrOfficeOwner("id"),
  };
  const proxyGuards = { ownerProxyMemberCreate, proxyMemberPrompt };

  const ownerAgent: Identity = {
    scope: "agent",
    userId: "u-owner",
    agentId: "a-owner",
    role: "member",
    capabilities: PRIVILEGED_AGENT_CAPABILITIES,
  };
  // [caller, reach guards allow, proxy guards allow]
  const rows: Array<[string, Identity, boolean, boolean]> = [
    ["an owner", userOwner, true, false],
    ["a member", userMember, false, false],
    [
      "a human whose session says owner while the live record does not",
      { ...userOwner, userId: "u-demoted" },
      true,
      false,
    ],
    ["an owner's agent", ownerAgent, true, true],
    [
      "a member's agent",
      { ...ownerAgent, userId: "u-mem", agentId: "a-mem" },
      false,
      false,
    ],
    [
      "a member's agent that carries role owner",
      { ...ownerAgent, userId: "u-mem", agentId: "a-mem", role: "owner" },
      false,
      false,
    ],
    ["an agent with no user", { ...ownerAgent, userId: null }, false, false],
    [
      "an app with an owner's agent as its owner agent",
      {
        ...app,
        ownerAgentId: "a-owner",
        capabilities: [...APP_CAPABILITIES, ...PRIVILEGED_AGENT_CAPABILITIES],
      },
      true,
      true,
    ],
    ["an owner's app with no owner agent", app, false, false],
    [
      "a cron run of an owner's job",
      { ...run, userId: "u-owner" },
      false,
      false,
    ],
    [
      "an owner's API token",
      { ...api, userId: "u-owner", role: "owner" },
      true,
      true,
    ],
    ["a member's API token", api, false, false],
    [
      "a member's API token that carries role owner",
      { ...api, role: "owner" },
      false,
      false,
    ],
  ];

  for (const [who, identity, reach, proxy] of rows) {
    it(`${who}: reach ${reach ? "allows" : "denies"}, proxy ${proxy ? "allows" : "denies"}`, () => {
      const c = ctx(identity, params, body, deps);
      const got = Object.fromEntries([
        ...Object.entries(reachGuards).map(([n, g]) => [n, g(c).ok]),
        ...Object.entries(proxyGuards).map(([n, g]) => [n, g(c).ok]),
      ]);
      expect(got).toEqual({
        ...Object.fromEntries(Object.keys(reachGuards).map((n) => [n, reach])),
        ...Object.fromEntries(Object.keys(proxyGuards).map((n) => [n, proxy])),
      });
    });
  }
});
