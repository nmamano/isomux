// Privileged-agent route authorization matrix (task 98d63ef7).
//
// The CRUX of the audit, pinned against the REAL route table. For a privileged
// agent (scope STILL "agent", carrying PRIVILEGED_AGENT_CAPABILITIES) we run the
// table's own two-stage authorize() and assert, route by route:
//
//   INTENDED-REACHABLE  the room-scoped operator routes open up (resume,
//                       listSessions, converse, lifecycle, full cron over OWN jobs)
//   STILL-BLOCKED       the escalation / owner-admin routes stay shut - invites.*
//                       (durable login mint), sessions.* (kill the human's browser
//                       session), users/office admin, cron.setInstructions
//   NO-IMPERSONATION    sendMessage takes the AGENT branch (attributes to the agent)
//   TOGGLE DOUBLE-GATE  agents.setPrivileged is unreachable by ANY agent; a USER
//                       with room access reaches it
//
// Pure T0: no server/FS/LLM. authorize() is the same primitive the executor runs
// (server/routes/executor.ts runAuthorize), fed the table's real auth slice.

import { describe, it, expect } from "bun:test";
import { API_ROUTES } from "../routes/table.ts";
import { authorize, type RouteAuthz } from "../identity/dispatch.ts";
import type { GuardDeps } from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  API_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";

// --- Identities -------------------------------------------------------------
const SPAWNER = "u-spawn";
const privilegedAgent: Identity = {
  scope: "agent",
  userId: SPAWNER,
  agentId: "a-1",
  role: "member",
  capabilities: PRIVILEGED_AGENT_CAPABILITIES,
};
const normalAgent: Identity = {
  scope: "agent",
  userId: SPAWNER,
  agentId: "a-1",
  role: "member",
  capabilities: AGENT_CAPABILITIES,
};
const owner: Identity = {
  scope: "user",
  userId: "u-owner",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};
const member: Identity = {
  scope: "user",
  userId: "u-mem",
  role: "member",
  capabilities: USER_CAPABILITIES,
};

// --- Guard deps -------------------------------------------------------------
// Default: the target agent lives in a room the caller can reach, and the target
// cronjob was created by the agent's spawning user (so owner-match is in play).
function deps(over: Partial<GuardDeps> = {}): GuardDeps {
  return {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r-1",
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => SPAWNER,
    cronjobCreatorAgentId: () => null,
    appOwnerUserId: () => null,
    webhookOwnerUserId: () => null,
    isOfficeOwnerUserId: () => false,
    // Default: the target agent is managed by the member fixture (for the
    // setPrivileged (i-b) tests, which override per case).
    agentManagerUserId: () => member.userId,
    killedAgentManagerUserId: () => null,
    killedAgentLastRoomId: () => null,
    roomExists: () => false,
    cronRunVisibleTo: () => false,
    ...over,
  };
}

// Pull a capability route's authz slice straight from the live table.
function authz(opId: string): RouteAuthz {
  const r = API_ROUTES.find((r) => r.opId === opId);
  if (!r) throw new Error(`no route ${opId}`);
  if (r.auth.kind !== "capability") {
    throw new Error(`${opId} is auth.kind=${r.auth.kind}, not capability`);
  }
  return {
    requiredCapability: r.auth.requiredCapability,
    resourceGuard: r.auth.resourceGuard,
  };
}

function can(
  opId: string,
  identity: Identity,
  params: Record<string, string> = {},
  body: unknown = undefined,
  d: GuardDeps = deps(),
): boolean {
  return authorize(authz(opId), { identity, params, body, deps: d }).ok;
}

const AGENT_PARAMS = { id: "a-1" };
const CRON_PARAMS = { id: "job-1" };
const ROOM_PARAMS = { roomId: "r-1" };

