import { useRef, useEffect } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { send } from "../ws.ts";

interface ContextMenuProps {
  x: number;
  y: number;
  agent: AgentInfo;
  onClose: () => void;
}

export function ContextMenu({ x, y, agent, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  function handleAction(action: string) {
    switch (action) {
      case "new_conversation":
        send({ type: "new_conversation", agentId: agent.id });
        break;
      case "kill":
        send({ type: "kill", agentId: agent.id });
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
        background: "rgba(10,14,25,0.95)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: 5,
        minWidth: 180,
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        animation: "hudIn 0.12s ease-out",
      }}
    >
      <div
        style={{
          padding: "5px 10px",
          fontSize: 10,
          fontWeight: 600,
          color: "#4a5a7a",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {agent.name}
      </div>
      <MenuItem label="New Conversation" onClick={() => handleAction("new_conversation")} />
      <div style={{ height: 1, background: "rgba(255,255,255,0.05)", margin: "3px 8px" }} />
      <MenuItem label="Kill Agent" danger onClick={() => handleAction("kill")} />
    </div>
  );
}

function MenuItem({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = danger ? "rgba(232,93,117,0.08)" : "rgba(255,255,255,0.04)")
      }
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        border: "none",
        background: "transparent",
        color: danger ? "#E85D75" : "#8a9ab8",
        fontFamily: "'DM Sans',sans-serif",
        fontSize: 13,
        borderRadius: 6,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {label}
    </button>
  );
}
