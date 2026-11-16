import { NavActions, type NavAction } from "./NavActions.tsx";
import { useI18n } from "../i18n.tsx";
import { SidebarIcon } from "./NavIcons.tsx";
import { SidebarUnreadDot } from "../members-chat/SidebarUnreadDot.tsx";
import type { AgentInfo } from "../../shared/types.ts";

export type RoomCounts = {
  working: number;
  error: number;
};

export function getRoomCounts(roomAgents: AgentInfo[]): RoomCounts {
  return {
    working: roomAgents.filter((a) =>
      ["thinking", "tool_executing"].includes(a.state),
    ).length,
    error: roomAgents.filter((a) => a.state === "error").length,
  };
}

export function MobileHeader({
  counts,
  actions,
  updateAvailable,
  onOpenUpdate,
  onShowSidebar,
}: {
  counts: RoomCounts;
  actions: NavAction[];
  updateAvailable?: boolean;
  onOpenUpdate?: () => void;
  // Opens the phone's sidebar drawer (task 3cced5be); absent in the embed.
  onShowSidebar?: () => void;
}) {
  const { t } = useI18n();
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
        {onShowSidebar && (
          <button
            type="button"
            data-show-sidebar=""
            onClick={onShowSidebar}
            title={t("sidebar.show")}
            aria-label={t("sidebar.show")}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 30,
              borderRadius: 6,
              border: "1px solid var(--border-subtle)",
              background: "var(--btn-surface)",
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {SidebarIcon}
            <SidebarUnreadDot />
          </button>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {(
            [
              {
                n: counts.working,
                c: "var(--green-text)",
                label: "office.status.working",
              },
              {
                n: counts.error,
                c: "var(--red-text)",
                label: "office.status.errShort",
              },
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
                  fontSize: 10,
                  fontWeight: 600,
                  color: s.c,
                  fontFamily: "var(--font-ui)",
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
                {s.n} {t(s.label)}
              </div>
            ))}
        </div>
        {updateAvailable && (
          <span
            onClick={onOpenUpdate}
            title={t("updateNotice.title.newRelease")}
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
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <NavActions actions={actions} viewport="mobile" />
      </div>
    </div>
  );
}