describe("privileged agent: INTENDED room-scoped operator routes are reachable", () => {
  it("drives another agent's chat (resume / sendNow / newConversation / handoff / editMessage)", () => {
    const DRIVE_OPS = [
      "agents.resume",
      "agents.sendNow",
      "agents.newConversation",
      "agents.handoff",
      "agents.editMessage",
    ];
    // A privileged agent reaches all of them on any reachable agent.
    for (const op of DRIVE_OPS) {
      expect(can(op, privilegedAgent, AGENT_PARAMS)).toBe(true);
    }
    // A NORMAL agent lacks agent:converse and is blocked from driving ANOTHER
    // agent. AGENT_PARAMS.id (a-1) collides with normalAgent's own agentId, so
    // target a different agent to test the "someone else's chat" case.
    const OTHER = { id: "a-other" };
    for (const op of DRIVE_OPS) {
      expect(can(op, normalAgent, OTHER)).toBe(false);
    }
    // newConversation and handoff are the TWO exceptions with a self path (both
    // ride conversationReset): a normal agent may reset/hand off ITS OWN session,
    // and nothing else.
    for (const op of ["agents.newConversation", "agents.handoff"]) {
      expect(can(op, normalAgent, { id: "a-1" })).toBe(true);
    }
    // The other three have no self path - a normal agent is blocked even on itself.
    for (const op of [
      "agents.resume",
      "agents.sendNow",
      "agents.editMessage",
    ]) {
      expect(can(op, normalAgent, { id: "a-1" })).toBe(false);
    }
  });
  it("reads sessions / lifecycle / editor / uploads on a reachable agent", () => {
    for (const op of [
      "agents.kill",
      "agents.update",
      "agents.openFile",
      "agents.upload",
    ]) {
      expect(can(op, privilegedAgent, AGENT_PARAMS)).toBe(true);
      expect(can(op, normalAgent, AGENT_PARAMS)).toBe(false);
    }
    // listSessions has the /logs reach since 2026-09-16: a normal agent lists
    // its own sessions and those of any agent in a room it can reach, and
    // nothing in a room it cannot.
    expect(can("agents.listSessions", privilegedAgent, AGENT_PARAMS)).toBe(
      true,
    );
    expect(can("agents.listSessions", normalAgent, AGENT_PARAMS)).toBe(true);
    expect(can("agents.listSessions", normalAgent, { id: "a-other" })).toBe(
      true,
    );
    const noRoom = deps({ hasRoomAccess: () => false });
    expect(
      can(
        "agents.listSessions",
        normalAgent,
        { id: "a-other" },
        undefined,
        noRoom,
      ),
    ).toBe(false);
  });
  // Task e17989e0: every agent passes cancelQueued's route auth on any agent,
  // in a reachable room or not - a sender takes back its own item from any
  // queue it may message, and the handler cancels nothing else for it (pinned
  // in queue-read-retract.test.ts). A member keeps the room reach.
  it("lets every agent reach cancelQueued on any agent; a member needs room access", () => {
    const noAccess = deps({ hasRoomAccess: () => false });
    for (const agent of [privilegedAgent, normalAgent]) {
      for (const d of [deps(), noAccess]) {
        expect(
          can("agents.cancelQueued", agent, { id: "a-other" }, undefined, d),
        ).toBe(true);
      }
    }
    expect(can("agents.cancelQueued", member, AGENT_PARAMS)).toBe(true);
    expect(
      can("agents.cancelQueued", member, AGENT_PARAMS, undefined, noAccess),
    ).toBe(false);
  });
  it("gives readQueue exactly the listSessions reach", () => {
    const noRoom = deps({ hasRoomAccess: () => false });
    for (const identity of [privilegedAgent, normalAgent, owner, member]) {
      for (const params of [AGENT_PARAMS, { id: "a-other" }]) {
        for (const d of [deps(), noRoom]) {
          expect(can("agents.readQueue", identity, params, undefined, d)).toBe(
            can("agents.listSessions", identity, params, undefined, d),
          );
        }
      }
    }
  });
  // Task f4452169: abort left the operator set. Every agent, privileged or
  // not, stops any agent it may message - message reach is not room-scoped.
  it("lets every agent abort any agent, in a reachable room or not", () => {
    const noAccess = deps({ hasRoomAccess: () => false });
    for (const agent of [privilegedAgent, normalAgent]) {
      expect(can("agents.abort", agent, { id: "a-other" })).toBe(true);
      expect(
        can("agents.abort", agent, { id: "a-other" }, undefined, noAccess),
      ).toBe(true);
    }
    // A member keeps the operator reach: room access to the target.
    expect(can("agents.abort", member, AGENT_PARAMS)).toBe(true);
    expect(can("agents.abort", member, AGENT_PARAMS, undefined, noAccess)).toBe(
      false,
    );
  });
  it("is still room-scoped: NO access to an agent in an unreachable room", () => {
    const noAccess = deps({ hasRoomAccess: () => false });
    expect(
      can("agents.resume", privilegedAgent, AGENT_PARAMS, undefined, noAccess),
    ).toBe(false);
    // Another agent's id: its own sessions stay readable everywhere.
    expect(
      can(
        "agents.listSessions",
        privilegedAgent,
        { id: "a-other" },
        undefined,
        noAccess,
      ),
    ).toBe(false);
  });
});

