// The action of an action ask (task e3d1bc63): its target, the value now,
// read live from the office state, and the value asked for, with what that
// value gives. Apply runs it as the member (POST /api/asks/:askId/action). A
// refusal shows here and the ask stays open; the server closes the ask when
// the state reaches the value, by Apply or by hand, so after a run Apply
// stays off until the card goes.
//
// Kinds: an agent's access stop (agent-access), one room of a member's room
// access (member-room), a member's role (member-role) and permission pack
// (member-pack), the member's own preferences (member-preferences) and room
// lists (member-view), and the office and backup settings (office-settings,
// backup-settings). A kind that sets several keys draws one row per key.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { AGENT_PACK_AREAS, agentAccessOf } from "../../shared/agent-access.ts";
import type { ActionStepRequest } from "../../shared/types.ts";
import type {
  AccessibleRoomWire,
  BackupStatusWire,
} from "../../shared/contract-shapes.ts";
import { SUPPORTED_LANGUAGES } from "../../shared/languages.ts";
import { DEFAULT_VOICE_NAME } from "../../shared/voice.ts";
import type { PlainMessageKey } from "../../shared/i18n/translate.ts";
import { AREA_LABEL as PACK_AREA_LABEL } from "../components/AreaLevelsGrid.tsx";
import {
  AREA_LABEL,
  LEVEL_LABEL,
  STOP_HINT,
  STOP_LABEL,
} from "../components/AccessSlider.tsx";

type Step<K extends ActionStepRequest["kind"]> = Extract<
  ActionStepRequest,
  { kind: K }
>;

interface Value {
  value: string;
  label: string;
}

// One key of a kind that sets several: its label, the value now (undefined
// until it is read) and asked for, and what the setting does.
interface Row {
  key: string;
  label: string;
  current?: Value;
  requested: Value;
  hint?: string;
}

// What a kind draws: the target's name, the value now (undefined when the
// state does not hold it), the value asked for or one row per key, the lines
// under them, the data-* marks, and whether the target is gone.
interface ActionView {
  name: string;
  current?: Value;
  requested?: Value;
  rows?: Row[];
  lines: ReactNode[];
  marks: Record<string, string>;
  gone: string | null;
}

// The labels of the settings an office-settings step sets, with the page's
// hint for each switch that changes what agents or members get.
const OFFICE_LABEL: Record<string, PlainMessageKey> = {
  name: "settings.office.name",
  memberUsageCap: "settings.office.memberUsageCap",
  memberUsageShare: "settings.office.memberUsageShare",
  recordTerminals: "audit.recordTerminals",
  providerFallback: "settings.office.providerFallback",
  processIsolation: "settings.office.processIsolation",
  claudeIsomuxLabel: "settings.office.claudeIsomuxLabel",
};
const OFFICE_HINT: Record<string, PlainMessageKey> = {
  memberUsageCap: "settings.office.memberUsageCapHint",
  recordTerminals: "audit.recordTerminalsHint",
  providerFallback: "settings.office.providerFallbackHint",
  processIsolation: "settings.office.processIsolationHint",
  claudeIsomuxLabel: "settings.office.claudeIsomuxLabelHint",
};
const PREFERENCE_LABEL: Record<string, PlainMessageKey> = {
  language: "settings.sidebar.language",
  voiceInput: "integrations.voice.mic",
  voiceOutput: "integrations.voice.readAloud",
  voiceName: "integrations.voice.voiceName",
};
const BACKUP_LABEL: Record<string, PlainMessageKey> = {
  intervalHours: "settings.storage.backupInterval",
  retention: "settings.storage.backupCopies",
  dir: "settings.storage.backupFolder",
};
const VIEW_LABEL = {
  shown: "settings.room.viewLevel.shown",
  tucked: "settings.room.viewLevel.tucked",
  notif: "settings.room.viewLevel.notify",
  push: "settings.room.viewLevel.push",
} as const;
const VIEW_INFO = {
  shown: "settings.room.viewLevelInfo.shown",
  tucked: "settings.room.viewLevelInfo.tucked",
  notif: "settings.room.viewLevelInfo.notify",
  push: "settings.room.viewLevelInfo.push",
} as const;

