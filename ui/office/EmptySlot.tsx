import { useState } from "react";
import { deskPixelPos, DESK_SLOTS } from "./grid.ts";

export function EmptySlot({ deskIndex, onClick }: { deskIndex: number; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  const pos = DESK_SLOTS[deskIndex];
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);

  return (
    <div
      style={{
        position: "absolute",
        left: pxLeft,
        top: pxTop,
        width: 180,
        height: 160,
        zIndex: (pos.row * 2 + pos.col + 1) * 10,
        pointerEvents: "none",
      }}
    >
      <svg width="180" height="160" viewBox="0 0 180 160" overflow="visible" style={{ pointerEvents: "none" }}>
        {/* Invisible hit area — only the diamond shape triggers hover/click */}
        <path
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
          fill={hov ? "rgba(126,184,255,0.06)" : "none"}
          stroke={hov ? "#7eb8ff" : "#5a6f8f"}
          strokeWidth="1"
          strokeDasharray="6 4"
          style={{ opacity: hov ? 0.8 : 0.2, transition: "opacity 0.3s", pointerEvents: "none" }}
        />
      </svg>
      {hov && (
        <div
          style={{
            position: "absolute",
            top: 100,
            left: "50%",
            transform: "translateX(-50%)",
            textAlign: "center",
            pointerEvents: "none",
            animation: "hudIn 0.12s ease-out",
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "2px solid #7eb8ff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: "#7eb8ff",
              margin: "0 auto 5px",
              background: "rgba(126,184,255,0.06)",
            }}
          >
            +
          </div>
          <div style={{ fontSize: 10, color: "#7eb8ff", fontWeight: 500 }}>New Agent</div>
        </div>
      )}
    </div>
  );
}
