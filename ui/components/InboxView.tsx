// The Inbox (task c952e551): the header and two tabs, Pages (PagerView) and
// Asks (AsksView), each with its open count. The tab is the route: "pager" is
// /inbox/pages and "asks" is /inbox/asks (ui/routes.ts), so App owns it and
// renders the tab's view as children.

import type { ReactNode } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { useInboxCounts, type InboxTab } from "../inbox.ts";

const PANEL_ID = "inbox-panel";
const tabId = (tab: InboxTab) => `inbox-tab-${tab}`;

function TabCount({ count }: { count: number }) {
  return (
    <span
      data-inbox-count=""
      style={{
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 8,
        background: "var(--red)",
        color: "#fff",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "16px",
        textAlign: "center",
        boxSizing: "border-box",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function InboxView({
  tab,
  onSelectTab,
  onClose,
  children,
}: {
  tab: InboxTab;
  onSelectTab: (tab: InboxTab) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  const counts = useInboxCounts();
  const tabs: { tab: InboxTab; label: string; count: number }[] = [
    { tab: "pager", label: t("inbox.tab.pages"), count: counts.pages },
    { tab: "asks", label: t("asks.title"), count: counts.asks },
  ];

  return (
    <div
      style={{
        height: isMobile
          ? "calc(100dvh - var(--banner-h, 0px))"
          : "calc(100vh - var(--banner-h, 0px))",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "4px 12px" : "0 20px",
          paddingTop: isMobile
            ? "max(4px, env(safe-area-inset-top, 0px))"
            : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "2px 8px",
          }}
        >
          &larr;
        </button>
        <span
          style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}
        >
          {t("nav.inbox")}
        </span>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 4,
          padding: isMobile ? "0 12px" : "0 20px",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
        }}
      >
        {tabs.map(({ tab: id, label, count }) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={selected}
              aria-controls={PANEL_ID}
              data-inbox-tab={id}
              onClick={() => {
                if (!selected) onSelectTab(id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                borderBottom: selected
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                marginBottom: -1,
                padding: isMobile ? "10px 10px" : "9px 10px",
                color: selected ? "var(--text-primary)" : "var(--text-muted)",
                fontSize: isMobile ? 14 : 13,
                fontWeight: selected ? 600 : 500,
                fontFamily: "var(--font-ui)",
                cursor: "pointer",
              }}
            >
              {label}
              {count > 0 && <TabCount count={count} />}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={tabId(tab)}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
}
