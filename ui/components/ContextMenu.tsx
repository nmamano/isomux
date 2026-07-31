import { useRef, useEffect } from "react";
import type {
  AgentInfo,
  SessionInfo,
  AgentBackendType,
} from "../../shared/types.ts";
import { useAppState, useDispatch, useFeatures } from "../store.tsx";
import { apiFetch } from "../api.ts";

interface ContextMenuProps {
  x: number;
  y: number;
  agent: AgentInfo;
  onClose: () => void;
  onEdit: (agent: AgentInfo) => void;
}

export function ContextMenu({
  x,
  y,
  agent,
  onClose,
  onEdit,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { sessionsList } = useAppState();
  const dispatch = useDispatch();
  const features = useFeatures();
  const sessionsData = sessionsList.get(agent.id);
  const sessions = sessionsData?.sessions ?? [];
  const currentSessionId = sessionsData?.currentSessionId ?? null;
  // The engine you can start a fresh conversation in without switching away from
  // the current one. Switching engine always starts a new conversation.
  const otherEngine: AgentBackendType =
    agent.agentType === "codex" ? "claude" : "codex";
  const otherEngineLabel = otherEngine === "codex" ? "Codex" : "Claude";

  useEffect(() => {
    function handleDismiss(e: Event) {
      const target = (e as TouchEvent).touches?.[0]?.target ?? e.target;
      if (ref.current && !ref.current.contains(target as Node)) onClose();
    }
    // pointerdown, not mousedown: the office viewport preventDefaults
    // pointerdown on the pannable background (useViewport), which suppresses
    // the compatibility mousedown — a mousedown listener never fires there,
    // leaving the menu stuck open. pointerdown itself always bubbles.
    // touchstart stays as a fallback: DeskUnit preventDefaults touchstart,
    // which on some browsers suppresses the synthesized pointer events.
    document.addEventListener("pointerdown", handleDismiss);
    document.addEventListener("touchstart", handleDismiss);
    return () => {
      document.removeEventListener("pointerdown", handleDismiss);
      document.removeEventListener("touchstart", handleDismiss);
    };
  }, [onClose]);

  // Fetch the sessions list when the menu opens (only if the feature is on).
  // Read-as-data: GET the agent's sessions and seed the store via the same (now
  // CLIENT-LOCAL) sessions_list action the WS push used to feed. .catch swallows
  // — a closed menu / missing agent simply renders no resume list.
  useEffect(() => {
    if (!features.sessions) return;
    apiFetch<{ sessions: SessionInfo[]; currentSessionId: string | null }>(
      "GET",
      `/api/agents/${agent.id}/sessions`,
    )
      .then((data) =>
        dispatch({
          type: "sessions_list",
          agentId: agent.id,
          sessions: data.sessions,
          currentSessionId: data.currentSessionId,
        }),
      )
      .catch(() => {});
  }, [agent.id, features.sessions, dispatch]);

  function handleAction(
    action: string,
    sessionId?: string,
    agentType?: AgentBackendType,
  ) {
    switch (action) {
      case "new_conversation":
        apiFetch(
          "POST",
          `/api/agents/${agent.id}/new-conversation`,
          agentType ? { agentType } : undefined,
        ).catch(() => {});
        break;
      case "resume":
        if (sessionId)
          apiFetch("POST", `/api/agents/${agent.id}/resume`, {
            sessionId,
          }).catch(() => {});
        break;
      case "kill":
        apiFetch("DELETE", `/api/agents/${agent.id}`).catch(() => {});
        break;
    }
    onClose();
  }

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        background: "var(--bg-overlay)",
        backdropFilter: "blur(16px)",
        border: "1px solid var(--border-light)",
        borderRadius: 12,
        padding: 5,
        minWidth: 200,
        maxHeight: 320,
        overflowY: "auto",
        boxShadow: "0 12px 40px var(--shadow-heavy)",
        animation: "hudIn 0.12s ease-out",
      }}
    >
      <div
        style={{
          padding: "5px 10px",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {agent.name}
      </div>
      <MenuItem
        label="Edit Agent..."
        onClick={() => {
          onEdit(agent);
          onClose();
        }}
      />
      {features.sessions && (
        <MenuItem
          label="New Conversation"
          onClick={() => handleAction("new_conversation")}
        />
      )}
      {features.sessions && (
        <MenuItem
          label={`New ${otherEngineLabel} Conversation`}
          onClick={() =>
            handleAction("new_conversation", undefined, otherEngine)
          }
        />
      )}

      {features.sessions && sessions.length > 1 && (
        <>
          <div
            style={{
              height: 1,
              background: "var(--border-strong)",
              margin: "3px 8px",
            }}
          />
          <div
            style={{
              padding: "4px 10px",
              fontSize: 9,
              color: "var(--text-ghost)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Resume
          </div>
          {sessions.slice(0, 5).map((s) => {
            const isCurrent = s.sessionId === currentSessionId;
            const rawLabel = s.topic || s.sessionId.slice(0, 8) + "...";
            const label = s.forked ? `↳ ${rawLabel}` : rawLabel;
            const branchedSuffix = s.branched ? " (branched)" : "";
            // No engine badge: which backend a past session ran on doesn't
            // change the choice of what to resume, and the row reads better
            // without it. Selecting a row still flips the agent to that
            // session's engine.
            const displayLabel = isCurrent
              ? `● ${label}  ${formatTime(s.lastModified)}  (current)`
              : `${label}  ${formatTime(s.lastModified)}${branchedSuffix}`;
            return (
              <MenuItem
                key={s.sessionId}
                label={displayLabel}
                small
                disabled={isCurrent}
                dimmed={s.branched}
                onClick={() =>
                  !isCurrent && handleAction("resume", s.sessionId)
                }
              />
            );
          })}
        </>
      )}

      <div
        style={{
          height: 1,
          background: "var(--border-strong)",
          margin: "3px 8px",
        }}
      />
      <MenuItem
        label="Kill Agent"
        danger
        onClick={() => handleAction("kill")}
      />
    </div>
  );
}

function MenuItem({
  label,
  danger,
  small,
  disabled,
  dimmed,
  onClick,
}: {
  label: string;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={(e) => {
        if (!disabled)
          e.currentTarget.style.background = danger
            ? "rgba(232,93,117,0.08)"
            : "rgba(255,255,255,0.04)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: small ? "5px 10px" : "7px 10px",
        border: "none",
        background: "transparent",
        color: danger ? "var(--red)" : "var(--text-dim)",
        fontFamily: small ? "'JetBrains Mono',monospace" : undefined,
        fontSize: small ? 11 : 13,
        borderRadius: 6,
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        opacity: disabled ? 0.5 : dimmed ? 0.45 : 1,
        fontStyle: dimmed ? "italic" : undefined,
      }}
    >
      {label}
    </button>
  );
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) {
    return time;
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
