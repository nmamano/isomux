// Phase 2.3 - Route table contract tests (TDD red→green for NEW code).
//
// Structural invariants over the typed route table (the skeleton that REPLACES
// the dispatchCommand switch in Phase 3): unique opIds + method/path, every
// `emits` resolves to a registry event, every capability route has a valid
// capability + guard, and - the carried-forward 2.2 caution - a `public` route
// can NEVER be fed to authorize() (it carries no RouteAuthz by type).
//
// Pure T0: no server, no FS, no LLM. The table is data exercised directly.

import { describe, it, expect } from "bun:test";
import {
  API_ROUTES,
  PUBLIC_ROUTES,
  ALL_ROUTES,
  type RouteDef,
  type RouteAuth,
  type RoutePrecondition,
} from "../routes/table.ts";
import { isEventId, type EventId } from "../events/registry.ts";
import { authorize } from "../identity/dispatch.ts";
import { runAuthorize } from "../routes/executor.ts";
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  PRIVILEGED_AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  APP_CAPABILITIES,
  API_CAPABILITIES,
  type Capability,
  type Identity,
} from "../identity/index.ts";
import type { GuardDeps } from "../identity/guards.ts";
import { providerAccountsHandlers } from "../routes/handlers/provider-accounts.ts";

const ALL_CAPS = new Set<Capability>([
  ...USER_CAPABILITIES,
  ...AGENT_CAPABILITIES,
  ...RUN_CAPABILITIES,
  // One entry today (app:message); listed so a capability added to the APP set
  // has to be a real Capability, and so this union does not quietly go stale.
  ...APP_CAPABILITIES,
  ...API_CAPABILITIES,
]);

function capsOf(auth: RouteAuth): readonly Capability[] {
  if (auth.kind !== "capability") return [];
  return typeof auth.requiredCapability === "string"
    ? [auth.requiredCapability]
    : auth.requiredCapability;
}