describe("privileged agent: room management (Nil-approved expansion)", () => {
  it("creates rooms (office-wide) and manages rooms it can access", () => {
    expect(can("rooms.create", privilegedAgent)).toBe(true);
    expect(can("rooms.create", normalAgent)).toBe(false); // no room:manage
    for (const op of [
      "rooms.rename",
      "rooms.getSettings",
      "rooms.setInstructions",
      "rooms.close",
    ]) {
      expect(can(op, privilegedAgent, ROOM_PARAMS)).toBe(true); // room access granted
      expect(can(op, normalAgent, ROOM_PARAMS)).toBe(false); // stage-1 block
    }
  });
  it("is bounded to rooms its spawning user can access (no rename/settings read-or-write/close on an unreachable room)", () => {
    const noAccess = deps({ hasRoomAccess: () => false });
    for (const op of [
      "rooms.rename",
      "rooms.getSettings",
      "rooms.setInstructions",
      "rooms.close",
    ]) {
      expect(can(op, privilegedAgent, ROOM_PARAMS, undefined, noAccess)).toBe(
        false,
      );
    }
  });
});

describe("privileged agent: full cron over its OWN jobs (Nil-approved)", () => {
  it("creates cronjobs and manages jobs its spawning user owns", () => {
    expect(can("cron.create", privilegedAgent)).toBe(true);
    for (const op of ["cron.update", "cron.delete", "cron.runNow"]) {
      expect(can(op, privilegedAgent, CRON_PARAMS)).toBe(true); // owner-match
    }
  });
  it("canNOT manage a job owned by someone else (own-jobs only, no office-owner shortcut)", () => {
    const otherOwner = deps({ cronjobCreatorUserId: () => "someone-else" });
    expect(
      can("cron.update", privilegedAgent, CRON_PARAMS, undefined, otherOwner),
    ).toBe(false);
    expect(
      can("cron.delete", privilegedAgent, CRON_PARAMS, undefined, otherOwner),
    ).toBe(false);
  });
  it("cron.setInstructions stays OFFICE-OWNER only - blocked for a privileged agent", () => {
    expect(can("cron.setInstructions", privilegedAgent)).toBe(false);
    expect(can("cron.setInstructions", owner)).toBe(true);
  });
});

// Task c4233bfd: an ordinary agent holds cron:own, which reaches only the jobs
// that agent made, while they are still its manager's. Its manager's own jobs
// (the user owner-match a privileged agent gets) stay out of reach.
describe("ordinary agent: cron over only the jobs it made", () => {
  const CRON_MUTATIONS: Array<[string, Record<string, string>]> = [
    ["cron.update", CRON_PARAMS],
    ["cron.delete", CRON_PARAMS],
    ["cron.runNow", CRON_PARAMS],
    ["cron.runMessage", { ...CRON_PARAMS, runId: "run-1" }],
    [
      "cron.editRunMessage",
      { ...CRON_PARAMS, runId: "run-1", logEntryId: "e-1" },
    ],
  ];
  const outcomes = (identity: Identity, d: GuardDeps) =>
    CRON_MUTATIONS.map(([op, params]) => [
      op,
      can(op, identity, params, undefined, d),
    ]);
  const all = (allowed: boolean) => CRON_MUTATIONS.map(([op]) => [op, allowed]);

  it("creates, and manages a job it made for its manager", () => {
    expect(can("cron.create", normalAgent)).toBe(true);
    const made = deps({ cronjobCreatorAgentId: () => normalAgent.agentId! });
    expect(outcomes(normalAgent, made)).toEqual(all(true));
  });

  it("cannot manage its manager's job, another agent's, or its own job once it belongs to another member", () => {
    const cases: Array<[string, GuardDeps]> = [
      // The default deps: the spawning user's job, made by no agent.
      ["manager's job", deps()],
      ["another agent's", deps({ cronjobCreatorAgentId: () => "a-2" })],
      [
        "made by it, now another member's",
        deps({
          cronjobCreatorAgentId: () => normalAgent.agentId!,
          cronjobCreatorUserId: () => "someone-else",
        }),
      ],
      ["unknown job", deps({ cronjobCreatorUserId: () => null })],
    ];
    for (const [label, d] of cases) {
      expect([label, outcomes(normalAgent, d)]).toEqual([label, all(false)]);
    }
    // The same manager's job is the privileged agent's (the contrast).
    expect(outcomes(privilegedAgent, deps())).toEqual(all(true));
  });

  it("keeps the schedule instructions out of reach", () => {
    for (const op of ["cron.readInstructions", "cron.setInstructions"]) {
      expect([op, can(op, normalAgent)]).toEqual([op, false]);
    }
  });
});

