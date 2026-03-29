import { useState } from "react";
import { useAppState, useDispatch, useTheme } from "../store.tsx";
import { Floor, Walls } from "./Floor.tsx";
import { RoomProps } from "./RoomProps.tsx";
import { DeskUnit } from "./DeskUnit.tsx";
import { EmptySlot } from "./EmptySlot.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { SCENE_W, SCENE_H } from "./grid.ts";
import { send } from "../ws.ts";
import type { AgentInfo } from "../../shared/types.ts";

export function OfficeView({ onSpawn, onContextMenu, username, onEditUsername }: { onSpawn: (deskIndex: number) => void; onContextMenu: (x: number, y: number, agent: AgentInfo) => void; username: string; onEditUsername: () => void }) {
  const { agents, needsAttention, stateChangedAt } = useAppState();
  const dispatch = useDispatch();
  const { theme, toggleTheme } = useTheme();

  const counts = {
    working: agents.filter((a) => ["thinking", "tool_executing"].includes(a.state)).length,
    active: agents.filter((a) => a.state === "waiting_for_response").length,
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
        background: "var(--bg-base)",
        color: "var(--text-primary)",
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
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
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
              background: "var(--accent-bg)",
              color: "var(--accent)",
              letterSpacing: "0.05em",
            }}
          >
            CLAUDE CODE
          </span>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {(
            [
              { n: counts.working, c: "var(--green)", l: "working" },
              { n: counts.active, c: "var(--purple)", l: "active" },
              { n: counts.error, c: "var(--red)", l: "error" },
              { n: counts.idle, c: "var(--text-muted)", l: "idle" },
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            onClick={onEditUsername}
            style={{
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "'JetBrains Mono',monospace",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--btn-surface)",
            }}
            title="Change name"
          >
            {username.toUpperCase()}
          </span>
          <button
            onClick={toggleTheme}
            style={{
              padding: "4px 10px",
              borderRadius: 8,
              border: "1px solid var(--border-medium)",
              background: "var(--btn-surface)",
              color: "var(--text-dim)",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif",
            }}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </div>

      {/* Office scene */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Ambient gradients */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 50% 30%, var(--ambient-1) 0%, transparent 50%), radial-gradient(ellipse at 25% 65%, var(--ambient-2) 0%, transparent 35%), radial-gradient(ellipse at 75% 65%, var(--ambient-3) 0%, transparent 35%)",
          }}
        />

        {/* Single scene container — floor, walls, and desks share the same coordinate space */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: SCENE_W,
            height: SCENE_H,
          }}
        >
          <Walls onToggleTheme={toggleTheme} />
          <Floor />
          <RoomProps />
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
                  onSwap={(a, b) => send({ type: "swap_desks", deskA: a, deskB: b })}
                  stateChangedAt={stateChangedAt.get(agent.id)}
                />
              );
            }
            return <EmptySlot key={`empty-${i}`} deskIndex={i} onClick={() => onSpawn(i)} onSwap={(a, b) => send({ type: "swap_desks", deskA: a, deskB: b })} />;
          })}
        </div>

        {/* Vignette */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            boxShadow: "inset 0 0 120px var(--vignette)",
          }}
        />
      </div>

      {/* Bottom HUD */}
      <div
        style={{
          padding: "6px 20px",
          background: "var(--bg-hud-bottom)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          justifyContent: "center",
          gap: 20,
          zIndex: 500,
        }}
      >
        {["CLICK → open agent", "DRAG → swap desks", "RIGHT-CLICK → actions", "ESC → back"].map((h, i) => (
          <span
            key={i}
            style={{
              fontSize: 9,
              color: "var(--text-hint)",
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