describe("route table: identity invariants", () => {
  it("opIds are unique across the whole table", () => {
    const ids = ALL_ROUTES.map((r) => r.opId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("(method, path) pairs are unique across the whole table", () => {
    const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("provider account routes", () => {
  it("rejects an agent token before it can read a sign-in secret", () => {
    const route = API_ROUTES.find((r) => r.opId === "providerAccounts.start")!;
    const identity: Identity = {
      scope: "agent",
      role: "member",
      userId: "u1",
      agentId: "a1",
      capabilities: AGENT_CAPABILITIES,
    };
    const result = runAuthorize(
      route.auth,
      identity,
      { provider: "codex" },
      undefined,
      {
        hasRoomAccess: () => true,
        roomIdForAgent: () => null,
        userIdForUsername: () => null,
        cronjobCreatorUserId: () => null,
        appOwnerUserId: () => null,
        isOfficeOwnerUserId: () => false,
        agentManagerUserId: () => null,
        killedAgentManagerUserId: () => null,
      },
    );
    expect(result).toEqual({ ok: false, status: 403, code: "forbidden" });
  });

  it("carries the explicit provider and scope into every login act", async () => {
    const calls: string[] = [];
    const handlers = providerAccountsHandlers({
      list: async () => [],
      refresh: async () => [],
      start: async (_userId, provider, scope, method) => {
        calls.push(`start:${provider}:${scope}:${method}`);
        return { ok: true, value: { account: {} } };
      },
      callback: async (_userId, provider, scope, code) => {
        calls.push(`callback:${provider}:${scope}:${code}`);
        return { ok: true, value: { submitted: true } };
      },
      cancel: async (_userId, provider, scope) => {
        calls.push(`cancel:${provider}:${scope}`);
        return true;
      },
      disconnect: async () => ({ ok: true, value: { accounts: [] } }),
    });
    const context = (body: unknown) =>
      ({
        identity: {
          scope: "user",
          role: "member",
          userId: "u1",
          capabilities: USER_CAPABILITIES,
        },
        params: { provider: "claude" },
        body,
      }) as never;
    await handlers["providerAccounts.start"](
      context({ scope: "personal", method: "browser" }),
    );
    await handlers["providerAccounts.callback"](
      context({ scope: "personal", code: "code#state" }),
    );
    await handlers["providerAccounts.cancel"](context({ scope: "personal" }));
    expect(calls).toEqual([
      "start:claude:personal:browser",
      "callback:claude:personal:code#state",
      "cancel:claude:personal",
    ]);
  });

  it("rejects a login act without an explicit scope", async () => {
    let started = false;
    const handlers = providerAccountsHandlers({
      list: async () => [],
      refresh: async () => [],
      start: async () => {
        started = true;
        return { ok: true, value: {} };
      },
      callback: async () => ({ ok: true, value: {} }),
      cancel: async () => true,
      disconnect: async () => ({ ok: true, value: { accounts: [] } }),
    });
    const result = await handlers["providerAccounts.start"]({
      identity: {
        scope: "user",
        role: "member",
        userId: "u1",
        capabilities: USER_CAPABILITIES,
      },
      params: { provider: "codex" },
      body: { method: "browser" },
    } as never);
    expect(result).toEqual({
      kind: "error",
      status: 422,
      code: "invalid_scope",
      message: undefined,
    });
    expect(started).toBe(false);
  });
});

describe("route table: emits resolve to the event registry", () => {
  it("every emitted id is a real registry event", () => {
    for (const r of ALL_ROUTES) {
      for (const id of r.emits) {
        expect(isEventId(id)).toBe(true);
      }
    }
  });
});

describe("route table: capability routes are well-formed", () => {
  it("every capability route has a valid capability (any-of allowed) + a guard", () => {
    for (const r of API_ROUTES) {
      if (r.auth.kind !== "capability") continue;
      const caps = capsOf(r.auth);
      expect(caps.length).toBeGreaterThan(0);
      for (const c of caps) expect(ALL_CAPS.has(c)).toBe(true);
      expect(typeof r.auth.resourceGuard).toBe("function");
    }
  });
  it("authenticated routes carry a guard but no capability (e.g. sessions.logout)", () => {
    const authnRoutes = API_ROUTES.filter(
      (r) => r.auth.kind === "authenticated",
    );
    expect(authnRoutes.length).toBeGreaterThan(0);
    for (const r of authnRoutes) {
      // kind "authenticated" → no requiredCapability field, has a guard.
      expect("requiredCapability" in r.auth).toBe(false);
      expect(typeof (r.auth as { resourceGuard: unknown }).resourceGuard).toBe(
        "function",
      );
    }
  });
});

describe("route table: any-of capabilities where the spec uses `|`", () => {
  function route(opId: string): RouteDef {
    const r = ALL_ROUTES.find((x) => x.opId === opId);
    if (!r) throw new Error(`no route ${opId}`);
    return r;
  }
  it("agents.sendMessage admits user, agent, cron, or personal API sender capabilities", () => {
    expect(new Set(capsOf(route("agents.sendMessage").auth))).toEqual(
      new Set<Capability>([
        "agent:converse",
        "agent:send-as-self",
        "agent:send-as-cron",
        "api:send-message",
      ]),
    );
  });
  it("users.update requires user:self | user:admin", () => {
    expect(new Set(capsOf(route("users.update").auth))).toEqual(
      new Set<Capability>(["user:self", "user:admin"]),
    );
  });
});

describe("route table: public routes are routed AROUND authorize()", () => {
  it("every API route is authenticated/capability - none public", () => {
    for (const r of API_ROUTES) {
      expect(r.auth.kind).not.toBe("public");
    }
  });
  it("every public route carries NO capability and NO guard (can't form a RouteAuthz)", () => {
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(0);
    for (const r of PUBLIC_ROUTES) {
      expect(r.auth.kind).toBe("public");
      expect("requiredCapability" in r.auth).toBe(false);
      expect("resourceGuard" in r.auth).toBe(false);
    }
  });
  it("a capability route's authz slice IS dispatchable through authorize()", () => {
    // Positive control: a capability route forms a valid RouteAuthz the
    // dispatcher accepts (here, a null identity → 401, proving the wiring), so
    // the public-route exclusion is meaningful rather than vacuous.
    const deps: GuardDeps = {
      hasRoomAccess: () => true,
      roomIdForAgent: () => "r1",
      userIdForUsername: () => null,
      cronjobCreatorUserId: () => null,
      appOwnerUserId: () => null,
      isOfficeOwnerUserId: () => false,
      agentManagerUserId: () => null,
      killedAgentManagerUserId: () => null,
    };
    const cap = API_ROUTES.find((r) => r.auth.kind === "capability");
    if (!cap || cap.auth.kind !== "capability") throw new Error("no cap route");
    const outcome = authorize(cap.auth, {
      identity: null,
      params: {},
      body: undefined,
      deps,
    });
    expect(outcome).toEqual({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
  });
});

describe("route table: managed env values are self-only", () => {
  const deps: GuardDeps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r1",
    userIdForUsername: (name) => (name === "self" ? "u1" : "u2"),
    cronjobCreatorUserId: () => null,
    appOwnerUserId: () => null,
    isOfficeOwnerUserId: () => false,
    agentManagerUserId: () => "u1",
    killedAgentManagerUserId: () => "u1",
  };
  const identities: Record<string, Identity> = {
    user: {
      scope: "user",
      userId: "u1",
      role: "member",
      capabilities: USER_CAPABILITIES,
    },
    api: {
      scope: "api",
      userId: "u1",
      role: "member",
      apiTokenId: "p1",
      apiTokenName: "API",
      capabilities: API_CAPABILITIES,
    },
    agent: {
      scope: "agent",
      userId: "u1",
      role: "member",
      agentId: "a1",
      capabilities: AGENT_CAPABILITIES,
    },
    privilegedAgent: {
      scope: "agent",
      userId: "u1",
      role: "member",
      agentId: "a2",
      capabilities: PRIVILEGED_AGENT_CAPABILITIES,
    },
  };

  it("admits the owning user and API identity, and no agent identity", () => {
    for (const opId of ["userEnv.get", "userEnv.replace"]) {
      const route = API_ROUTES.find((candidate) => candidate.opId === opId)!;
      expect(
        runAuthorize(
          route.auth,
          identities.user,
          { username: "self" },
          undefined,
          deps,
        ).ok,
      ).toBe(true);
      expect(
        runAuthorize(
          route.auth,
          identities.api,
          { username: "self" },
          undefined,
          deps,
        ).ok,
      ).toBe(true);
      expect(
        runAuthorize(
          route.auth,
          identities.user,
          { username: "other" },
          undefined,
          deps,
        ).ok,
      ).toBe(false);
      expect(
        runAuthorize(
          route.auth,
          identities.api,
          { username: "other" },
          undefined,
          deps,
        ).ok,
      ).toBe(false);
      expect(
        runAuthorize(
          route.auth,
          identities.agent,
          { username: "self" },
          undefined,
          deps,
        ).ok,
      ).toBe(false);
      expect(
        runAuthorize(
          route.auth,
          identities.privilegedAgent,
          { username: "self" },
          undefined,
          deps,
        ).ok,
      ).toBe(false);
    }
  });

  // The name-only read is the ONE managed-env route whose subject is somebody
  // else, so it swaps selfUserOrApi for officeEnvOwner: office owners only,
  // by cookie or by their own API token. Walked here at the guard level; the
  // wire behaviour is in routes-user-env-rest.test.ts.
  it("opens userEnv.names to office owners only, cookie or their API token", () => {
    const route = API_ROUTES.find((r) => r.opId === "userEnv.names")!;
    const ownerDeps: GuardDeps = { ...deps, isOfficeOwnerUserId: () => true };
    const ownerCookie: Identity = { ...identities.user, role: "owner" };
    const ownerApi: Identity = { ...identities.api, role: "owner" };
    // An owner reads ANOTHER user's names - the whole point of the route.
    for (const who of [ownerCookie, ownerApi]) {
      expect(
        runAuthorize(route.auth, who, { username: "other" }, undefined, ownerDeps)
          .ok,
      ).toBe(true);
    }
    // A member is refused even for their OWN names: they read values through
    // userEnv.get, so nothing here is theirs to reach.
    for (const who of [
      identities.user,
      identities.api,
      identities.agent,
      identities.privilegedAgent,
    ]) {
      for (const username of ["self", "other"]) {
        expect(
          runAuthorize(route.auth, who, { username }, undefined, deps).ok,
        ).toBe(false);
      }
    }
    // An agent whose spawning user IS the office owner still cannot pass:
    // officeEnvOwner gates on scope, not on whose userId the token carries.
    for (const who of [identities.agent, identities.privilegedAgent]) {
      expect(
        runAuthorize(route.auth, who, { username: "other" }, undefined, ownerDeps)
          .ok,
      ).toBe(false);
    }
  });

  it("assigns user:env only to USER and API capability sets", () => {
    expect(USER_CAPABILITIES).toContain("user:env");
    expect(API_CAPABILITIES).toContain("user:env");
    expect(AGENT_CAPABILITIES).not.toContain("user:env");
    expect(PRIVILEGED_AGENT_CAPABILITIES).not.toContain("user:env");
  });
});

describe("route table: managed office env is owner-only", () => {
  const deps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r1",
    userIdForUsername: () => null,
    cronjobCreatorUserId: () => null,
    appOwnerUserId: () => null,
    isOfficeOwnerUserId: (id: string) => id === "owner",
    agentManagerUserId: () => null,
    killedAgentManagerUserId: () => null,
  } satisfies GuardDeps;
  const identity = (
    scope: Identity["scope"],
    userId: string | null,
    role: "owner" | "member",
    capabilities: readonly Capability[],
  ): Identity => ({
    scope,
    userId,
    role,
    capabilities,
    ...(scope === "agent" ? { agentId: "a1" } : {}),
    ...(scope === "app" ? { appName: "app" } : {}),
    ...(scope === "cron-run" ? { cronjobId: "j1", runId: "run1" } : {}),
  });

  it("allows owner users and owner API tokens, and refuses every other scope", () => {
    const route = API_ROUTES.find((r) => r.opId === "officeEnv.get")!;
    const allowed = (candidate: Identity) =>
      runAuthorize(route.auth, candidate, {}, undefined, deps).ok;
    expect(allowed(identity("user", "owner", "owner", USER_CAPABILITIES))).toBe(
      true,
    );
    expect(
      allowed(identity("user", "member", "member", USER_CAPABILITIES)),
    ).toBe(false);
    expect(allowed(identity("api", "owner", "owner", API_CAPABILITIES))).toBe(
      true,
    );
    expect(allowed(identity("api", "member", "member", API_CAPABILITIES))).toBe(
      false,
    );
    expect(
      allowed(identity("agent", "owner", "member", AGENT_CAPABILITIES)),
    ).toBe(false);
    expect(
      allowed(
        identity("agent", "owner", "member", PRIVILEGED_AGENT_CAPABILITIES),
      ),
    ).toBe(false);
    expect(allowed(identity("app", "owner", "member", APP_CAPABILITIES))).toBe(
      false,
    );
    expect(
      allowed(identity("cron-run", "owner", "member", RUN_CAPABILITIES)),
    ).toBe(false);
  });
});

describe("route table: coverage sanity", () => {
  it("declares the expected /api surface (every spec resource group present)", () => {
    const opIds = new Set(API_ROUTES.map((r) => r.opId));
    for (const expected of [
      "agents.spawn",
      "agents.sendMessage",
      "agents.readFile",
      "rooms.create",
      "view.setOrder",
      "users.update",
      "invites.mint",
      "sessions.logout",
      "office.setSettings",
      "tasks.create",
      "apps.register",
      "cron.runReadFile",
      "system.backupStatus",
    ]) {
      expect(opIds.has(expected)).toBe(true);
    }
  });
});

// The spec's per-route capability + emits, restated INDEPENDENTLY (like
// event-registry's SPEC_AUDIENCES). The table must match this exactly - a
// wrong-but-VALID emit or capability (a regression neither isEventId nor
// ALL_CAPS can catch) fails here. `caps: []` marks an `authenticated`-kind
// route (identity required, no capability).
const SPEC_ROUTE_CONTRACT: Record<
  string,
  { caps: Capability[]; emits: EventId[] }
> = {
  // Agents - lifecycle
  "agents.spawn": { caps: ["agent:manage"], emits: ["agent_added"] },
  "agents.kill": {
    caps: ["agent:manage"],
    emits: ["agent_removed", "killed_agent_added"],
  },
  "agents.revive": {
    caps: ["agent:manage"],
    emits: ["agent_added", "killed_agent_removed"],
  },
  "agents.abort": { caps: ["agent:manage"], emits: [] },
  "agents.update": { caps: ["agent:manage"], emits: ["agent_updated"] },
  // caps: [] = `authenticated`-kind (task 68891fa1): every agent may READ the
  // blob + version; only the WRITE (agents.update) is capability-gated.
  "agents.readInstructions": { caps: [], emits: [] },
  "agents.setPrivileged": {
    caps: ["agent:privilege"],
    emits: ["agent_updated"],
  },
  "agents.move": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "agents.setTopic": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "agents.clearTopic": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "rooms.swapDesks": { caps: ["agent:manage"], emits: ["agent_updated"] },
  // Agents - conversation
  "agents.sendMessage": {
    caps: [
      "agent:converse",
      "agent:send-as-self",
      "agent:send-as-cron",
      "api:send-message",
    ],
    emits: ["log_entry", "interaction_added", "agent_updated"],
  },
  "agents.respondInteraction": {
    caps: ["agent:converse", "self:affordance"],
    emits: ["interaction_removed", "agent_updated", "log_entry", "clear_logs"],
  },
  "agents.editMessage": { caps: ["agent:converse"], emits: ["log_entry"] },
  "agents.cancelQueued": { caps: ["agent:converse"], emits: [] },
  // Agents - scheduled messages (task 8ff369b5). Same any-of pair as
  // sendMessage: a USER manages via converse rights, an AGENT via
  // send-as-self; the scheduledMessagesOwner guard then scopes the AGENT
  // branch to its OWN outbox. No emits: pending entries have no UI surface
  // yet (post-fire they ride the normal queue events).
  "agents.listScheduledMessages": {
    caps: ["agent:converse", "agent:send-as-self"],
    emits: [],
  },
  "agents.cancelScheduledMessage": {
    caps: ["agent:converse", "agent:send-as-self"],
    emits: [],
  },
  "agents.sendNow": { caps: ["agent:converse"], emits: ["log_entry"] },
  // newConversation: a USER or a PRIVILEGED agent clears via converse rights; an
  // ORDINARY agent clears ONLY itself via self:affordance. conversationReset
  // scopes the agent branch (privileged → room access; ordinary → self).
  "agents.newConversation": {
    caps: ["agent:converse", "self:affordance"],
    emits: ["clear_logs"],
  },
  // handoff: same conversationReset split as newConversation (operator → room
  // access; ordinary agent → self). Resets (clear_logs) then delivers the brief
  // into the fresh session (log_entry).
  "agents.handoff": {
    caps: ["agent:converse", "self:affordance"],
    emits: ["clear_logs", "log_entry"],
  },
  "agents.resume": { caps: ["agent:converse"], emits: ["log_entry"] },
  "agents.listSessions": { caps: ["office:read"], emits: [] },
  // Agents - self-affordances
  "agents.readFile": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.diff": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.editFile": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.terminalCommand": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.previewUrl": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.contextUsage": { caps: ["self:affordance"], emits: [] },
  // Conversation-log search + retrieval. Its OWN capability, deliberately NOT
  // office:read (which plain agent tokens do not carry) and not self:affordance
  // (the scope reaches past the caller's own chat). Read-only, so no emits.
  "agents.logs": { caps: ["log:read"], emits: [] },
  // Agents - editor
  "agents.openFile": {
    caps: ["editor:use"],
    emits: ["editor_external_change"],
  },
  "agents.saveFile": { caps: ["editor:use"], emits: [] },
  "agents.closeFile": { caps: ["editor:use"], emits: [] },
  // Agents - uploads / files
  "agents.upload": { caps: ["file:upload"], emits: [] },
  "agents.getFile": { caps: ["office:read"], emits: [] },
  // Rooms
  "rooms.create": { caps: ["room:manage"], emits: ["room_created"] },
  "rooms.close": {
    caps: ["room:manage"],
    emits: ["room_closed", "user_updated", "users_list"],
  },
  "rooms.rename": {
    caps: ["room:manage"],
    emits: ["room_renamed", "room_pet_updated"],
  },
  "rooms.getSettings": { caps: ["room:manage"], emits: [] },
  "rooms.setSettings": {
    caps: ["room:manage"],
    emits: ["room_settings_updated"],
  },
  // View preferences
  "view.setOrder": { caps: ["view:manage"], emits: ["full_state"] },
  "view.setShown": {
    caps: ["view:manage"],
    emits: ["full_state", "user_updated"],
  },
  "view.setNotifRooms": { caps: ["view:manage"], emits: ["user_updated"] },
  "view.listRooms": { caps: ["view:manage"], emits: [] },
  // Personal preferences (task 49d4e2f6). user:self, NOT view:manage - these
  // are record fields, and user:self is the capability that already means
  // "edit a user record" while staying out of both agent capability sets.
  "prefs.update": {
    caps: ["user:self"],
    emits: ["user_admin_updated", "user_self_updated"],
  },
  "userEnv.get": { caps: ["user:env"], emits: [] },
  "userEnv.replace": { caps: ["user:env"], emits: [] },
  "userEnv.names": { caps: ["user:env"], emits: [] },
  "officeEnv.get": { caps: ["user:env"], emits: [] },
  "officeEnv.replace": { caps: ["user:env"], emits: [] },
  "apiTokens.list": { caps: ["user:self"], emits: [] },
  "apiTokens.mint": { caps: ["user:self"], emits: [] },
  "apiTokens.revoke": { caps: ["user:self"], emits: [] },
  "providerAccounts.list": { caps: ["user:self"], emits: [] },
  "providerAccounts.start": {
    caps: ["user:self"],
    emits: ["provider_accounts_updated"],
  },
  "providerAccounts.callback": {
    caps: ["user:self"],
    emits: ["provider_accounts_updated"],
  },
  "providerAccounts.refresh": {
    caps: ["user:self"],
    emits: ["provider_accounts_updated"],
  },
  "providerAccounts.cancel": {
    caps: ["user:self"],
    emits: ["provider_accounts_updated"],
  },
  "providerAccounts.disconnect": {
    caps: ["user:self"],
    emits: ["provider_accounts_updated"],
  },
  "apiTokenInbox.send": {
    caps: ["agent:send-to-api-token"],
    emits: ["log_entry"],
  },
  "apiTokenInbox.drain": { caps: ["api:drain-inbox"], emits: [] },
  // Users
  "users.update": {
    caps: ["user:self", "user:admin"],
    emits: ["user_updated", "users_list"],
  },
  "users.setAccess": {
    caps: ["user:admin"],
    emits: ["user_admin_updated", "user_self_updated", "full_state"],
  },
  "users.delete": {
    caps: ["user:self", "user:admin"],
    emits: ["users_list", "session_expired"],
  },
  // Sessions, invites, access
  "invites.mint": { caps: ["invite:manage"], emits: ["invites_list"] },
  "invites.mintSelf": { caps: ["invite:manage"], emits: ["invites_list"] },
  "invites.mintRecovery": {
    caps: ["invite:manage"],
    emits: ["invites_list"],
  },
  "invites.list": { caps: ["invite:manage"], emits: [] },
  "invites.revoke": {
    caps: ["invite:manage"],
    emits: ["invite_revoked", "invites_list"],
  },
  "sessions.list": { caps: ["session:manage"], emits: [] },
  "sessions.revoke": {
    caps: ["session:manage"],
    emits: ["session_revoked", "sessions_active_list", "session_expired"],
  },
  "sessions.logout": { caps: [], emits: ["session_expired"] },
  "office.getAccess": { caps: ["office:admin"], emits: [] },
  "office.setAccess": { caps: ["office:admin"], emits: ["invites_list"] },
  // In-UI update trigger (release channel): owner-only, no emits - the
  // update_status event is fed by the checker, never by these routes.
  "office.updateInfo": { caps: ["office:admin"], emits: [] },
  "office.triggerUpdate": { caps: ["office:admin"], emits: [] },
  // Office settings, validation, backends
  "office.getSettings": { caps: ["office:admin"], emits: [] },
  "office.setSettings": {
    caps: ["office:admin"],
    emits: ["office_settings_updated"],
  },
  "validate.cwd": { caps: ["agent:manage"], emits: [] },
  "validate.env": { caps: ["office:read"], emits: [] },
  "backends.listModels": { caps: ["agent:manage"], emits: [] },
  // Tasks
  "tasks.list": { caps: ["task:read"], emits: [] },
  "tasks.get": { caps: ["task:read"], emits: [] },
  "tasks.create": { caps: ["task:write"], emits: ["tasks"] },
  "tasks.update": { caps: ["task:write"], emits: ["tasks"] },
  "tasks.claim": { caps: ["task:write"], emits: ["tasks"] },
  "tasks.done": { caps: ["task:write"], emits: ["tasks"] },
  "tasks.delete": { caps: ["task:write"], emits: ["tasks"] },
  // Apps (agent-built web apps isomux runs). app:read / app:write are BASELINE
  // agent capabilities - an agent registering the app it just built IS the
  // feature - so the object-level scoping is carried by the
  // appOwnerOrOfficeOwner guard, not by capability absence. No emits until the
  // Apps tab exists.
  "apps.list": { caps: ["app:read"], emits: [] },
  "apps.get": { caps: ["app:read"], emits: [] },
  "apps.preview": { caps: ["app:read"], emits: [] },
  "apps.register": { caps: ["app:write"], emits: ["app_upserted"] },
  "apps.update": { caps: ["app:write"], emits: ["app_upserted"] },
  "apps.delete": { caps: ["app:write"], emits: ["app_deleted"] },
  "apps.logs": { caps: ["app:read"], emits: [] },
  // The recovery verbs are app:write, not app:read: they change what is
  // running on the box.
  "apps.start": { caps: ["app:write"], emits: ["app_upserted"] },
  "apps.stop": { caps: ["app:write"], emits: ["app_upserted"] },
  "apps.restart": { caps: ["app:write"], emits: ["app_upserted"] },
  // The app-SELF route. app:message is held by APP scope alone, so this is the
  // one line in this table whose capability no human and no agent carries.
  "apps.sendMessage": { caps: ["app:message"], emits: ["log_entry"] },
  // Cronjobs
  "cron.list": { caps: ["cron:read"], emits: [] },
  "cron.get": { caps: ["cron:read"], emits: [] },
  "cron.create": { caps: ["cron:manage"], emits: ["cronjob_added"] },
  "cron.update": { caps: ["cron:manage"], emits: ["cronjob_updated"] },
  "cron.delete": { caps: ["cron:manage"], emits: ["cronjob_deleted"] },
  "cron.runNow": { caps: ["cron:manage"], emits: ["cronjob_run_updated"] },
  "cron.setPrompt": {
    caps: ["cron:manage"],
    emits: ["cronjobs_prompt_updated"],
  },
  "cron.listRuns": { caps: ["cron:read"], emits: [] },
  "cron.listAllRuns": { caps: ["cron:read"], emits: [] },
  "cron.getRun": { caps: ["cron:read"], emits: [] },
  "cron.runMessage": {
    caps: ["cron:manage"],
    emits: ["cron_run_log_entry"],
  },
  "cron.editRunMessage": {
    caps: ["cron:manage"],
    emits: ["cron_run_log_entry"],
  },
  "cron.runReadFile": {
    caps: ["self:affordance"],
    emits: ["cron_run_log_entry"],
  },
  "cron.runDiff": { caps: ["self:affordance"], emits: ["cron_run_log_entry"] },
  // System
  "system.backupStatus": { caps: ["office:read"], emits: [] },
  "system.version": { caps: [], emits: [] },
  // Storage (task 2366ccb0). usage reads like backupStatus (office:read, agents
  // included - it is a size report); prune deletes, so office:admin + owner.
  "storage.usage": { caps: ["office:read"], emits: [] },
  "usage.read": { caps: ["office:read"], emits: [] },
  "storage.prune": { caps: ["office:admin"], emits: [] },
  // Memory (isomux-memory)
  "memory.read": { caps: ["memory:read"], emits: [] },
  "memory.append": { caps: ["memory:write"], emits: [] },
  "memory.replace": { caps: ["memory:write"], emits: [] },
  // Skill usage (per-user Sk-menu sort counts; task f1769b1a). office:read
  // keeps plain agent tokens out; counts are identity-keyed, so no resource
  // guard beyond authenticated.
  "skills.usageCounts": { caps: ["office:read"], emits: [] },
};

describe("route table: per-route capability + emits match the spec exactly", () => {
  it("covers exactly the API route opIds (no missing/extra)", () => {
    expect(new Set(API_ROUTES.map((r) => r.opId))).toEqual(
      new Set(Object.keys(SPEC_ROUTE_CONTRACT)),
    );
  });
  it("every route's required capabilities match the spec", () => {
    for (const r of API_ROUTES) {
      const spec = SPEC_ROUTE_CONTRACT[r.opId];
      if (!spec) throw new Error(`no spec for ${r.opId}`);
      expect(new Set(capsOf(r.auth))).toEqual(new Set(spec.caps));
    }
  });
  it("every route's emits match the spec (wrong-but-valid emit fails here)", () => {
    for (const r of API_ROUTES) {
      const spec = SPEC_ROUTE_CONTRACT[r.opId];
      if (!spec) throw new Error(`no spec for ${r.opId}`);
      expect(new Set(r.emits)).toEqual(new Set(spec.emits));
    }
  });
});

// The live-state semantic preconditions each route's Phase-3 handler must
// enforce (kept out of the pure resourceGuard). Pinned as typed data so the
// audit surface is machine-readable and Phase 3 cannot silently drop a check.
// Routes not listed must carry NO preconditions.
const SPEC_PRECONDITIONS: Record<string, RoutePrecondition[]> = {
  "agents.revive": ["reviveLastRoomAccess"],
  "agents.sendMessage": [
    "messageRecipientExists",
    "messagePendingPermissionBindsParam",
  ],
  "apiTokenInbox.send": ["apiTokenInboxTargetAvailable"],
  "invites.revoke": ["inviteOwnerOrSelf"],
  "sessions.revoke": ["sessionOwnerOrSelf", "notLastOwnerLockout"],
  "sessions.logout": ["notLastOwnerLockout"],
  "users.delete": ["userDeleteNotSelfOwner", "userDeleteNotLastOwner"],
  "validate.env": ["validateEnvBodySelfSubject"],
};

describe("route table: typed preconditions are pinned (Phase 3 can't forget)", () => {
  it("exactly the documented routes carry preconditions", () => {
    const withPre = API_ROUTES.filter(
      (r) => (r.preconditions?.length ?? 0) > 0,
    ).map((r) => r.opId);
    expect(new Set(withPre)).toEqual(new Set(Object.keys(SPEC_PRECONDITIONS)));
  });
  it("each route's preconditions match the spec exactly", () => {
    for (const r of API_ROUTES) {
      const expected = SPEC_PRECONDITIONS[r.opId] ?? [];
      expect(new Set(r.preconditions ?? [])).toEqual(new Set(expected));
    }
  });
});

// --- APP scope reaches EXACTLY ONE route ------------------------------------
//
// The invariant that bounds what an app token is worth: of every route in the
// table, an app identity authorizes one - the app-self message route. Walked
// over the whole table rather than asserted per route, so a route added later -
// or an existing one whose guard is loosened - trips this without anyone
// remembering to think about apps.
//
// The allowlist below is the ONLY place a route becomes reachable by an app, and
// editing it is meant to feel like a decision. It grew from [] to one entry when
// app-to-agent messaging landed; anything joining it should have as much
// argument behind it as that did.

const APP_REACHABLE_OPIDS = ["apps.sendMessage"];

describe("route table: an APP identity authorizes exactly the app-self route", () => {
  // Maximally permissive deps: every room accessible, every ownership lookup
  // answering with the app's own owner. Anything that gets through here got
  // through on scope, which is the only thing that should ever gate an app.
  const generousDeps: GuardDeps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r1",
    userIdForUsername: () => "u-owner",
    cronjobCreatorUserId: () => "u-owner",
    appOwnerUserId: () => "u-owner",
    isOfficeOwnerUserId: () => true,
    agentManagerUserId: () => "u-owner",
    killedAgentManagerUserId: () => "u-owner",
  };
  const appIdentity: Identity = {
    scope: "app",
    userId: "u-owner",
    appName: "hello",
    role: "member",
    capabilities: APP_CAPABILITIES,
  };
  // Every OTHER scope, each carrying its real capability set and the SAME owner
  // id the app has - so a pass below could only ever come from scope or
  // capability, not from an ownership coincidence.
  const ownerIdentity: Identity = {
    scope: "user",
    userId: "u-owner",
    role: "owner",
    capabilities: USER_CAPABILITIES,
  };
  const memberIdentity: Identity = {
    scope: "user",
    userId: "u-owner",
    role: "member",
    capabilities: USER_CAPABILITIES,
  };
  const agentIdentity: Identity = {
    scope: "agent",
    userId: "u-owner",
    agentId: "a-1",
    role: "member",
    capabilities: AGENT_CAPABILITIES,
  };
  const privilegedAgentIdentity: Identity = {
    scope: "agent",
    userId: "u-owner",
    agentId: "a-1",
    role: "member",
    capabilities: PRIVILEGED_AGENT_CAPABILITIES,
  };
  const runIdentity: Identity = {
    scope: "cron-run",
    userId: "u-owner",
    cronjobId: "j1",
    runId: "run-1",
    role: "member",
    capabilities: RUN_CAPABILITIES,
  };

  it("denies every API route but the app-self message route", () => {
    const allowed: string[] = [];
    for (const r of API_ROUTES) {
      if (r.auth.kind === "public") continue;
      const outcome = runAuthorize(
        r.auth,
        appIdentity,
        {
          id: "a-1",
          name: "hello",
          username: "alice",
          roomId: "r1",
          sessionPrefix: "abc",
          cronjobId: "j1",
          runId: "run-1",
          taskId: "t1",
          scheduledId: "s1",
        },
        { senderAgentId: "a-1", roomId: "r1" },
        generousDeps,
      );
      if (outcome.ok) allowed.push(r.opId);
    }
    // Named in the failure rather than counted, so a break says WHICH route.
    expect(allowed).toEqual(APP_REACHABLE_OPIDS);
  });

  // The other half of the same invariant, and the reason the list above is not
  // just "whatever the table happens to allow": the app-self route must be
  // reachable by an app and by NOTHING else. A capability set edited to hand
  // app:message to agents (or the guard swapped for `authenticated`) passes the
  // test above and fails here.
  it("and that route is reachable by an app identity ONLY", () => {
    const route = API_ROUTES.find((r) => r.opId === "apps.sendMessage")!;
    for (const other of [
      { label: "office owner", identity: ownerIdentity },
      { label: "member", identity: memberIdentity },
      { label: "agent", identity: agentIdentity },
      { label: "privileged agent", identity: privilegedAgentIdentity },
      { label: "cron run", identity: runIdentity },
    ]) {
      expect({
        label: other.label,
        outcome: runAuthorize(
          route.auth,
          other.identity,
          {},
          undefined,
          generousDeps,
        ),
      }).toEqual({
        label: other.label,
        outcome: { ok: false, status: 403, code: "forbidden" },
      });
    }
  });

  it("is denied for the RIGHT reason - 403, not 401 (isomux knows whose token it is)", () => {
    const someRoute = API_ROUTES.find((r) => r.opId === "apps.list")!;
    expect(
      runAuthorize(someRoute.auth, appIdentity, {}, undefined, generousDeps),
    ).toEqual({ ok: false, status: 403, code: "forbidden" });
  });
});

// Written before the API guards were widened (task d1908202). This is the
// intended remote-boss surface, not a snapshot of whatever today's guards let
// through. The first run against the old guards is deliberately red.
const API_REACHABLE_OPIDS = [
  "agents.spawn",
  "agents.kill",
  "agents.revive",
  "agents.abort",
  "agents.update",
  "agents.readInstructions",
  "agents.move",
  "agents.setTopic",
  "agents.clearTopic",
  "rooms.swapDesks",
  "agents.sendMessage",
  "agents.respondInteraction",
  "agents.listScheduledMessages",
  "agents.cancelScheduledMessage",
  "agents.editMessage",
  "agents.cancelQueued",
  "agents.sendNow",
  "agents.newConversation",
  "agents.handoff",
  "agents.resume",
  "agents.listSessions",
  "agents.logs",
  "agents.openFile",
  "agents.saveFile",
  "agents.closeFile",
  "agents.upload",
  "agents.getFile",
  "rooms.create",
  "rooms.close",
  "rooms.rename",
  "rooms.getSettings",
  "rooms.setSettings",
  "userEnv.get",
  "userEnv.replace",
  "userEnv.names",
  "officeEnv.get",
  "officeEnv.replace",
  "apiTokenInbox.drain",
  "validate.cwd",
  "backends.listModels",
  "tasks.list",
  "tasks.get",
  "tasks.create",
  "tasks.update",
  "tasks.claim",
  "tasks.done",
  "tasks.delete",
  "apps.list",
  "apps.get",
  "apps.preview",
  "apps.register",
  "apps.update",
  "apps.delete",
  "apps.logs",
  "apps.start",
  "apps.stop",
  "apps.restart",
  "memory.read",
  "memory.append",
  "memory.replace",
  "skills.usageCounts",
  "cron.list",
  "cron.get",
  "cron.create",
  "cron.update",
  "cron.delete",
  "cron.runNow",
  "cron.listRuns",
  "cron.listAllRuns",
  "cron.getRun",
  "cron.runMessage",
  "cron.editRunMessage",
  "system.backupStatus",
  "system.version",
  "storage.usage",
  "usage.read",
];

describe("route table: an API identity authorizes exactly the remote-boss surface", () => {
  const apiIdentity: Identity = {
    scope: "api",
    userId: "u-owner",
    role: "owner",
    apiTokenId: "pat-1",
    apiTokenName: "Laptop",
    capabilities: API_CAPABILITIES,
  };
  const deps: GuardDeps = {
    hasRoomAccess: () => true,
    roomIdForAgent: () => "r1",
    userIdForUsername: () => "u-owner",
    cronjobCreatorUserId: () => "u-owner",
    appOwnerUserId: () => "u-owner",
    isOfficeOwnerUserId: () => true,
    agentManagerUserId: () => "u-owner",
    killedAgentManagerUserId: () => "u-owner",
  };
  it("reaches the independently declared operational routes", () => {
    const allowed: string[] = [];
    for (const route of API_ROUTES) {
      const outcome = runAuthorize(
        route.auth,
        apiIdentity,
        {
          id: "a-1",
          name: "hello",
          username: "alice",
          roomId: "r1",
          scheduledId: "s1",
          runId: "run-1",
        },
        {
          text: "hi",
          senderAgentId: "a-1",
          roomId: "r1",
          targetRoomId: "r1",
          username: "alice",
        },
        deps,
      );
      if (outcome.ok) allowed.push(route.opId);
    }
    expect(allowed).toEqual(API_REACHABLE_OPIDS);
  });
});