export function AskActionBlock({
  askId,
  askingAgentId,
  memberUserId,
  step,
  isMobile,
}: {
  askId: string;
  askingAgentId: string;
  // The member the ask is for.
  memberUserId?: string;
  step: ActionStepRequest;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const { agents, users, rooms, allRooms, office } = useAppState();
  // The settings the state does not carry, read when the card shows: the
  // office settings (again on each office settings change), the backup
  // settings, and the member's rooms, hidden ones included.
  const read =
    step.kind === "office-settings"
      ? "/api/office/settings"
      : step.kind === "backup-settings"
        ? "/api/backup/status"
        : step.kind === "member-view"
          ? "/api/me/rooms"
          : null;
  const [fetched, setFetched] = useState<unknown>(undefined);
  useEffect(() => {
    if (!read) return;
    let live = true;
    apiFetch("GET", read)
      .then((res) => {
        if (live) setFetched(res);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [read, office]);
  // "running" while the POST is out, "ran" after a 2xx.
  const [phase, setPhase] = useState<"idle" | "running" | "ran">("idle");
  const [error, setError] = useState<string | null>(null);
  // One run at a time: a second click in the same frame still sees "idle".
  const running = useRef(false);
  const fontSize = isMobile ? 13 : 12;
  const small = isMobile ? 12 : 11;
  const muted = { color: "var(--text-muted)", fontSize: small };

  async function apply() {
    if (running.current) return;
    running.current = true;
    setPhase("running");
    setError(null);
    try {
      await apiFetch("POST", `/api/asks/${askId}/action`);
      setPhase("ran");
    } catch (err) {
      running.current = false;
      setPhase("idle");
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const memberById = (userId: string) =>
    [...users.values()].find((u) => u.id === userId);
  // The asking agent's manager: a change that widens their reach widens the
  // agent's too.
  const managerUserId = agents.find((a) => a.id === askingAgentId)?.userId;
  const managerLine = (userId: string) =>
    userId === managerUserId ? (
      <div key="manager" style={muted}>
        {t("asks.action.manager")}
      </div>
    ) : null;

  function agentAccessView(s: Step<"agent-access">): ActionView {
    const target = agents.find((a) => a.id === s.agentId);
    const current = target ? agentAccessOf(target) : null;
    const areas = s.pack?.areas
      ? AGENT_PACK_AREAS.filter((area) => s.pack?.areas?.[area])
      : [];
    const self = s.agentId === askingAgentId;
    return {
      name: target?.name ?? s.agentId,
      ...(current
        ? { current: { value: current, label: t(STOP_LABEL[current]) } }
        : {}),
      requested: { value: s.access, label: t(STOP_LABEL[s.access]) },
      lines: [
        <div key="hint" style={muted}>
          {t(STOP_HINT[s.access])}
        </div>,
        areas.length > 0 && (
          <div
            key="pack"
            data-ask-action-pack=""
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}
          >
            {areas.map((area) => (
              <span
                key={area}
                style={{
                  display: "inline-flex",
                  gap: 4,
                  padding: "1px 6px",
                  borderRadius: 6,
                  background: "var(--bg-surface)",
                  fontSize: small,
                }}
              >
                <span>{t(AREA_LABEL[area])}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {t(LEVEL_LABEL[s.pack!.areas![area]!])}
                </span>
              </span>
            ))}
          </div>
        ),
        self && (
          <div key="self" style={muted}>
            {t("asks.action.self")}
          </div>
        ),
      ],
      marks: self ? { "data-ask-action-self": "" } : {},
      gone: target ? null : t("asks.action.gone"),
    };
  }

  function memberRoomView(s: Step<"member-room">): ActionView {
    const member = memberById(s.userId);
    const room =
      rooms.find((r) => r.id === s.roomId) ??
      allRooms.find((r) => r.id === s.roomId);
    const label = (granted: boolean) =>
      granted ? t("asks.action.roomGranted") : t("asks.action.roomRemoved");
    // An owner reaches every room by rule. A member's rooms are in the full
    // record only (an owner's view).
    const has =
      member?.role === "owner"
        ? true
        : member?.allowedRooms
          ? member.allowedRooms.includes(s.roomId)
          : undefined;
    const widens = s.grant && s.userId === managerUserId;
    return {
      name: member?.name ?? s.userId,
      ...(has !== undefined
        ? {
            current: {
              value: has ? "granted" : "removed",
              label: label(has),
            },
          }
        : {}),
      requested: {
        value: s.grant ? "granted" : "removed",
        label: label(s.grant),
      },
      lines: [
        <div key="room" {...noTranslate()} style={{ fontSize: small }}>
          {room?.name ?? s.roomId}
        </div>,
        <div key="hint" style={muted}>
          {t(
            s.grant
              ? "asks.action.roomGrantHint"
              : "asks.action.roomRemoveHint",
          )}
        </div>,
        widens && managerLine(s.userId),
      ],
      marks: widens ? { "data-ask-action-manager": "" } : {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  function memberRoleView(s: Step<"member-role">): ActionView {
    const member = memberById(s.userId);
    const label = (role: "owner" | "member") =>
      role === "owner"
        ? t("asks.action.roleOwner")
        : t("asks.action.roleMember");
    const widens = s.role === "owner" && s.userId === managerUserId;
    const selfDemote = s.role === "member" && s.userId === memberUserId;
    return {
      name: member?.name ?? s.userId,
      ...(member
        ? { current: { value: member.role, label: label(member.role) } }
        : {}),
      requested: { value: s.role, label: label(s.role) },
      lines: [
        <div key="hint" style={muted}>
          {t(
            s.role === "owner"
              ? "settings.role.officeOwnerExplanation"
              : "asks.action.roleMemberHint",
          )}
        </div>,
        widens && managerLine(s.userId),
        selfDemote && (
          <div key="self-demote" style={{ fontSize: small }}>
            {t("asks.action.selfDemote")}
          </div>
        ),
      ],
      marks: {
        ...(widens ? { "data-ask-action-manager": "" } : {}),
        ...(selfDemote ? { "data-ask-action-self-demote": "" } : {}),
      },
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  const onOff = (on: boolean): Value => ({
    value: on ? "on" : "off",
    label: t(on ? "asks.action.on" : "asks.action.off"),
  });
  const setting = (value: unknown): Value => ({
    value: String(value),
    label:
      typeof value === "boolean"
        ? t(value ? "asks.action.on" : "asks.action.off")
        : String(value),
  });

  function memberPackView(s: Step<"member-pack">): ActionView {
    const member = memberById(s.userId);
    const packValue = (
      pack: { agentCeiling: keyof typeof STOP_LABEL } | null | undefined,
    ): Value =>
      pack
        ? {
            value: pack.agentCeiling,
            label: t("asks.action.packCeiling", {
              stop: t(STOP_LABEL[pack.agentCeiling]),
            }),
          }
        : { value: "none", label: t("asks.action.packNone") };
    // A member's pack is in the full record only (an owner's view).
    const known = member && member.allowedRooms !== undefined;
    const areas = s.pack
      ? (Object.keys(s.pack.areas) as (keyof typeof PACK_AREA_LABEL)[])
      : [];
    return {
      name: member?.name ?? s.userId,
      ...(known ? { current: packValue(member.pack) } : {}),
      requested: packValue(s.pack),
      lines: [
        areas.length > 0 && (
          <div
            key="pack"
            data-ask-action-pack=""
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}
          >
            {areas.map((area) => (
              <span
                key={area}
                style={{
                  display: "inline-flex",
                  gap: 4,
                  padding: "1px 6px",
                  borderRadius: 6,
                  background: "var(--bg-surface)",
                  fontSize: small,
                }}
              >
                <span>{t(PACK_AREA_LABEL[area])}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {t(LEVEL_LABEL[s.pack!.areas[area]!])}
                </span>
              </span>
            ))}
          </div>
        ),
        s.pack && (
          <div key="hint" style={muted}>
            {t("settings.memberPack.hint")}
          </div>
        ),
      ],
      marks: {},
      gone: member ? null : t("asks.action.memberGone"),
    };
  }

  // The member the ask is for: their own record.
  const self = memberUserId ? memberById(memberUserId) : undefined;

  function preferencesView(s: Step<"member-preferences">): ActionView {
    const label = (key: string, value: unknown): string => {
      if (key === "language")
        return value === null
          ? t("asks.action.languageNone")
          : (SUPPORTED_LANGUAGES.find((l) => l.code === value)?.label ??
              (typeof value === "string" ? value : ""));
      if (key === "voiceInput" || key === "voiceOutput")
        return t(
          value === "openai"
            ? "integrations.voice.openai"
            : "integrations.voice.browser",
        );
      return String(value);
    };
    // The values as they apply: a record with no voice value has the
    // default.
    const now: Record<string, unknown> | null = self
      ? {
          language: self.language ?? null,
          voiceInput: self.voiceInput ?? "browser",
          voiceOutput: self.voiceOutput ?? "browser",
          voiceName: self.voiceName ?? DEFAULT_VOICE_NAME,
        }
      : null;
    return {
      name: t("asks.action.yourPreferences"),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: t(PREFERENCE_LABEL[key] ?? "asks.action.yourPreferences"),
        ...(now
          ? {
              current: {
                value: String(now[key]),
                label: label(key, now[key]),
              },
            }
          : {}),
        requested: { value: String(value), label: label(key, value) },
      })),
      lines: [],
      marks: {},
      gone: null,
    };
  }

  function memberViewView(s: Step<"member-view">): ActionView {
    const fetchedRooms = Array.isArray(fetched)
      ? (fetched as AccessibleRoomWire[])
      : [];
    const room =
      fetchedRooms.find((r) => r.id === s.roomId) ??
      rooms.find((r) => r.id === s.roomId) ??
      allRooms.find((r) => r.id === s.roomId);
    const lists = self?.hidden
      ? {
          hidden: self.hidden,
          tucked: self.tucked ?? [],
          notif: self.notifRooms ?? [],
          push: self.pushRooms ?? [],
        }
      : null;
    const on = lists
      ? s.list === "shown"
        ? !lists.hidden.includes(s.roomId)
        : lists[s.list].includes(s.roomId)
      : undefined;
    const notified = !!lists?.notif.includes(s.roomId);
    const pushed = !!lists?.push.includes(s.roomId);
    // What the view core does with the room's alerts: hiding or tucking a
    // room stops them, notifications off stops the push, and a push turns
    // notifications on.
    const alertsStop =
      on !== undefined &&
      on !== s.on &&
      ((s.list === "shown" && !s.on) || (s.list === "tucked" && s.on)
        ? notified || pushed
        : s.list === "notif" && !s.on && pushed);
    const notifOn =
      on !== undefined && on !== s.on && s.list === "push" && s.on && !notified;
    return {
      name: room?.name ?? s.roomId,
      ...(on !== undefined ? { current: onOff(on) } : {}),
      requested: onOff(s.on),
      lines: [
        <div key="list" style={{ fontSize: small, fontWeight: 600 }}>
          {t(VIEW_LABEL[s.list])}
        </div>,
        <div key="info" style={muted}>
          {t(VIEW_INFO[s.list])}
        </div>,
        alertsStop && (
          <div key="alerts" style={muted}>
            {t("asks.action.alertsStop")}
          </div>
        ),
        notifOn && (
          <div key="notif" style={muted}>
            {t("asks.action.notifOn")}
          </div>
        ),
      ],
      marks: {
        ...(alertsStop ? { "data-ask-action-alerts-stop": "" } : {}),
        ...(notifOn ? { "data-ask-action-notif-on": "" } : {}),
      },
      gone: room ? null : t("asks.action.roomGone"),
    };
  }

  function officeSettingsView(s: Step<"office-settings">): ActionView {
    const now = (fetched ?? null) as Record<string, unknown> | null;
    const share = (value: unknown) =>
      t("settings.office.memberUsageShareOption", { share: String(value) });
    return {
      name: t("settings.office.title"),
      rows: Object.entries(s.set).map(([key, value]) => {
        const valueOf = (v: unknown): Value =>
          key === "memberUsageShare"
            ? { value: String(v), label: share(v) }
            : setting(v);
        const hint = OFFICE_HINT[key];
        return {
          key,
          label: t(OFFICE_LABEL[key] ?? "settings.office.title"),
          ...(now && key in now ? { current: valueOf(now[key]) } : {}),
          requested: valueOf(value),
          ...(hint ? { hint: t(hint) } : {}),
        };
      }),
      lines: [],
      marks: {},
      gone: null,
    };
  }

  function backupSettingsView(s: Step<"backup-settings">): ActionView {
    const status = (fetched ?? null) as BackupStatusWire | null;
    const now: Record<string, unknown> | null = status
      ? {
          intervalHours: status.intervalHours,
          retention: status.retention,
          dir: status.destDir,
        }
      : null;
    const valueOf = (key: string, v: unknown): Value =>
      key === "dir" && v === null
        ? { value: "null", label: t("asks.action.backupDefaultFolder") }
        : key === "intervalHours"
          ? {
              value: String(v),
              label: `${String(v)} ${t("settings.storage.backupHours")}`,
            }
          : setting(v);
    const movesFolder = "dir" in s.set;
    return {
      name: t("settings.storage.category.backups"),
      rows: Object.entries(s.set).map(([key, value]) => ({
        key,
        label: t(BACKUP_LABEL[key] ?? "settings.storage.category.backups"),
        ...(now ? { current: valueOf(key, now[key]) } : {}),
        requested: valueOf(key, value),
      })),
      lines: [
        movesFolder && (
          <div key="holds" style={muted}>
            {t("asks.action.backupHolds")}
          </div>
        ),
      ],
      marks: movesFolder ? { "data-ask-action-backup-holds": "" } : {},
      gone: null,
    };
  }

  const view = (() => {
    switch (step.kind) {
      case "agent-access":
        return agentAccessView(step);
      case "member-room":
        return memberRoomView(step);
      case "member-role":
        return memberRoleView(step);
      case "member-pack":
        return memberPackView(step);
      case "member-preferences":
        return preferencesView(step);
      case "member-view":
        return memberViewView(step);
      case "office-settings":
        return officeSettingsView(step);
      case "backup-settings":
        return backupSettingsView(step);
    }
  })();

  return (
    <div
      data-ask-action=""
      {...(view.current
        ? { "data-ask-action-current": view.current.value }
        : {})}
      {...(view.requested
        ? { "data-ask-action-requested": view.requested.value }
        : {})}
      {...view.marks}
      {...(view.gone !== null ? { "data-ask-action-gone": "" } : {})}
      style={{
        marginTop: 8,
        padding: isMobile ? "8px 10px" : "6px 10px",
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        fontSize,
        lineHeight: 1.5,
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          columnGap: 8,
          alignItems: "baseline",
        }}
      >
        <span {...noTranslate()} style={{ fontWeight: 600 }}>
          {view.name}
        </span>
        {view.current && (
          <span data-ask-action-from="" style={{ color: "var(--text-muted)" }}>
            {view.current.label}
          </span>
        )}
        {view.current && <span aria-hidden="true">→</span>}
        {view.requested && (
          <span data-ask-action-to="" style={{ fontWeight: 600 }}>
            {view.requested.label}
          </span>
        )}
      </div>
      {view.rows?.map((row) => (
        <div
          key={row.key}
          data-ask-action-key={row.key}
          {...(row.current
            ? { "data-ask-action-current": row.current.value }
            : {})}
          data-ask-action-requested={row.requested.value}
          style={{ marginTop: 2 }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 8,
              alignItems: "baseline",
            }}
          >
            <span>{row.label}</span>
            {row.current && (
              <span
                {...noTranslate()}
                style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}
              >
                {row.current.label}
              </span>
            )}
            {row.current && <span aria-hidden="true">→</span>}
            <span
              {...noTranslate()}
              style={{ fontWeight: 600, overflowWrap: "anywhere" }}
            >
              {row.requested.label}
            </span>
          </div>
          {row.hint && (
            <div data-ask-action-hint="" style={muted}>
              {row.hint}
            </div>
          )}
        </div>
      ))}
      {view.lines}
      {view.gone !== null ? (
        <div style={muted}>{view.gone}</div>
      ) : (
        <button
          type="button"
          data-ask-action-apply=""
          disabled={phase !== "idle"}
          onClick={() => void apply()}
          style={{
            marginTop: 6,
            padding: isMobile ? "8px 14px" : "5px 14px",
            borderRadius: 8,
            border: "none",
            background: "var(--accent-text)",
            color: "var(--bg-base)",
            fontSize: 12,
            fontWeight: 600,
            cursor: phase === "idle" ? "pointer" : "default",
            opacity: phase === "idle" ? 1 : 0.6,
          }}
        >
          {t("asks.action.apply")}
        </button>
      )}
      {error && (
        <div
          role="alert"
          style={{ marginTop: 6, color: "var(--red-text)", fontSize: small }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
