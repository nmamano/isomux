import { useState } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { DeskSprite } from "./DeskSprite.tsx";
import { Character } from "./Character.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { isoXY, DESK_SLOTS } from "./grid.ts";

export function DeskUnit({
  agent,
  onClick,
  onContextMenu,
  needsAttention,
  previewText,
}: {
  agent: AgentInfo;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  needsAttention?: boolean;
  previewText?: string;
}) {
  const [hov, setHov] = useState(false);
  const pos = DESK_SLOTS[agent.desk];
  const { x, y } = isoXY(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;

  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: "absolute",
        left: `calc(50% + ${x}px - 90px)`,
        top: `${y + 80}px`,
        width: 180,
        cursor: "pointer",
        zIndex: z,
        transition: "filter 0.25s, transform 0.25s",
        filter: hov ? "brightness(1.2) drop-shadow(0 0 30px rgba(126,184,255,0.15))" : "brightness(1)",
        transform: hov ? "translateY(-5px)" : "translateY(0)",
      }}
    >
      {/* Shadow on floor */}
      <div
        style={{
          position: "absolute",
          bottom: -2,
          left: "50%",
          transform: "translateX(-50%)",
          width: 120,
          height: 20,
          background: "radial-gradient(ellipse,rgba(0,0,0,0.2),transparent)",
          borderRadius: "50%",
          zIndex: 0,
        }}
      />

      {/* Character behind desk */}
      <div style={{ position: "absolute", left: 64, top: -28, zIndex: 1 }}>
        <Character state={agent.state} outfit={agent.outfit} />
      </div>

      {/* Desk */}
      <div style={{ position: "relative", zIndex: 2 }}>
        <DeskSprite state={agent.state} />
      </div>

      {/* Floating nametag */}
      <div
        style={{
          position: "absolute",
          top: -48,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px 3px 7px",
          background: needsAttention ? "rgba(245,166,35,0.15)" : "rgba(10,14,25,0.88)",
          backdropFilter: "blur(10px)",
          borderRadius: 20,
          border: needsAttention ? "1px solid rgba(245,166,35,0.3)" : "1px solid rgba(255,255,255,0.07)",
          whiteSpace: "nowrap",
          zIndex: 100,
          opacity: hov ? 1 : 0.8,
          transition: "opacity 0.2s, background 0.3s, border 0.3s",
          animation: needsAttention ? "dotPulse 2s ease-in-out infinite" : undefined,
        }}
      >
        <StatusLight state={agent.state} size={8} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#e0e8f5", letterSpacing: "-0.01em" }}>
          {agent.name}
        </span>
      </div>

      {/* Monitor preview text */}
      {previewText && !hov && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 68,
            width: 44,
            height: 24,
            overflow: "hidden",
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              fontSize: 5.5,
              fontFamily: "'JetBrains Mono',monospace",
              color: "rgba(160,200,255,0.5)",
              lineHeight: 1.3,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {previewText.slice(0, 80)}
          </div>
        </div>
      )}

      {/* Tooltip on hover */}
      {hov && (
        <div
          style={{
            position: "absolute",
            top: -90,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "8px 12px",
            background: "rgba(10,14,25,0.94)",
            backdropFilter: "blur(14px)",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.08)",
            whiteSpace: "nowrap",
            zIndex: 200,
            animation: "hudIn 0.12s ease-out",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ fontSize: 10, color: "#8a9ab8", fontFamily: "'JetBrains Mono',monospace" }}>
            {agent.cwd}
          </div>
          <div
            style={{
              position: "absolute",
              bottom: -5,
              left: "50%",
              transform: "translateX(-50%) rotate(45deg)",
              width: 10,
              height: 10,
              background: "rgba(10,14,25,0.94)",
              borderRight: "1px solid rgba(255,255,255,0.08)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          />
        </div>
      )}
    </div>
  );
}
