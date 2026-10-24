// Phase 2.3 - Event registry contract tests (TDD red→green for NEW code).
//
// The registry is what the Phase-2 Reviewer4 security gate reads for audience
// leaks, so these assertions ARE the gate's machine-checkable surface: the
// declared audience of every event (including the leak-prone `all` class) and
// the audience↔projectionKey consistency that makes projectionKey executable.
//
// Pure T0: no server, no FS, no LLM.

import { describe, it, expect } from "bun:test";
import {
  EVENT_REGISTRY,
  type AudienceStrategy,
  type EventId,
  type EventPayloads,
  type RegistryEvent,
} from "../events/registry.ts";
import type { ServerMessage } from "../../shared/types.ts";

// The spec's event id → audience map (Server API Spec → Event registry). The
// registry must match this EXACTLY - a drift in either direction fails here.
const SPEC_AUDIENCES: Record<string, AudienceStrategy> = {
  api_token_log_entry: "api-token",
  // Live agent / room stream - room-ACL
  log_entry: "room-ACL",
  // The fence at the end of ONE socket's connect-time replay: recipient-scoped
  // even though it follows room-ACL'd log_entry frames, because it terminates a
  // per-socket burst and carries nothing to project.
  log_replay_complete: "recipient-scoped",
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
  room_pet_updated: "room-ACL",
  room_skin_updated: "room-ACL",
  room_decor_updated: "room-ACL",
  room_back_room_updated: "room-ACL",
  room_cwd_updated: "room-ACL",
  // State / projection
  session_context: "recipient-scoped",
  full_state: "recipient-scoped",
  all_rooms_list: "owners",
  room_order_updated: "recipient-scoped",
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
  // Members chat: every socket is a human's, so `all` is the exact audience;
  // the read pointer is the recipient's own.
  members_chat_message: "all",
  members_chat_deleted: "all",
  members_chat_read: "recipient-scoped",
  tasks: "recipient-scoped",
  task_upserted: "recipient-scoped",
  task_deleted: "recipient-scoped",
  // Ownership-scoped, delivered per socket: an app is visible to its owning
  // user and to office owners, never to the office.
  app_upserted: "recipient-scoped",
  app_deleted: "recipient-scoped",
  // Per socket by access to the page's source room, like task_upserted.
  pager_upserted: "recipient-scoped",
  ask_upserted: "recipient-scoped",
  ask_removed: "recipient-scoped",
  webhook_upserted: "recipient-scoped",
  webhook_deleted: "recipient-scoped",
  // Cronjobs and their runs are per-recipient (maker, office owners, members
  // of the job's live room); the shared cron prompt stays office-wide.
  cronjobs_state: "recipient-scoped",
  cronjob_added: "recipient-scoped",
  cronjob_updated: "recipient-scoped",
  cronjob_deleted: "recipient-scoped",
  cronjobs_prompt_updated: "all",
  cronjob_run_updated: "recipient-scoped",
  cron_run_log_entry: "recipient-scoped",
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
  // toEqual on the record pins the id set as well as each audience.
  it("declares exactly the spec's events, each with the spec's audience", () => {
    const actual: Record<string, AudienceStrategy> = {};
    for (const id of eventIds) actual[id] = EVENT_REGISTRY[id].audience;
    expect(actual).toEqual(SPEC_AUDIENCES);
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
      // Widen off the `satisfies` literal narrowing.
      const reg: RegistryEvent = EVENT_REGISTRY[id];
      const kind = reg.projectionKey.kind;
      switch (reg.audience) {
        case "api-token":
          expect(kind).toBe("apiTokenId");
          break;
        case "all":
          expect(kind).toBe("all");
          break;
        case "owners":
          expect(kind).toBe("owners");
          break;
        case "room-ACL":
          expect(ROOM_ACL_KINDS.has(kind)).toBe(true);
          break;
        case "recipient-scoped":
          // Must carry a CONCRETE recipient key - the anti-fanout-fallback rail.
          expect(["connectionId", "userId"]).toContain(kind);
          break;
      }
    }
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
