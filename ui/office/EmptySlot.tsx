import { useState } from "react";
import { isoXY, DESK_SLOTS } from "./grid.ts";

export function EmptySlot({ deskIndex, onClick }: { deskIndex: number; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  const pos = DESK_SLOTS[deskIndex];
  const { x, y } = isoXY(pos.row, pos.col);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        position: "absolute",
        left: `calc(50% + ${x}px - 90px)`,
        top: `${y + 50}px`,
        width: 180,
        height: 140,
        cursor: "pointer",
        zIndex: (pos.row * 2 + pos.col + 1) * 10,
      }}
    >
      <svg
        width="180"
        height="140"
        viewBox="0 0 180 140"
        overflow="visible"
        style={{ opacity: hov ? 0.7 : 0.18, transition: "opacity 0.3s" }}
      >
        <path
          d="M20 62 L90 28 L160 62 L90 96 Z"
          fill="none"
          stroke={hov ? "#7eb8ff" : "#5a6f8f"}
          strokeWidth="1.5"
          strokeDasharray="8 5"
        />
      </svg>
      {hov && (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: "50%",
            transform: "translateX(-50%)",
            textAlign: "center",
            animation: "hudIn 0.12s ease-out",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              border: "2px solid #7eb8ff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              color: "#7eb8ff",
              margin: "0 auto 6px",
              background: "rgba(126,184,255,0.06)",
            }}
          >
            +
          </div>
          <div style={{ fontSize: 11, color: "#7eb8ff", fontWeight: 500 }}>New Agent</div>
        </div>
      )}
    </div>
  );
}
