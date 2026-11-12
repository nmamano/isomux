// The area of each push to a browser socket (task 134b8f77). A member with a
// permission pack gets a push only when the pack has every area it names at
// read or above; "none-for-packs" never reaches a pack holder. Keyed on the
// wire union and the registry's event ids, so a new push does not compile
// without an entry.

import type { ApiTokenArea } from "../shared/api-token-limits.ts";
import type { MemberPack } from "../shared/pack-fit.ts";
import type { AgentEvent } from "./internal-types.ts";
import type { ServerMessage } from "../shared/types.ts";
import type { EventId } from "./events/registry.ts";

// The agent event bridge (office-event-fanout.ts) forwards AgentEvents as is.
export type WsPushKind = ServerMessage["type"] | EventId | AgentEvent["type"];

// One frame of a lazy run (the connect replay), with its push kind.
export interface WsFrame {
  kind: WsPushKind;
  data: string;
}

export type WsPushArea =
  | "always"
  | "none-for-packs"
  | ApiTokenArea
  | readonly ApiTokenArea[];

export const WS_PUSH_AREA = {
  agent_added: "agents",
  agent_removed: "agents",
  agent_updated: "agents",
  all_rooms_list: "none-for-packs",
  api_token_log_entry: "none-for-packs",
  app_deleted: "apps",
  app_upserted: "apps",
  ask_removed: "asks",
  ask_upserted: "asks",
  clear_logs: "logs",
  cron_run_log_entry: ["logs", "schedules"],
  cronjob_added: "schedules",
  cronjob_deleted: "schedules",
  cronjob_run_updated: "schedules",
  cronjob_updated: "schedules",
  cronjobs_prompt_updated: "schedules",
  cronjobs_state: "schedules",
  discord_status: "environment",
  dm_deleted: "directMessages",
  dm_message: "directMessages",
  dm_read: "directMessages",
  editor_external_change: "files",
  editor_file_deleted: "files",
  floors_updated: "office",
  full_state: "always",
  interaction_added: "agents",
  interaction_removed: "agents",
  invite_revoked: "none-for-packs",
  invites_list: "always",
  killed_agent_added: "agentManagement",
  killed_agent_removed: "agentManagement",
  log_entry: "logs",
  log_replay_complete: "always",
  log_open_done: "logs",
  members_chat_deleted: "membersChat",
  members_chat_message: "membersChat",
  members_chat_read: "membersChat",
  office_settings_updated: "office",
  others_ask_removed: "none-for-packs",
  others_ask_upserted: "none-for-packs",
  pong: "always",
  presence_list: "office",
  provider_accounts_updated: "environment",
  removed_members: "none-for-packs",
  room_closed: "always",
  room_created: "always",
  room_cwd_updated: "rooms",
  room_decor_updated: "always",
  room_order_updated: "always",
  room_pet_updated: "always",
  room_renamed: "always",
  room_settings_updated: "rooms",
  room_skin_updated: "always",
  session_context: "always",
  session_expired: "always",
  session_revoked: "none-for-packs",
  sessions_active_list: "always",
  slash_commands: "agents",
  task_deleted: "tasks",
  task_upserted: "tasks",
  tasks: "tasks",
  tasks_changed: "tasks",
  terminal_exit: "none-for-packs",
  terminal_output: "none-for-packs",
  terminal_status: "none-for-packs",
  ui_build: "always",
  update_status: "always",
  user_admin_updated: "none-for-packs",
  user_self_updated: "always",
  user_updated: "always",
  users_admin_list: "none-for-packs",
  users_list: "always",
  webhook_deleted: "webhooks",
  webhook_upserted: "webhooks",
  whatsapp_status: "environment",
} as const satisfies Record<WsPushKind, WsPushArea>;

// Whether a socket of a member with `pack` gets a push of `kind`. No pack:
// every push.
export function pushAllowedForPack(
  pack: MemberPack | undefined,
  kind: WsPushKind,
): boolean {
  if (!pack) return true;
  const area: WsPushArea | undefined = Object.hasOwn(WS_PUSH_AREA, kind)
    ? WS_PUSH_AREA[kind]
    : undefined;
  if (area === undefined || area === "none-for-packs") return false;
  if (area === "always") return true;
  const areas = typeof area === "string" ? [area] : area;
  return areas.every((a) => pack.areas[a] !== undefined);
}
