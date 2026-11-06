// The Inbox (task c952e551): its header and the Asks view. Pages were their
// own tab until they became paged asks (task 74e8fc07); they show as asks.

import type { ReactNode } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { useInboxCounts } from "../inbox.ts";
import { CHAT_PANEL_RIGHT, CHAT_PANEL_WIDTH } from "../AppWidgetPage.tsx";
import { INBOX_CHAT_PHONE_SHARE } from "./AgentChatPanel.tsx";

export function InboxView({
  onClose,
  chatOpen,
  children,
}: {
  onClose: () => void;
  /** The chat panel (AgentChatPanel) is open over the Inbox. */
  chatOpen: boolean;
  children: ReactNode;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  // Every open ask, whatever the Asks filters: the number the bar's title
  // gives, which a phone never shows (task 760818d5).
  const { asks: openAsks } = useInboxCounts();
  // The open chat panel sits over the bottom right corner. The content keeps
  // clear of it: on a desktop the content ends left of the panel, with a
  // 20px gap; on a phone it ends above the panel (its share of the height,
  // above the larger of its two bottom insets, usePhonePanelBox and
  // .agent-chat-panel), with an 8px gap.
  const chatRoom = !chatOpen
    ? undefined
    : isMobile
      ? {
          paddingBottom: `calc(${INBOX_CHAT_PHONE_SHARE * 100}dvh + max(20px, env(safe-area-inset-bottom)) + 8px)`,
        }
      : { paddingRight: CHAT_PANEL_WIDTH + CHAT_PANEL_RIGHT + 20 };

  return (
    <div
      data-inbox=""
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
        {openAsks > 0 && (
          <span
            data-inbox-ask-count=""
            style={{ fontSize: 13, color: "var(--text-muted)" }}
          >
            {openAsks}
          </span>
        )}
      </div>

      <div
        data-inbox-content=""
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          ...chatRoom,
        }}
      >
        {children}
      </div>
    </div>
  );
}
