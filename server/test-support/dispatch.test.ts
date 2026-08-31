// Phase 2.2 - Two-stage dispatcher contract tests (TDD red→green for NEW code).
//
// Asserts the central authz semantics from internal-docs/generic-runtime-refactor.md
// → Conventions "Two-stage authorization, both declared" + "Error envelope":
//   no identity at all      -> 401 unauthenticated  (the ONLY 401 path)
//   missing capability (s1) -> 403 forbidden, and stage 2 is NOT run
//   resourceGuard deny (s2) -> the guard's outcome, verbatim
// Pure T0: no server, no FS, no LLM. The dispatcher is exercised directly; it is
// NOT wired into the live dispatchCommand switch or any HTTP handler in 2.2.

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
  RUN_CAPABILITIES,
  APP_CAPABILITIES,
  API_CAPABILITIES,
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
  isOfficeOwnerUserId: () => false,
  agentManagerUserId: () => null,
  killedAgentManagerUserId: () => null,
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
  it("missing capability -> 403 forbidden", () => {
    // An AGENT lacks agent:manage.
    const route: RouteAuthz = {
      requiredCapability: "agent:manage",
      resourceGuard: allowGuard,
    };
    expect(authorize(route, input(agent))).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
    });
  });
  it("stage 2 is NOT run when stage 1 fails (guard would throw but is never reached)", () => {
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
  // USER (has converse, not send-as-self) and an AGENT (has send-as-self, not
  // converse) must clear stage 1 and reach messageSend's scope-specific stage 2.
  const anyOf: RouteAuthz = {
    requiredCapability: [
      "agent:converse",
      "agent:send-as-self",
      "agent:send-as-cron",
      "api:send-message",
    ],
    resourceGuard: allowGuard,
  };
  it("a USER holding its sender capability clears stage 1", () => {
    expect(authorize(anyOf, input(userOwner))).toEqual({ ok: true });
  });
  it("an AGENT holding its sender capability clears stage 1", () => {
    expect(authorize(anyOf, input(agent))).toEqual({ ok: true });
  });
  it("a CRON-RUN holding its dedicated capability clears stage 1", () => {
    const run: Identity = {
      scope: "cron-run",
      userId: "u",
      cronjobId: "j",
      runId: "r",
      role: "member",
      capabilities: RUN_CAPABILITIES,
    };
    expect(authorize(anyOf, input(run))).toEqual({ ok: true });
  });
  it("an API identity holding its dedicated capability clears stage 1", () => {
    const api: Identity = {
      scope: "api",
      userId: "u",
      apiTokenId: "pat-1",
      apiTokenName: "Phone",
      role: "member",
      capabilities: API_CAPABILITIES,
    };
    expect(authorize(anyOf, input(api))).toEqual({ ok: true });
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
  it("capability present + guard allows -> ok", () => {
    const route: RouteAuthz = {
      requiredCapability: "office:read",
      resourceGuard: allowGuard,
    };
    expect(authorize(route, input(userOwner))).toEqual({ ok: true });
  });
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