describe("privileged agent: escalation / owner-admin routes STAY BLOCKED", () => {
  it("CANNOT mint invites (the durable-login escalation) - invites.* all 403", () => {
    expect(can("invites.mintSelf", privilegedAgent)).toBe(false);
    expect(can("invites.mint", privilegedAgent, { username: "x" })).toBe(false);
    expect(can("invites.list", privilegedAgent)).toBe(false);
    expect(can("invites.revoke", privilegedAgent, { tokenPrefix: "p" })).toBe(
      false,
    );
    // A real user still can (mintSelf is authenticated; owner-mint is officeOwner).
    expect(can("invites.mintSelf", member)).toBe(true);
    expect(can("invites.mint", owner, { username: "x" })).toBe(true);
  });
  it("CANNOT touch human browser sessions - sessions.list / revoke 403", () => {
    expect(can("sessions.list", privilegedAgent)).toBe(false);
    expect(
      can("sessions.revoke", privilegedAgent, { sessionPrefix: "p" }),
    ).toBe(false);
  });
  it("CANNOT change user or office access - users.setAccess / office.setAccess 403", () => {
    expect(can("users.setAccess", privilegedAgent, { username: "x" })).toBe(
      false,
    );
    expect(can("office.setAccess", privilegedAgent)).toBe(false);
    expect(can("users.setAccess", owner, { username: "x" })).toBe(true); // owner can
  });
  it("creates only a plain member, and only while its manager is an office owner", () => {
    const ownerManaged = deps({ isOfficeOwnerUserId: () => true });
    const plain = { name: "Yu", role: "member" };
    expect(can("users.create", privilegedAgent, {}, plain, ownerManaged)).toBe(
      true,
    );
    // A member's privileged agent: the human member cannot create members.
    expect(can("users.create", privilegedAgent, {}, plain)).toBe(false);
    expect(
      can(
        "users.create",
        privilegedAgent,
        {},
        { name: "Yu", role: "owner" },
        ownerManaged,
      ),
    ).toBe(false);
    expect(
      can(
        "users.create",
        privilegedAgent,
        {},
        { ...plain, allowedRooms: ["r-1"] },
        ownerManaged,
      ),
    ).toBe(true);
    expect(can("users.create", normalAgent, {}, plain, ownerManaged)).toBe(
      false,
    );
    expect(can("users.create", member, {}, plain)).toBe(false);
    expect(can("users.create", owner, {}, plain)).toBe(true);
  });
});

describe("no-impersonation: sendMessage takes the AGENT branch", () => {
  it("a privileged agent sends AS ITSELF (messageSend agent branch), never as the user", () => {
    // ALLOWED to send (as the agent); the guard is the scope-keyed agent branch,
    // so attribution stays the agent. A foreign senderAgentId is rejected.
    expect(can("agents.sendMessage", privilegedAgent, AGENT_PARAMS, {})).toBe(
      true,
    );
    expect(
      can("agents.sendMessage", privilegedAgent, AGENT_PARAMS, {
        senderAgentId: "someone-else",
      }),
    ).toBe(false);
  });
});

