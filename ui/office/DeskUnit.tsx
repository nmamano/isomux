import { useState, useEffect, useRef, type RefObject } from "react";
import type { AgentInfo } from "../../shared/types.ts";
import { DeskSprite } from "./DeskSprite.tsx";
import type { SeasonalItem } from "./Seasonal.tsx";
import { Character } from "./Character.tsx";
import { StatusLight } from "./StatusLight.tsx";
import { DESK_SLOTS } from "../../shared/desks.ts";
import { deskPixelPos } from "./grid.ts";
import { getDraggedDesk, setDraggedDesk } from "./drag-state.ts";
import { styleForModel } from "../model-styles.ts";
import { PENDING_PROMPT_BADGE } from "../pending-prompt.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { isWorkingState } from "../store.tsx";

/** How long an agent works without a break before it starts to sweat. */
export const SWEAT_AFTER_MS = 2 * 60_000;

export function DeskUnit({
  agent,
  onClick,
  onContextMenu,
  needsAttention,
  onSwap,
  stateChangedAt,
  workingSince,
  askCount = 0,
  seasonal,
}: {
  agent: AgentInfo;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  needsAttention?: boolean;
  // Open asks from this agent to the viewing member: the count dot.
  askCount?: number;
  onSwap?: (sourceDesk: number, targetDesk: number) => void;
  stateChangedAt?: number;
  workingSince?: number;
  seasonal?: SeasonalItem[];
}) {
  const { t, tn } = useI18n();
  const [hov, setHov] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // The desk this unit put in drag-state, while its drag runs. A desk that
  // unmounts mid-drag (its agent moved to another room) never gets dragend,
  // so the unmount clears it instead.
  const dragStarted = useRef<number | null>(null);
  useEffect(
    () => () => {
      const desk = dragStarted.current;
      if (desk !== null && getDraggedDesk() === desk) setDraggedDesk(null);
    },
    [],
  );
  const isWorking = isWorkingState(agent.state);
  const modelStyle = styleForModel(agent.modelFamily);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isWorking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isWorking]);

  // Stable refs for callbacks so the touch listeners don't re-register on every render
  const onClickRef = useRef(onClick);
  const onContextMenuRef = useRef(onContextMenu);
  /* eslint-disable react-hooks/refs */
  onClickRef.current = onClick;
  onContextMenuRef.current = onContextMenu;
  /* eslint-enable react-hooks/refs */
  // The desk and its floating name tag are two hit boxes for the same agent.
  const deskLongPress = useTapAndLongPress(
    containerRef,
    onClickRef,
    onContextMenuRef,
  );
  const tagRef = useRef<HTMLDivElement>(null);
  const tagLongPress = useTapAndLongPress(tagRef, onClickRef, onContextMenuRef);

  const elapsedMs =
    isWorking && stateChangedAt ? now - stateChangedAt : undefined;
  // Read off the clock the status light already ticks while working, so an
  // agent that is not working costs nothing here.
  const sweating =
    isWorking &&
    workingSince !== undefined &&
    now - workingSince >= SWEAT_AFTER_MS;
  const pos = DESK_SLOTS[agent.desk];
  // An agent whose desk names no slot has nowhere to be drawn. OfficeState
  // rejects such a desk at spawn, so this only fires for a
  // record that predates that check or was hand-edited on disk: skip the one
  // desk instead of throwing and taking the whole room view down with it.
  if (!pos) return null;
  const { left: pxLeft, top: pxTop } = deskPixelPos(pos.row, pos.col);
  const z = (pos.row * 2 + pos.col + 1) * 10;

  return (
    <>
      <div
        data-turn-anchor={`${pxLeft + 90},${pxTop + 116}`}
        ref={containerRef}
        draggable
        data-no-pan
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", String(agent.desk));
          e.dataTransfer.effectAllowed = "move";
          setDraggedDesk(agent.desk);
          dragStarted.current = agent.desk;
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDragEnter={() => {
          if (getDraggedDesk() !== agent.desk) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const src = parseInt(e.dataTransfer.getData("text/plain"), 10);
          if (!isNaN(src) && src !== agent.desk) onSwap?.(src, agent.desk);
        }}
        onDragEnd={() => {
          dragStarted.current = null;
          setDraggedDesk(null);
          setDragOver(false);
        }}
        onClick={() => {
          if (!deskLongPress.current) onClick();
        }}
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
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {/* The drawing lifts on hover; the hit box above stays in place, so
            a mouse at the desk's lower edge does not lose the hover when the
            drawing rises. */}
        <div
          style={{
            position: "relative",
            pointerEvents: "none",
            transition: dragOver
              ? "filter 0.05s, transform 0.25s"
              : "filter 0.15s, transform 0.25s",
            filter: dragOver
              ? "brightness(1.18) drop-shadow(0 0 42px rgba(126,184,255,0.75))"
              : hov
                ? "brightness(1.2) drop-shadow(0 0 30px rgba(126,184,255,0.15))"
                : "brightness(1)",
            transform: hov ? "translateY(-5px)" : "translateY(0)",
            outline: dragOver ? "3px solid var(--accent)" : "none",
            outlineOffset: 4,
            borderRadius: 8,
          }}
        >
          {dragOver && (
            <div
              style={{
                position: "absolute",
                inset: -4,
                zIndex: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                background: "rgba(126,184,255,0.2)",
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  padding: "5px 10px",
                  borderRadius: 14,
                  background: "var(--accent-text)",
                  color: "var(--bg-base)",
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
                }}
              >
                ⇄ {t("office.desk.swapBadge")}
              </div>
            </div>
          )}

          {/* Character behind desk - idle agents sit back a bit */}
          <div
            style={{
              position: "absolute",
              left:
                agent.state === "idle" || agent.state === "stopped" ? 84 : 78,
              top:
                agent.state === "idle" || agent.state === "stopped" ? -16 : -20,
              zIndex: 1,
              pointerEvents: "none",
            }}
          >
            <Character
              state={agent.state}
              outfit={agent.outfit}
              sweating={sweating}
              backgroundCount={agent.backgroundTasks?.length ?? 0}
            />
          </div>

          {/* Desk */}
          <div
            style={{ position: "relative", zIndex: 2, pointerEvents: "none" }}
          >
            <DeskSprite
              state={agent.state}
              deskIndex={agent.desk}
              cwd={agent.cwd}
              deskProp={modelStyle.deskProp}
              agentId={agent.id}
              agentType={agent.agentType}
              modelFamily={agent.modelFamily}
              claudeFamilyModels={agent.claudeFamilyModels}
              seasonal={seasonal}
            />
          </div>
        </div>
      </div>

      {/* Floating nametag - hoisted out of the DeskUnit container to a
          scene-level sibling at high z so it always renders above
          floating ghost avatars (live-avatars feature). Position is
          computed from the desk's pixel coords; the per-desk z bump
          (z + 10000) preserves the front-vs-back isometric ordering
          between nametags themselves when two desks' chips overlap.
          Outside the desk's hit box, so it carries the desk's own click,
          touch and hover handlers. */}
      <div
        ref={tagRef}
        data-turn-anchor={`${pxLeft + 90},${pxTop + 116}`}
        data-desk-tag={agent.desk}
        data-no-pan
        onClick={() => {
          if (!tagLongPress.current) onClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e);
        }}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          position: "absolute",
          top: pxTop + (agent.topic ? -58 : -48),
          left: pxLeft + 90,
          transform: "translateX(-50%)",
          zIndex: z + 10000,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px 3px 7px",
            background: modelStyle.bg,
            backdropFilter: "blur(10px)",
            borderRadius: 20,
            border: `1px solid ${modelStyle.border}`,
            transition: "background 0.3s, border 0.3s",
            animation: needsAttention
              ? "dotPulse 2s ease-in-out infinite"
              : undefined,
            whiteSpace: "nowrap",
            position: "relative",
          }}
        >
          {/* Open asks for the viewer: a count on the corner, apart
              from the word badges (unread, a pending prompt) inside. */}
          {askCount > 0 && (
            <span
              data-ask-dot=""
              role="img"
              aria-label={tn("asks.badge", askCount)}
              style={{
                position: "absolute",
                top: -7,
                right: -7,
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 8,
                background: "var(--orange-text)",
                color: "var(--bg-base)",
                fontSize: 10,
                fontWeight: 800,
                lineHeight: "16px",
                textAlign: "center",
                boxShadow: "0 0 0 2px var(--bg-base)",
              }}
            >
              {askCount}
            </span>
          )}
          <StatusLight state={agent.state} size={8} elapsedMs={elapsedMs} />
          <span
            {...noTranslate()}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-primary)",
              letterSpacing: "-0.01em",
            }}
          >
            <span style={{ fontWeight: 400 }}>{agent.desk + 1} ·</span>{" "}
            {agent.name}
          </span>
          {needsAttention && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--bg-base)",
                background: "var(--purple-text)",
                padding: "1px 6px",
                borderRadius: 8,
                letterSpacing: "0.02em",
                boxShadow: "0 0 4px var(--purple)",
                flexShrink: 0,
              }}
            >
              {t("common.unread")}
            </span>
          )}
          {/* Parked on a two-step prompt. Distinct from the
              unread badge: unread means "it answered your message", this means
              "it asked YOU something and is waiting". Amber rather than purple so
              the two never read as the same signal at a glance. */}
          {agent.pendingPrompt && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--bg-base)",
                background: "var(--orange-text)",
                padding: "1px 6px",
                borderRadius: 8,
                letterSpacing: "0.02em",
                flexShrink: 0,
              }}
            >
              {t(PENDING_PROMPT_BADGE[agent.pendingPrompt])}
            </span>
          )}
        </div>
        {agent.topic && (
          <div
            {...noTranslate()}
            style={{
              fontSize: 11,
              color: hov ? "var(--text-secondary)" : "var(--text-dim)",
              textAlign: "center",
              marginTop: 2,
              maxWidth: 160,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              transition: "color 0.2s",
            }}
          >
            {agent.topic}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Tap and long press on a touch screen. React registers touch listeners as
 * passive, which silently ignores preventDefault(), so these are attached by
 * hand: preventDefault() suppresses the native long-press menu, text
 * selection and the synthetic mouse events (and so a second click). A tap
 * calls onTap; a press held 500 ms calls onLongPress, and the returned ref
 * stays true until the next touch so the element's onClick can skip it.
 */
function useTapAndLongPress(
  ref: RefObject<HTMLElement | null>,
  onTap: RefObject<() => void>,
  onLongPress: RefObject<(e: React.MouseEvent) => void>,
) {
  const triggered = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    function handleTouchStart(e: TouchEvent) {
      e.preventDefault();
      triggered.current = false;
      const touch = e.touches[0];
      timer = setTimeout(() => {
        timer = null;
        triggered.current = true;
        onLongPress.current({
          clientX: touch.clientX,
          clientY: touch.clientY,
          preventDefault() {},
        } as unknown as React.MouseEvent);
      }, 500);
    }
    function handleTouchEnd(e: TouchEvent) {
      cancel();
      if (triggered.current) {
        e.preventDefault();
      } else {
        onTap.current();
      }
    }

    el.addEventListener("touchstart", handleTouchStart, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: false });
    el.addEventListener("touchmove", cancel, { passive: true });
    return () => {
      cancel();
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchmove", cancel);
    };
  }, [ref, onTap, onLongPress]);
  return triggered;
}
