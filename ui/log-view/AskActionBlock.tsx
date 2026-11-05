// The action of an action ask (task e3d1bc63): its target, the value now,
// read live from the office state, and the value asked for, with what that
// value gives. Apply runs it as the member (POST /api/asks/:askId/action). A
// refusal shows here and the ask stays open; the server closes the ask when
// the state reaches the value, by Apply or by hand, so after a run Apply
// stays off until the card goes.
//
// Kinds: an agent's access stop (agent-access), one room of a member's room
// access (member-room) and a member's role (member-role).

import { useRef, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "../api.ts";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { AGENT_PACK_AREAS, agentAccessOf } from "../../shared/agent-access.ts";
import type { ActionStepRequest } from "../../shared/types.ts";
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

// What a kind draws: the target's name, the value now (undefined when the
// state does not hold it), the value asked for, the lines under them, the
// data-* marks, and whether the target is gone.
interface ActionView {
  name: string;
  current?: { value: string; label: string };
  requested: { value: string; label: string };
  lines: ReactNode[];
  marks: Record<string, string>;
  gone: string | null;
}

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
  const { agents, users, rooms, allRooms } = useAppState();
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

  const view =
    step.kind === "agent-access"
      ? agentAccessView(step)
      : step.kind === "member-room"
        ? memberRoomView(step)
        : memberRoleView(step);

  return (
    <div
      data-ask-action=""
      {...(view.current
        ? { "data-ask-action-current": view.current.value }
        : {})}
      data-ask-action-requested={view.requested.value}
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
        <span data-ask-action-to="" style={{ fontWeight: 600 }}>
          {view.requested.label}
        </span>
      </div>
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
