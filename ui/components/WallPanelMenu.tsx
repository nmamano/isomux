import { useEffect, useRef, type ReactNode } from "react";
import { Portal } from "./Portal.tsx";

export type WallPanelMenuItem = {
  id: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
};

interface Props {
  x: number;
  y: number;
  items: WallPanelMenuItem[];
  onClose: () => void;
}

export function WallPanelMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleDismiss(e: Event) {
      const target = (e as TouchEvent).touches?.[0]?.target ?? e.target;
      if (ref.current && !ref.current.contains(target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleDismiss);
    document.addEventListener("touchstart", handleDismiss);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDismiss);
      document.removeEventListener("touchstart", handleDismiss);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Keep the menu within the viewport
  const MENU_W = 200;
  const MENU_H_EST = items.length * 38 + 20;
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H_EST - 8);

  return (
    <Portal>
      <div
        ref={ref}
        style={{
          position: "fixed",
          left: Math.max(8, left),
          top: Math.max(8, top),
          zIndex: 1000,
          background: "var(--bg-overlay)",
          backdropFilter: "blur(16px)",
          border: "1px solid var(--border-light)",
          borderRadius: 12,
          padding: 5,
          minWidth: MENU_W,
          boxShadow: "0 12px 40px var(--shadow-heavy)",
          animation: "hudIn 0.12s ease-out",
        }}
      >
        <div
          style={{
            padding: "5px 10px",
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-faint)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Settings
        </div>
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "7px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 13,
              borderRadius: 6,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              style={{
                width: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </Portal>
  );
}
