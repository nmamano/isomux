// Phase 2.3 - Event registry contract tests (TDD red→green for NEW code).
//
// The registry is what the Phase-2 Reviewer4 security gate reads for audience
// leaks, so these assertions ARE the gate's machine-checkable surface: the
// declared audience of every event, the frozen `all` allowlist (the leak-prone
// class), the audience↔projectionKey consistency that makes projectionKey
// executable, and the intentional delta vs today's live wire.
//
// Pure T0: no server, no FS, no LLM.

import { describe, it, expect } from "bun:test";
import {
  EVENT_REGISTRY,
  ALL_AUDIENCE_ALLOWLIST,
  RETIRED_WIRE_MESSAGES,
  REGISTRY_RENAMED_FROM_WIRE,
  isEventId,
  type AudienceStrategy,
  type EventId,
  type EventPayloads,
  type RegistryEvent,
} from "../events/registry.ts";
import type { ServerMessage } from "../../shared/types.ts";

// The spec's event id → audience map (Server API Spec → Event registry). The
// registry must match this EXACTLY - a drift in either direction fails here.
const SPEC_AUDIENCES: Record<string, AudienceStrategy> = {
  // Live agent / room stream - room-ACL
  log_entry: "room-ACL",
  // The fence at the end of ONE socket's connect-time replay: recipient-scoped
  // even though it follows room-ACL'd log_entry frames, because it terminates a
  // per-socket burst and carries nothing to project.
  log_replay_complete: "recipient-scoped",
  slide_ready: "room-ACL",
  slide_failed: "room-ACL",
  clear_logs: "room-ACL",
  slash_commands: "room-ACL",
  agent_added: "room-ACL",
  agent_removed: "room-ACL",
  agent_updated: "room-ACL",
  interaction_added: "room-ACL",
  interaction_removed: "room-ACL",
  killed_agent_added: "room-ACL",
  killed_agent_removed: "room-ACL",
  terminal_output: "room-ACL",
  terminal_status: "room-ACL",
  terminal_exit: "room-ACL",
  room_created: "room-ACL",
  room_closed: "room-ACL",
  room_renamed: "room-ACL",
  room_settings_updated: "room-ACL",
  // State / projection
  session_context: "recipient-scoped",
  full_state: "recipient-scoped",
  all_rooms_list: "owners",
  presence_list: "recipient-scoped",
  provider_accounts_updated: "recipient-scoped",
  editor_external_change: "recipient-scoped",
  // Editor file lifecycle (task 1ed49547): the watch's confirmed-deletion
  // push, same single-socket scoping as editor_external_change.
  editor_file_deleted: "recipient-scoped",
  session_expired: "recipient-scoped",
  // Office-wide - all
  users_list: "all",
  user_updated: "all",
  // Owners-audience full admin records + recipient-scoped self record (3b.5).
  users_admin_list: "owners",
  user_admin_updated: "owners",
  user_self_updated: "recipient-scoped",
  // Room-scoped board: per-recipient projected (accessible rooms ∪ globals),
  // delivered by a per-socket loop like presence_list - NOT an `all` broadcast.
  // `tasks` is whole-board hydration; the two deltas carry a single mutation and
  // are per-recipient for the same reason (task b13445e2).
  tasks: "recipient-scoped",
  task_upserted: "recipient-scoped",
  task_deleted: "recipient-scoped",
  // Ownership-scoped, delivered per socket: an app is visible to its owning
  // user and to office owners, never to the office.
  app_upserted: "recipient-scoped",
  app_deleted: "recipient-scoped",
  cronjobs_state: "all",
  cronjob_added: "all",
  cronjob_updated: "all",
  cronjob_deleted: "all",
  cronjobs_prompt_updated: "all",
  cronjob_run_updated: "all",
  cron_run_log_entry: "all",
  office_settings_updated: "all",
  update_status: "all",
  // Auth-sensitive
  session_revoked: "owners",
  invite_revoked: "owners",
  invites_list: "recipient-scoped",
  sessions_active_list: "recipient-scoped",
};

const eventIds = Object.keys(EVENT_REGISTRY) as EventId[];

describe("event registry: matches the spec exactly", () => {
  it("declares exactly the spec's event ids", () => {
    expect(new Set<string>(eventIds)).toEqual(
      new Set(Object.keys(SPEC_AUDIENCES)),
    );
  });
  it("declares the spec's audience for every event", () => {
    const actual: Record<string, AudienceStrategy> = {};
    for (const id of eventIds) actual[id] = EVENT_REGISTRY[id].audience;
    expect(actual).toEqual(SPEC_AUDIENCES);
  });
});

