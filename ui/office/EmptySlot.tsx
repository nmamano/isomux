import { useState } from "react";
import { deskPixelPos, DESK_SLOTS } from "./grid.ts";

export function EmptySlot({
  deskIndex,
  onClick,
  onSwap,
}: {
  deskIndex: number;
  onClick: () => void;
  onSwap?: (sourceDesk: number, targetDesk: number) => void;
}) {
  const [hov, setHov] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const pos = DESK_SLOTS[deskIndex];
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={() => setDragOver(true)}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const src = parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (!isNaN(src) && src !== deskIndex) onSwap?.(src, deskIndex);
      }}
      style={{
        position: "absolute",
        left: pxLeft,
        top: pxTop,
        width: 180,
        height: 160,
        zIndex: (pos.row * 2 + pos.col + 1) * 10,
      }}
    >
      <svg width="180" height="160" viewBox="0 0 180 160" overflow="visible" style={{ pointerEvents: "none" }}>
        {/* Invisible hit area — only the diamond shape triggers hover/click */}
        <path
          data-no-pan
          d="M40 126 L90 101 L140 126 L90 151 Z"
          fill="transparent"
          stroke="none"
          style={{ pointerEvents: "fill", cursor: "pointer" }}
          onClick={onClick}
          onMouseEnter={() => setHov(true)}
          onMouseLeave={() => setHov(false)}
        />
        {/* Visible dashed outline */}
        <path
          d="M40 126 L90 101 L140 126 L90 151 Z"
          fill={dragOver ? "rgba(126,184,255,0.12)" : hov ? "rgba(126,184,255,0.06)" : "none"}
          stroke={dragOver ? "var(--accent)" : hov ? "var(--accent)" : "var(--text-muted)"}
          strokeWidth={dragOver ? "2" : "1"}
          strokeDasharray={dragOver ? "none" : "6 4"}
          style={{ opacity: dragOver ? 1 : hov ? 0.85 : 0.55, transition: "opacity 0.3s", pointerEvents: "none" }}
        />
      </svg>
      {/* Desk number label — always visible */}
      <div
        style={{
          position: "absolute",
          top: 108,
          left: "50%",
          transform: "translateX(-50%)",
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            opacity: hov ? 0.75 : 0.6,
            transition: "opacity 0.3s",
            fontFamily: "'JetBrains Mono',monospace",
          }}
        >
          {deskIndex + 1}
        </span>
      </div>
      {hov && (
        <div
          style={{
            position: "absolute",
            top: 100,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            pointerEvents: "none",
            animation: "hudIn 0.12s ease-out",
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "2px solid var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: "var(--accent)",
              margin: "0 auto 5px",
              background: "rgba(126,184,255,0.06)",
            }}
          >
            +
          </div>
          <div style={{ fontSize: 10, color: "var(--accent)", fontWeight: 500 }}>New Agent</div>
        </div>
      )}
    </div>
  );
}
