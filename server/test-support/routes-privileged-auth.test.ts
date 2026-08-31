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
//                       session), users/office admin, cron.setPrompt
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
    appOwnerUserId: () => null,
    isOfficeOwnerUserId: () => false,
    // Default: the target agent is managed by the member fixture (for the
    // setPrivileged (i-b) tests, which override per case).
    agentManagerUserId: () => member.userId,
    killedAgentManagerUserId: () => null,
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
  it("drives another agent's chat (resume / sendNow / newConversation / handoff / cancelQueued / editMessage)", () => {
    const DRIVE_OPS = [
      "agents.resume",
      "agents.sendNow",
      "agents.newConversation",
      "agents.handoff",
      "agents.cancelQueued",
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
    // The other four have no self path - a normal agent is blocked even on itself.
    for (const op of [
      "agents.resume",
      "agents.sendNow",
      "agents.cancelQueued",
      "agents.editMessage",
    ]) {
      expect(can(op, normalAgent, { id: "a-1" })).toBe(false);
    }
  });
  it("reads sessions / lifecycle / editor / uploads on a reachable agent", () => {
    for (const op of [
      "agents.listSessions",
      "agents.kill",
      "agents.abort",
      "agents.update",
      "agents.openFile",
      "agents.upload",
    ]) {
      expect(can(op, privilegedAgent, AGENT_PARAMS)).toBe(true);
      expect(can(op, normalAgent, AGENT_PARAMS)).toBe(false);
    }
  });
  it("is still room-scoped: NO access to an agent in an unreachable room", () => {
    const noAccess = deps({ hasRoomAccess: () => false });
    expect(
      can("agents.resume", privilegedAgent, AGENT_PARAMS, undefined, noAccess),
    ).toBe(false);
    expect(
      can(
        "agents.listSessions",
        privilegedAgent,
        AGENT_PARAMS,
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
      "rooms.setSettings",
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
      "rooms.setSettings",
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
    expect(can("cron.create", normalAgent)).toBe(false); // no cron:manage
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
  it("cron.setPrompt stays OFFICE-OWNER only - blocked for a privileged agent", () => {
    expect(can("cron.setPrompt", privilegedAgent)).toBe(false);
    expect(can("cron.setPrompt", owner)).toBe(true);
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
  it("CANNOT reach office/user administration - setAccess / office.* 403", () => {
    expect(can("users.setAccess", privilegedAgent, { username: "x" })).toBe(
      false,
    );
    expect(can("office.setAccess", privilegedAgent)).toBe(false);
    expect(can("office.setSettings", privilegedAgent)).toBe(false);
    expect(can("users.setAccess", owner, { username: "x" })).toBe(true); // owner can
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
