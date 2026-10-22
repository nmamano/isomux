// Phase 2.2 - Two-stage dispatcher contract tests (TDD red→green for NEW code).
//
// Asserts the central authz semantics from internal-docs/generic-runtime-refactor.md
// → Conventions "Two-stage authorization, both declared" + "Error envelope":
//   no identity at all      -> 401 unauthenticated  (the ONLY 401 path)
//   missing capability (s1) -> 403 forbidden, and stage 2 is NOT run
//   resourceGuard deny (s2) -> the guard's outcome, verbatim
// Pure T0: no server, no FS, no LLM. The dispatcher is exercised directly; the
// route executor (server/routes/executor.ts) runs it for every route.

import { describe, it, expect } from "bun:test";
import { authorize, type RouteAuthz } from "../identity/dispatch.ts";
import {
  type AuthzOutcome,
  type Guard,
  type GuardDeps,
} from "../identity/guards.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  APP_CAPABILITIES,
  type Identity,
} from "../identity/index.ts";

const userOwner: Identity = {
  scope: "user",
  userId: "u-owner",
  role: "owner",
  capabilities: USER_CAPABILITIES,
};
const agent: Identity = {
  scope: "agent",
  userId: "u-spawn",
  agentId: "a-1",
  role: "member",
  capabilities: AGENT_CAPABILITIES,
};

const deps: GuardDeps = {
  hasRoomAccess: () => true,
  roomIdForAgent: () => "r-1",
  userIdForUsername: () => null,
  cronjobCreatorUserId: () => null,
  appOwnerUserId: () => null,
  webhookOwnerUserId: () => null,
  isOfficeOwnerUserId: () => false,
  agentManagerUserId: () => null,
  killedAgentManagerUserId: () => null,
  killedAgentLastRoomId: () => null,
  roomExists: () => false,
  cronRunVisibleTo: () => false,
};

const allowGuard: Guard = () => ({ ok: true });
const throwGuard: Guard = () => {
  throw new Error("stage 2 must not run when stage 1 fails");
};

function input(identity: Identity | null) {
  return { identity, params: {}, body: undefined, deps };
}

describe("dispatcher: authn stage (null identity)", () => {
  it("no identity at all -> 401 unauthenticated, before any capability/guard check", () => {
    // Even a route whose guard would throw must short-circuit at 401.
    const route: RouteAuthz = {
      requiredCapability: "office:read",
      resourceGuard: throwGuard,
    };
    let outcome: AuthzOutcome | undefined;
    expect(() => {
      outcome = authorize(route, input(null));
    }).not.toThrow();
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
  });
});

describe("dispatcher: stage 1 (coarse capability)", () => {
  it("missing capability -> 403 forbidden, and stage 2 is NOT run (the guard would throw)", () => {
    const route: RouteAuthz = {
      requiredCapability: "agent:manage",
      resourceGuard: throwGuard,
    };
    let outcome: AuthzOutcome | undefined;
    expect(() => {
      outcome = authorize(route, input(agent));
    }).not.toThrow();
    expect(outcome).toEqual({ ok: false, status: 403, code: "forbidden" });
  });
});

describe("dispatcher: stage 1 any-of capability (composite routes)", () => {
  // agents.sendMessage admits a user, agent, cron-run, or API sender capability.
  // An AGENT holds a capability that is not first in the list.
  const anyOf: RouteAuthz = {
    requiredCapability: [
      "agent:converse",
      "agent:send-as-self",
      "agent:send-as-cron",
      "api:send-message",
    ],
    resourceGuard: allowGuard,
  };
  it("an AGENT holding its sender capability clears stage 1", () => {
    expect(authorize(anyOf, input(agent))).toEqual({ ok: true });
  });
  it("an APP identity holding none of the four is denied at stage 1", () => {
    const app: Identity = {
      scope: "app",
      userId: "u",
      appName: "status",
      role: "member",
      capabilities: APP_CAPABILITIES,
    };
    expect(authorize(anyOf, input(app))).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
    });
  });
});

describe("dispatcher: stage 2 (resource guard)", () => {
  it("capability present + guard denies -> the guard's outcome verbatim", () => {
    // A custom non-403 outcome proves the dispatcher passes the guard result
    // through rather than substituting its own status/code.
    const customDeny: Guard = () => ({
      ok: false,
      status: 404,
      code: "not_found",
    });
    const route: RouteAuthz = {
      requiredCapability: "office:read",
      resourceGuard: customDeny,
    };
    expect(authorize(route, input(userOwner))).toEqual({
      ok: false,
      status: 404,
      code: "not_found",
    });
  });
});