describe("event registry: `all` is a frozen, reviewed allowlist (leak class)", () => {
  it("the audience:'all' set is EXACTLY the allowlist", () => {
    const allEvents = new Set(
      eventIds.filter((id) => EVENT_REGISTRY[id].audience === "all"),
    );
    expect(allEvents).toEqual(new Set(ALL_AUDIENCE_ALLOWLIST));
  });
  it("every allowlist entry is a real registry event", () => {
    for (const id of ALL_AUDIENCE_ALLOWLIST) expect(isEventId(id)).toBe(true);
  });
});

describe("event registry: audience ↔ projectionKey consistency (executable key)", () => {
  const ROOM_ACL_KINDS = new Set([
    "carriedRoomId",
    "agentLookup",
    "agentInfoLookup",
    "agentMove",
  ]);
  it("every event's projectionKey kind matches its audience", () => {
    for (const id of eventIds) {
      // Widen off the `satisfies` literal narrowing so the exhaustive switch
      // can name the reserved `none`/`by-user` arms (proven unused elsewhere).
      const reg: RegistryEvent = EVENT_REGISTRY[id];
      const kind = reg.projectionKey.kind;
      switch (reg.audience) {
        case "all":
          expect(kind).toBe("all");
          break;
        case "owners":
          expect(kind).toBe("owners");
          break;
        case "none":
          expect(kind).toBe("none");
          break;
        case "room-ACL":
          expect(ROOM_ACL_KINDS.has(kind)).toBe(true);
          break;
        case "recipient-scoped":
          // Must carry a CONCRETE recipient key - the anti-fanout-fallback rail.
          expect(["connectionId", "userId"]).toContain(kind);
          break;
        case "by-user":
          expect(kind).toBe("userId");
          break;
      }
    }
  });
});

describe("event registry: reserved strategies are unused", () => {
  // by-user and none are in the lattice but no current event uses them - a
  // future event must opt in deliberately, never inherit a default.
  it("no event declares audience 'by-user' or 'none'", () => {
    for (const id of eventIds) {
      expect(["by-user", "none"]).not.toContain(EVENT_REGISTRY[id].audience);
    }
  });
});

describe("event registry: intentional delta vs today's live wire", () => {
  it("retired wire messages are NOT registry events (folded into HTTP responses)", () => {
    for (const msg of RETIRED_WIRE_MESSAGES) expect(isEventId(msg)).toBe(false);
  });
  it("rooms_reordered is retired entirely (per-user view pref now)", () => {
    expect(RETIRED_WIRE_MESSAGES).toContain("rooms_reordered");
    expect(isEventId("rooms_reordered")).toBe(false);
  });
  it("documents the renamed/new events (tasks_changed→tasks, new cron_run_log_entry)", () => {
    const renamed = new Set(REGISTRY_RENAMED_FROM_WIRE.map((r) => r.event));
    expect(renamed.has("tasks")).toBe(true);
    expect(renamed.has("cron_run_log_entry")).toBe(true);
    // The new/renamed events ARE in the registry.
    expect(isEventId("tasks")).toBe(true);
    expect(isEventId("cron_run_log_entry")).toBe(true);
  });
});

// Registry ↔ wire shape sync (users-page follow-up 8e882cd4). presence_list is
// sent through a direct per-socket ws.send (not the typed emit path), so tsc
// never forces its EventPayloads entry to match the ServerMessage variant -
// the two silently diverged when onlineUserIds was first added. These
// COMPILE-TIME mutual-assignability checks (enforced by `tsc --noEmit`, which
// covers test files) fail if either side gains or loses a field the other
// lacks; the runtime expects only keep the test from being empty.
describe("event registry ↔ ServerMessage shape sync", () => {
  it("presence_list payload matches the wire variant in both directions", () => {
    type Registry = EventPayloads["presence_list"] & {
      type: "presence_list";
    };
    type Wire = Extract<ServerMessage, { type: "presence_list" }>;
    const toWire = (p: Registry): Wire => p;
    const toRegistry = (w: Wire): Registry => w;
    expect(typeof toWire).toBe("function");
    expect(typeof toRegistry).toBe("function");
  });
});
