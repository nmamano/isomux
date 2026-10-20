// The settings notice: a settings change that the same conversation continues
// with (a process restart, or a working folder change on a dormant Claude
// agent) tells the agent, on its next turn, what changed and who changed it.
// The chat shows the same text to members. Armed in agent-manager (editAgent
// and the /model and /effort swaps), delivered once by runAgentTurn as its own
// settings-notice block.
//
// The arm keeps raw values and renders as message parts, like
// dormantWakeMessage: each member reads their language, the agent English. Values render with the
// edit dialog's words, never internal ids.

import type { MessageKey, PlainMessageKey } from "../shared/i18n/translate.ts";
import {
  joinLogText,
  msg,
  type LogMessage,
  type LogParam,
  type LogPart,
  type LogText,
} from "../shared/i18n/log-message.ts";
import {
  effortLabelParam,
  familyDisplayLabel,
  type AgentInfo,
} from "../shared/types.ts";

// Render order of the change lines.
export const SETTINGS_NOTICE_FIELDS = [
  "modelFamily",
  "effort",
  "permissionMode",
  "codexSandbox",
  "cwd",
] as const;
export type SettingsNoticeField = (typeof SETTINGS_NOTICE_FIELDS)[number];

export interface SettingsNoticeChange {
  from: string;
  to: string;
  // cwd only: the path as the member typed it (`to` is the resolved path).
  typedTo?: string;
}

export interface SettingsNoticeArm {
  changes: Partial<Record<SettingsNoticeField, SettingsNoticeChange>>;
  // Who changed the settings, in order, without repeats.
  by: string[];
  // A restart stopped a running turn.
  interrupted: boolean;
}

// A second edit before the next turn merges into the pending notice: the latest
// value wins and the oldest old value stays. A setting that is back at its old
// value drops out. Null when nothing is left to tell.
export function mergeSettingsNotice(
  prev: SettingsNoticeArm | null,
  next: SettingsNoticeArm,
): SettingsNoticeArm | null {
  const changes = { ...(prev?.changes ?? {}) };
  for (const field of SETTINGS_NOTICE_FIELDS) {
    const change = next.changes[field];
    if (!change) continue;
    const from = changes[field]?.from ?? change.from;
    if (from === change.to) delete changes[field];
    else changes[field] = { ...change, from };
  }
  const interrupted = (prev?.interrupted ?? false) || next.interrupted;
  if (Object.keys(changes).length === 0 && !interrupted) return null;
  return {
    changes,
    by: [...new Set([...(prev?.by ?? []), ...next.by])],
    interrupted,
  };
}

const PERMISSION_KEYS: Record<
  AgentInfo["agentType"],
  Record<string, MessageKey>
> = {
  claude: {
    auto: "dialogs.agent.permission.claudeAuto",
    default: "dialogs.agent.permission.claudeDefault",
    acceptEdits: "dialogs.agent.permission.claudeAcceptEdits",
    bypassPermissions: "common.permission.claudeBypass",
  },
  codex: {
    untrusted: "dialogs.agent.permission.codexUntrusted",
    "on-request": "dialogs.agent.permission.codexOnRequest",
    never: "common.permission.codexNever",
  },
  opencode: {
    default: "dialogs.agent.permission.ask",
    bypassPermissions: "dialogs.agent.permission.bypassAll",
  },
};

const SANDBOX_KEYS: Record<string, MessageKey> = {
  "read-only": "common.sandbox.readOnly",
  "workspace-write": "common.sandbox.workspaceWrite",
  "danger-full-access": "common.sandbox.dangerFullAccess",
};

type NoticeAgent = Pick<AgentInfo, "agentType" | "claudeFamilyModels">;

function fieldLabel(
  agent: NoticeAgent,
  field: SettingsNoticeField,
): LogMessage {
  switch (field) {
    case "modelFamily":
      return msg("common.field.model");
    case "effort":
      return msg("common.field.effort");
    case "permissionMode":
      return agent.agentType === "codex"
        ? msg("common.field.approvalPolicy")
        : msg("common.field.permissionMode");
    case "codexSandbox":
      return msg("common.field.sandbox");
    case "cwd":
      return msg("common.field.workingDirectory");
  }
}

function valueLabel(
  agent: NoticeAgent,
  field: SettingsNoticeField,
  value: string,
): LogParam {
  // A value with no catalog words renders as itself.
  const keyed = (key: MessageKey | undefined): LogParam =>
    key ? msg(key as PlainMessageKey) : value;
  switch (field) {
    case "modelFamily":
      return familyDisplayLabel(value, agent.claudeFamilyModels);
    case "effort":
      return effortLabelParam(value);
    case "permissionMode":
      return keyed(PERMISSION_KEYS[agent.agentType]?.[value]);
    case "codexSandbox":
      return keyed(SANDBOX_KEYS[value]);
    case "cwd":
      return value;
  }
}

// `rejectionProven`: the agent's transcript shows that the restart forged a
// "user rejected" result (shutdownRejectionClause in agent-manager).
export function renderSettingsNotice(
  arm: SettingsNoticeArm,
  agent: NoticeAgent,
  rejectionProven: boolean,
): LogPart[] {
  const lines: LogText[] = [
    msg("systemEntries.settingsNotice.changed", { names: arm.by.join(", ") }),
  ];
  for (const field of SETTINGS_NOTICE_FIELDS) {
    const change = arm.changes[field];
    if (!change) continue;
    lines.push(
      msg("systemEntries.settingsNotice.change", {
        setting: fieldLabel(agent, field),
        from: valueLabel(agent, field, change.from),
        to: valueLabel(agent, field, change.typedTo ?? change.to),
      }),
    );
  }
  if (arm.interrupted) {
    const parts: LogText[] = [
      msg("systemEntries.settingsNotice.interrupted"),
      msg("systemEntries.wake.inFlightWarning"),
    ];
    if (rejectionProven)
      parts.push(msg("systemEntries.wake.shutdownRejection"));
    lines.push(joinLogText(parts, " "));
  }
  return joinLogText(lines, "\n");
}
