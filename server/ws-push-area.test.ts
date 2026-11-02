// The push filter for members with a permission pack (task 134b8f77, part 3):
// a pack holder gets a push only when the pack has every area the push names
// at read or above. The terminal streams and the owner-only pushes never reach
// a pack holder, whatever the pack; a kind the table does not know is dropped.
// The wiring (every frame to a browser socket goes through the filter) is
// server/test-support/member-pack-ws.test.ts.

import { describe, expect, it } from "bun:test";
import {
  pushAllowedForPack,
  WS_PUSH_AREA,
  type WsPushKind,
} from "./ws-push-area.ts";
import { API_TOKEN_AREAS } from "../shared/api-token-limits.ts";
import type { MemberPack } from "../shared/pack-fit.ts";

const KINDS = Object.keys(WS_PUSH_AREA) as WsPushKind[];

const pack = (areas: MemberPack["areas"]): MemberPack => ({
  areas,
  agentCeiling: "chat",
});
// Every area at write: the widest pack there is.
const WIDEST = pack(
  Object.fromEntries(API_TOKEN_AREAS.map((a) => [a, "write"])),
);

describe("pushAllowedForPack", () => {
  it("a member with no pack gets every push", () => {
    expect(KINDS.filter((k) => !pushAllowedForPack(undefined, k))).toEqual([]);
  });

  it("the terminal streams and the owner-only pushes never reach a pack holder, even with every area", () => {
    const never: WsPushKind[] = [
      "terminal_output",
      "terminal_status",
      "terminal_exit",
      "all_rooms_list",
      "users_admin_list",
      "user_admin_updated",
      "others_ask_upserted",
      "others_ask_removed",
    ];
    expect(never.filter((k) => pushAllowedForPack(WIDEST, k))).toEqual([]);
    // The enabling condition: the widest pack gets the area pushes.
    expect(pushAllowedForPack(WIDEST, "task_upserted")).toBe(true);
    expect(pushAllowedForPack(WIDEST, "log_entry")).toBe(true);
  });

  it("a push reaches a pack holder only with its area, at read or write", () => {
    for (const [kind, area] of [
      ["task_upserted", "tasks"],
      ["log_entry", "logs"],
      ["agent_updated", "agents"],
      ["killed_agent_added", "agentManagement"],
      ["cronjob_added", "schedules"],
      ["webhook_upserted", "webhooks"],
      ["app_upserted", "apps"],
      ["members_chat_message", "membersChat"],
      ["ask_upserted", "asks"],
    ] as const) {
      const other = area === "tasks" ? "logs" : "tasks";
      expect({
        kind,
        read: pushAllowedForPack(pack({ [area]: "read" }), kind),
        write: pushAllowedForPack(pack({ [area]: "write" }), kind),
        without: pushAllowedForPack(pack({ [other]: "write" }), kind),
      }).toEqual({ kind, read: true, write: true, without: false });
    }
  });

  it("a schedule run's transcript needs both logs and schedules", () => {
    const kind: WsPushKind = "cron_run_log_entry";
    expect({
      logs: pushAllowedForPack(pack({ logs: "read" }), kind),
      schedules: pushAllowedForPack(pack({ schedules: "read" }), kind),
      both: pushAllowedForPack(pack({ logs: "read", schedules: "read" }), kind),
    }).toEqual({ logs: false, schedules: false, both: true });
  });

  it("the pushes every member needs reach a pack holder with any pack", () => {
    const narrow = pack({ tasks: "read" });
    for (const kind of [
      "session_context",
      "user_self_updated",
      "log_replay_complete",
      "pong",
      "session_expired",
      "ui_build",
    ] as const)
      expect({ kind, allowed: pushAllowedForPack(narrow, kind) }).toEqual({
        kind,
        allowed: true,
      });
  });

  it("a kind the table does not know is dropped for a pack holder", () => {
    const unknown = "not_a_push" as WsPushKind;
    expect(pushAllowedForPack(WIDEST, unknown)).toBe(false);
  });
});
