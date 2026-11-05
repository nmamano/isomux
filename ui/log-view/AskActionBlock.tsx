// The action of an action ask (task e3d1bc63): the target agent, its stop
// now, read live from the office state, and the stop asked for, with what
// that stop gives and its pack areas. Apply runs it as the member (POST
// /api/asks/:askId/action). A refusal shows here and the ask stays open; the
// server closes the ask when the agent reaches the grant, by Apply or by
// hand, so after a run Apply stays off until the card goes.

import { useRef, useState } from "react";
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

export function AskActionBlock({
  askId,
  askingAgentId,
  step,
  isMobile,
}: {
  askId: string;
  askingAgentId: string;
  step: ActionStepRequest;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const { agents } = useAppState();
  const target = agents.find((a) => a.id === step.agentId);
  // "running" while the POST is out, "ran" after a 2xx.
  const [phase, setPhase] = useState<"idle" | "running" | "ran">("idle");
  const [error, setError] = useState<string | null>(null);
  // One run at a time: a second click in the same frame still sees "idle".
  const running = useRef(false);
  const fontSize = isMobile ? 13 : 12;
  const small = isMobile ? 12 : 11;

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

  const current = target ? agentAccessOf(target) : null;
  const areas = step.pack?.areas
    ? AGENT_PACK_AREAS.filter((area) => step.pack?.areas?.[area])
    : [];
  return (
    <div
      data-ask-action=""
      {...(current ? { "data-ask-action-current": current } : {})}
      data-ask-action-requested={step.access}
      {...(step.agentId === askingAgentId
        ? { "data-ask-action-self": "" }
        : {})}
      {...(!target ? { "data-ask-action-gone": "" } : {})}
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
          {target?.name ?? step.agentId}
        </span>
        {current && (
          <span data-ask-action-from="" style={{ color: "var(--text-muted)" }}>
            {t(STOP_LABEL[current])}
          </span>
        )}
        {current && <span aria-hidden="true">→</span>}
        <span data-ask-action-to="" style={{ fontWeight: 600 }}>
          {t(STOP_LABEL[step.access])}
        </span>
      </div>
      <div style={{ color: "var(--text-muted)", fontSize: small }}>
        {t(STOP_HINT[step.access])}
      </div>
      {areas.length > 0 && (
        <div
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
                {t(LEVEL_LABEL[step.pack!.areas![area]!])}
              </span>
            </span>
          ))}
        </div>
      )}
      {step.agentId === askingAgentId && (
        <div style={{ color: "var(--text-muted)", fontSize: small }}>
          {t("asks.action.self")}
        </div>
      )}
      {!target ? (
        <div style={{ color: "var(--text-muted)", fontSize: small }}>
          {t("asks.action.gone")}
        </div>
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
