import { NavActions, type NavAction } from "./NavActions.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export type RoomCounts = {
  working: number;
  waiting: number;
  error: number;
  idle: number;
};

export function getRoomCounts(roomAgents: AgentInfo[]): RoomCounts {
  return {
    working: roomAgents.filter((a) =>
      ["thinking", "tool_executing"].includes(a.state),
    ).length,
    waiting: roomAgents.filter((a) => a.state === "waiting_for_response")
      .length,
    error: roomAgents.filter((a) => a.state === "error").length,
    idle: roomAgents.filter((a) => a.state === "idle" || a.state === "stopped")
      .length,
  };
}

export function MobileHeader({
  counts,
  actions,
  updateAvailable,
  onOpenUpdate,
}: {
  counts: RoomCounts;
  actions: NavAction[];
  updateAvailable?: boolean;
  onOpenUpdate?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 12px",
        paddingTop: "env(safe-area-inset-top, 0px)",
        height: "calc(40px + env(safe-area-inset-top, 0px))",
        background: "var(--bg-hud)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
        zIndex: 500,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "var(--text-primary)",
          }}
        >
          Isomux
        </span>
        {updateAvailable && (
          <span
            onClick={onOpenUpdate}
            style={{
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "-12px -12px -12px -4px",
              flexShrink: 0,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--blue, #58a6ff)",
                boxShadow: "0 0 6px var(--blue, #58a6ff)",
              }}
            />
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {(
          [
            { n: counts.working, c: "var(--green)", label: "working" },
            { n: counts.waiting, c: "var(--purple)", label: "waiting" },
            { n: counts.error, c: "var(--red)", label: "err" },
          ] as const
        )
          .filter((s) => s.n > 0)
          .map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                fontSize: 9,
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
              {s.n} {s.label}
            </div>
          ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <NavActions actions={actions} viewport="mobile" />
      </div>
    </div>
  );
}
