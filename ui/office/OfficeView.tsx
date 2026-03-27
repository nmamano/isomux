import { useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { Floor, Walls } from "./Floor.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { StatusLight } from "./StatusLight.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export function OfficeView({ onSpawn, onContextMenu }: { onSpawn: (deskIndex: number) => void; onContextMenu: (x: number, y: number, agent: AgentInfo) => void }) {
  const { agents, needsAttention, latestText } = useAppState();
  const dispatch = useDispatch();

  const counts = {
    working: agents.filter((a) => ["thinking", "tool_executing", "starting"].includes(a.state)).length,
    waiting: agents.filter((a) => a.state === "waiting_permission").length,
    error: agents.filter((a) => a.state === "error").length,
    idle: agents.filter((a) => a.state === "idle" || a.state === "stopped").length,
  };

  const occupied = new Set(agents.map((a) => a.desk));

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#0a0e16",
        color: "#e0e8f5",
        fontFamily: "'DM Sans',sans-serif",
      }}
    >
      {/* Top HUD bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          height: 44,
          background: "rgba(10,14,22,0.7)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(255,255,255,0.03)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Isomux</span>
          <span
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 9,
              padding: "2px 7px",
              borderRadius: 20,
              background: "rgba(126,184,255,0.08)",
              color: "#7eb8ff",
              letterSpacing: "0.05em",
            }}
          >
            CLAUDE CODE
          </span>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {(
            [
              { n: counts.working, c: "#50B86C", l: "working" },
              { n: counts.waiting, c: "#F5A623", l: "waiting" },
              { n: counts.error, c: "#E85D75", l: "error" },
              { n: counts.idle, c: "#5a6f8f", l: "idle" },
            ] as const
          )
            .filter((s) => s.n > 0)
            .map((s) => (
              <div
                key={s.l}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 10,
                  fontWeight: 600,
                  color: s.c,
                  fontFamily: "'JetBrains Mono',monospace",
                  letterSpacing: "0.02em",
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: s.c,
                    boxShadow: `0 0 6px ${s.c}`,
                  }}
                />
                {s.n} {s.l}
              </div>
            ))}
        </div>
        <div style={{ width: 80 }} />
      </div>

      {/* Office scene */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Ambient gradients */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 50% 30%, rgba(126,184,255,0.025) 0%, transparent 50%), radial-gradient(ellipse at 25% 65%, rgba(80,184,108,0.015) 0%, transparent 35%), radial-gradient(ellipse at 75% 65%, rgba(245,166,35,0.01) 0%, transparent 35%)",
          }}
        />

        <Walls />
        <Floor />
        <RoomProps />

        {/* Desks */}
        <div style={{ position: "absolute", inset: 0 }}>
          {Array.from({ length: 8 }, (_, i) => {
            const agent = agents.find((a) => a.desk === i);
            if (agent) {
              return (
                <DeskUnit
                  key={agent.id}
                  agent={agent}
                  onClick={() => dispatch({ type: "focus", agentId: agent.id })}
                  onContextMenu={(e) => onContextMenu(e.clientX, e.clientY, agent)}
                  needsAttention={needsAttention.has(agent.id)}
                  previewText={latestText.get(agent.id)}
                />
              );
            }
            return <EmptySlot key={`empty-${i}`} deskIndex={i} onClick={() => onSpawn(i)} />;
          })}
        </div>

        {/* Vignette */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            boxShadow: "inset 0 0 120px rgba(0,0,0,0.4)",
          }}
        />
      </div>

      {/* Bottom HUD */}
      <div
        style={{
          padding: "6px 20px",
          background: "rgba(10,14,22,0.5)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid rgba(255,255,255,0.02)",
          display: "flex",
          justifyContent: "center",
          gap: 20,
          zIndex: 500,
        }}
      >
        {["CLICK → open agent", "RIGHT-CLICK → actions", "ESC → back"].map((h, i) => (
          <span
            key={i}
            style={{
              fontSize: 9,
              color: "#3a4a68",
              fontFamily: "'JetBrains Mono',monospace",
              letterSpacing: "0.04em",
            }}
          >
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}
