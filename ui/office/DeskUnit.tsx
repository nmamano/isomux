import { useState, useEffect, useRef } from "react";
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
  onSwap,
  stateChangedAt,
}: {
  agent: AgentInfo;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  needsAttention?: boolean;
  onSwap?: (sourceDesk: number, targetDesk: number) => void;
  stateChangedAt?: number;
}) {
  const [hov, setHov] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const isWorking = agent.state === "thinking" || agent.state === "tool_executing";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isWorking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isWorking]);

  // Stable refs for callbacks so the touch listener effect doesn't re-register on every render
  const onClickRef = useRef(onClick);
  const onContextMenuRef = useRef(onContextMenu);
  onClickRef.current = onClick;
  onContextMenuRef.current = onContextMenu;

  // Non-passive touch listeners — React registers touch listeners as passive,
  // which silently ignores preventDefault(). We need preventDefault() to suppress
  // native long-press context menu, text selection, and synthetic mouse events.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleTouchStart(e: TouchEvent) {
      e.preventDefault();
      longPressTriggered.current = false;
      const touch = e.touches[0];
      longPressTimer.current = setTimeout(() => {
        longPressTriggered.current = true;
        onContextMenuRef.current({ clientX: touch.clientX, clientY: touch.clientY, preventDefault() {} } as unknown as React.MouseEvent);
      }, 500);
    }
    function handleTouchEnd(e: TouchEvent) {
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
      if (longPressTriggered.current) {
        e.preventDefault();
      } else {
        onClickRef.current();
      }
    }
    function handleTouchMove() {
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    }

    el.addEventListener("touchstart", handleTouchStart, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: false });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchmove", handleTouchMove);
    };
  }, []);

  const elapsedMs = isWorking && stateChangedAt ? now - stateChangedAt : undefined;
  const pos = DESK_SLOTS[agent.desk];
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;

  return (
    <div
      ref={containerRef}
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
      onClick={() => { if (!longPressTriggered.current) onClick(); }}
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
        userSelect: "none",
        WebkitUserSelect: "none",
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

      {/* Character behind desk — idle agents sit back a bit */}
      <div style={{ position: "absolute", left: agent.state === "idle" || agent.state === "stopped" ? 84 : 78, top: agent.state === "idle" || agent.state === "stopped" ? -16 : -20, zIndex: 1 }}>
        <Character state={agent.state} outfit={agent.outfit} />
      </div>

      {/* Desk */}
      <div style={{ position: "relative", zIndex: 2 }}>
        <DeskSprite state={agent.state} deskIndex={agent.desk} cwd={agent.cwd} />
      </div>

      {/* Floating nametag — outer div handles positioning, inner handles animation */}
      <div
        style={{
          position: "absolute",
          top: agent.topic ? -58 : -48,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
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
            whiteSpace: "nowrap",
          }}
        >
          <StatusLight state={agent.state} size={8} elapsedMs={elapsedMs} />
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
            <span style={{ opacity: 0.5 }}>{agent.desk + 1} ·</span> {agent.name}
          </span>
        </div>
        {agent.topic && agent.topic !== "..." && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              textAlign: "center",
              marginTop: 2,
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: hov ? 0.9 : 0.7,
              transition: "opacity 0.2s",
            }}
          >
            {agent.topic}
          </div>
        )}
      </div>

    </div>
  );
}