describe("agents.setPrivileged: double-gated + (i-b) manager-or-owner conferral", () => {
  // Default fake: the target agent (a-1) is managed by `member`.
  it("blocked for BOTH a privileged and a normal agent (stage-1 cap absent + userScope)", () => {
    expect(
      can("agents.setPrivileged", privilegedAgent, AGENT_PARAMS, {
        privileged: true,
      }),
    ).toBe(false);
    expect(
      can("agents.setPrivileged", normalAgent, AGENT_PARAMS, {
        privileged: true,
      }),
    ).toBe(false);
  });
  it("REGRESSION: a privileged agent whose userId COINCIDES with the target's manager is STILL blocked", () => {
    // managerMatch alone would pass (userId === manager), but `userScope` is the
    // OUTER gate, so no agent passes stage 2 on a userId coincidence. This is why
    // the guard is and(userScope, or(officeOwner, managerMatch)), not a bare or.
    const agentMatchingManager: Identity = {
      ...privilegedAgent,
      userId: member.userId,
    };
    const d = deps({ agentManagerUserId: () => member.userId });
    expect(
      can(
        "agents.setPrivileged",
        agentMatchingManager,
        AGENT_PARAMS,
        { privileged: true },
        d,
      ),
    ).toBe(false);
  });
  it("office owner toggles ANY agent (officeOwner branch)", () => {
    // Even one managed by someone else.
    const managedByOther = deps({ agentManagerUserId: () => "u-someone-else" });
    expect(
      can(
        "agents.setPrivileged",
        owner,
        AGENT_PARAMS,
        { privileged: true },
        managedByOther,
      ),
    ).toBe(true);
  });
  it("a member toggles ONLY agents they manage - the cross-user case is BLOCKED", () => {
    // member manages a-1 -> allowed (manager-match)
    expect(
      can("agents.setPrivileged", member, AGENT_PARAMS, { privileged: true }),
    ).toBe(true);
    // a-1 managed by a DIFFERENT member -> member cannot elevate another's agent
    const managedByOther = deps({ agentManagerUserId: () => "u-other-member" });
    expect(
      can(
        "agents.setPrivileged",
        member,
        AGENT_PARAMS,
        { privileged: true },
        managedByOther,
      ),
    ).toBe(false);
  });
  it("unknown/unowned target: manager-match denies a member (non-leak); owner passes the guard (404 is the handler's)", () => {
    const unowned = deps({ agentManagerUserId: () => null });
    expect(
      can(
        "agents.setPrivileged",
        member,
        AGENT_PARAMS,
        { privileged: true },
        unowned,
      ),
    ).toBe(false);
    expect(
      can(
        "agents.setPrivileged",
        owner,
        AGENT_PARAMS,
        { privileged: true },
        unowned,
      ),
    ).toBe(true);
  });
});

// agents.setManager (task 6a9deaba): an office owner by cookie session only
// (Nil, 2026-09-15). A transfer hands the agent its new manager's
// credentials, so no agent and no API token reaches it, also when its user is
// an office owner, and a manager cannot give their own agent away.
describe("agents.setManager: an office owner by cookie session only", () => {
  const body = { userId: "u-new" };
  // Every live fact that could open another branch is true: the caller's user
  // is an office owner by the live record and manages the agent.
  const generous = (userId: string) =>
    deps({
      isOfficeOwnerUserId: () => true,
      agentManagerUserId: () => userId,
    });

  it("lets an office owner move any agent, also one with no manager", () => {
    expect(
      can("agents.setManager", owner, AGENT_PARAMS, body, generous("u-x")),
    ).toBe(true);
    expect(
      can(
        "agents.setManager",
        owner,
        AGENT_PARAMS,
        body,
        deps({ agentManagerUserId: () => null }),
      ),
    ).toBe(true);
  });

  it("refuses a member, also the agent's own manager", () => {
    expect(
      can(
        "agents.setManager",
        member,
        AGENT_PARAMS,
        body,
        deps({ agentManagerUserId: () => member.userId }),
      ),
    ).toBe(false);
  });

  it("refuses every agent and an office owner's API token", () => {
    const ownerUser = owner.userId!;
    const ownersAgent = (capabilities: Identity["capabilities"]): Identity => ({
      scope: "agent",
      userId: ownerUser,
      agentId: "a-2",
      role: "owner",
      capabilities,
    });
    const ownersApiToken: Identity = {
      scope: "api",
      userId: ownerUser,
      role: "owner",
      apiTokenId: "t-1",
      capabilities: API_CAPABILITIES,
    };
    for (const identity of [
      ownersAgent(PRIVILEGED_AGENT_CAPABILITIES),
      ownersAgent(AGENT_CAPABILITIES),
      ownersApiToken,
    ])
      expect(
        can(
          "agents.setManager",
          identity,
          AGENT_PARAMS,
          body,
          generous(ownerUser),
        ),
      ).toBe(false);
  });
});
