// Phase 2.3 — Route table contract tests (TDD red→green for NEW code).
//
// Structural invariants over the typed route table (the skeleton that REPLACES
// the dispatchCommand switch in Phase 3): unique opIds + method/path, every
// `emits` resolves to a registry event, every capability route has a valid
// capability + guard, and — the carried-forward 2.2 caution — a `public` route
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
import {
  USER_CAPABILITIES,
  AGENT_CAPABILITIES,
  RUN_CAPABILITIES,
  type Capability,
} from "../identity/index.ts";
import type { GuardDeps } from "../identity/guards.ts";

const ALL_CAPS = new Set<Capability>([
  ...USER_CAPABILITIES,
  ...AGENT_CAPABILITIES,
  ...RUN_CAPABILITIES,
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
  it("agents.sendMessage requires agent:converse | agent:send-as-self", () => {
    expect(new Set(capsOf(route("agents.sendMessage").auth))).toEqual(
      new Set<Capability>(["agent:converse", "agent:send-as-self"]),
    );
  });
  it("users.update requires user:self | user:admin", () => {
    expect(new Set(capsOf(route("users.update").auth))).toEqual(
      new Set<Capability>(["user:self", "user:admin"]),
    );
  });
});

describe("route table: public routes are routed AROUND authorize()", () => {
  it("every API route is authenticated/capability — none public", () => {
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
      agentManagerUserId: () => null,
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
      "cron.runReadFile",
      "system.backupStatus",
    ]) {
      expect(opIds.has(expected)).toBe(true);
    }
  });
});

// The spec's per-route capability + emits, restated INDEPENDENTLY (like
// event-registry's SPEC_AUDIENCES). The table must match this exactly — a
// wrong-but-VALID emit or capability (a regression neither isEventId nor
// ALL_CAPS can catch) fails here. `caps: []` marks an `authenticated`-kind
// route (identity required, no capability).
const SPEC_ROUTE_CONTRACT: Record<
  string,
  { caps: Capability[]; emits: EventId[] }
> = {
  // Agents — lifecycle
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
  "agents.setPrivileged": {
    caps: ["agent:privilege"],
    emits: ["agent_updated"],
  },
  "agents.move": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "agents.setTopic": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "agents.clearTopic": { caps: ["agent:manage"], emits: ["agent_updated"] },
  "rooms.swapDesks": { caps: ["agent:manage"], emits: ["agent_updated"] },
  // Agents — conversation
  "agents.sendMessage": {
    caps: ["agent:converse", "agent:send-as-self"],
    emits: ["log_entry"],
  },
  "agents.editMessage": { caps: ["agent:converse"], emits: ["log_entry"] },
  "agents.cancelQueued": { caps: ["agent:converse"], emits: [] },
  // Agents — scheduled messages (task 8ff369b5). Same any-of pair as
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
  "agents.newConversation": { caps: ["agent:converse"], emits: ["clear_logs"] },
  "agents.resume": { caps: ["agent:converse"], emits: ["log_entry"] },
  "agents.listSessions": { caps: ["office:read"], emits: [] },
  // Agents — self-affordances
  "agents.readFile": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.diff": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.editFile": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.terminalCommand": { caps: ["self:affordance"], emits: ["log_entry"] },
  "agents.previewUrl": { caps: ["self:affordance"], emits: ["log_entry"] },
  // Agents — editor
  "agents.openFile": {
    caps: ["editor:use"],
    emits: ["editor_external_change"],
  },
  "agents.saveFile": { caps: ["editor:use"], emits: [] },
  "agents.closeFile": { caps: ["editor:use"], emits: [] },
  // Agents — uploads / files
  "agents.upload": { caps: ["file:upload"], emits: [] },
  "agents.getFile": { caps: ["office:read"], emits: [] },
  // Rooms
  "rooms.create": { caps: ["room:manage"], emits: ["room_created"] },
  "rooms.close": {
    caps: ["room:manage"],
    emits: ["room_closed", "user_updated", "users_list"],
  },
  "rooms.rename": { caps: ["room:manage"], emits: ["room_renamed"] },
  "rooms.setSettings": {
    caps: ["room:manage"],
    emits: ["room_settings_updated"],
  },
  // View preferences
  "view.setOrder": { caps: ["view:manage"], emits: ["full_state"] },
  "view.setNotifRooms": { caps: ["view:manage"], emits: ["user_updated"] },
  "view.setDefaultRoom": { caps: ["view:manage"], emits: ["user_updated"] },
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
  // Memory (isomux-memory)
  "memory.read": { caps: ["memory:read"], emits: [] },
  "memory.append": { caps: ["memory:write"], emits: [] },
  "memory.replace": { caps: ["memory:write"], emits: [] },
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
