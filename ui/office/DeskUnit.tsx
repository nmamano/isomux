import { useState } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { DeskSprite } from "./DeskSprite.tsx";
import { Character } from "./Character.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { deskPixelPos, DESK_SLOTS } from "./grid.ts";

export function DeskUnit({
  agent,
  onClick,
  onContextMenu,
  needsAttention,
  previewText,
  onSwap,
}: {
  agent: AgentInfo;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  needsAttention?: boolean;
  previewText?: string;
  onSwap?: (sourceDesk: number, targetDesk: number) => void;
}) {
  const [hov, setHov] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const pos = DESK_SLOTS[agent.desk];
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", String(agent.desk));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={() => setDragOver(true)}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const src = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(src) && src !== agent.desk) onSwap?.(src, agent.desk);
      }}
      onDragEnd={() => setDragOver(false)}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: "absolute",
        left: pxLeft,
        top: pxTop,
        width: 180,
        cursor: "pointer",
        zIndex: z,
        transition: "filter 0.25s, transform 0.25s",
        filter: dragOver ? "brightness(1.3) drop-shadow(0 0 40px rgba(126,184,255,0.3))" : hov ? "brightness(1.2) drop-shadow(0 0 30px rgba(126,184,255,0.15))" : "brightness(1)",
        transform: hov ? "translateY(-5px)" : "translateY(0)",
        outline: dragOver ? "2px solid rgba(126,184,255,0.4)" : "none",
        outlineOffset: 4,
        borderRadius: 8,
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

      {/* Floating nametag — outer div handles positioning, inner handles animation */}
      <div
        style={{
          position: "absolute",
          top: -48,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 100,
          whiteSpace: "nowrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px 3px 7px",
            background: needsAttention ? "var(--orange-bg)" : "var(--bg-tag)",
            backdropFilter: "blur(10px)",
            borderRadius: 20,
            border: needsAttention ? "1px solid var(--orange-border)" : "1px solid var(--border-medium)",
            opacity: hov ? 1 : 0.8,
            transition: "opacity 0.2s, background 0.3s, border 0.3s",
            animation: needsAttention ? "dotPulse 2s ease-in-out infinite" : undefined,
          }}
        >
          <StatusLight state={agent.state} size={8} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
            {agent.name}
          </span>
        </div>
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
              color: "var(--monitor-text)",
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
            background: "var(--bg-tooltip)",
            backdropFilter: "blur(14px)",
            borderRadius: 12,
            border: "1px solid var(--border-light)",
            whiteSpace: "nowrap",
            zIndex: 200,
            animation: "hudIn 0.12s ease-out",
            boxShadow: "0 8px 24px var(--shadow)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "'JetBrains Mono',monospace" }}>
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
              background: "var(--bg-tooltip)",
              borderRight: "1px solid var(--border-light)",
              borderBottom: "1px solid var(--border-light)",
            }}
          />
        </div>
      )}
    </div>
  );
}
