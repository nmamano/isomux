// The two-column page of Settings, Integrations and Agent settings (task
// 59538509): a header bar with the close control and the title, a list
// column on the left and the open entry on the right. On a phone exactly one
// column shows: the list first, then the entry with a back row to the list.
// What the list holds and what an entry shows is the page's business.

import type { ReactNode } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";

export function SidebarPage({
  title,
  subtitle,
  onClose,
  listShown,
  onBackToList,
  backLabel,
  list,
  listLabel,
  children,
  rootAttrs,
  detailAttrs,
  backAttrs,
}: {
  title: ReactNode;
  // A line beside the title, such as the agent's room and desk.
  subtitle?: ReactNode;
  // The header's close control: back to what the page was opened over.
  onClose: () => void;
  // Phone only: true shows the list, false the open entry.
  listShown: boolean;
  onBackToList: () => void;
  // The phone back row's text, after its arrow: the page's name.
  backLabel: ReactNode;
  list: ReactNode;
  // The list column's accessible name.
  listLabel: string;
  // The open entry.
  children: ReactNode;
  // Data attributes the page's tests and styles find it by.
  rootAttrs?: Record<string, string>;
  detailAttrs?: Record<string, string>;
  backAttrs?: Record<string, string>;
}) {
  const { isMobile } = useAppState();
  const { t } = useI18n();
  const showList = !isMobile || listShown;
  const showDetail = !isMobile || !listShown;
  return (
    <div
      {...rootAttrs}
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
      {/* Header - same bar as the Tasks/Cronjobs pages, apart from the
          labelled close control (see below). minHeight (not height) so the
          safe-area-inset-top padding extends the bar below the camera notch
          instead of being squashed into the 44px box. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: isMobile ? "0 12px" : "0 20px",
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          minHeight: 44,
          background: "var(--bg-hud)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--border-subtle)",
          flexShrink: 0,
          zIndex: 500,
        }}
      >
        {/* Closes the page, back to what it was opened over. It says Close
            on every device, as Nil asked (task d10f0dbd): on a phone the
            entry has its own back row to the list, so a bare arrow or "Back"
            here would read as one more "back to the list". */}
        <button
          onClick={onClose}
          data-page-close=""
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            // A labelled control carries its own width; at the 18px of a
            // bare arrow the words would outweigh the page title beside them.
            fontSize: 13,
            cursor: "pointer",
            padding: "2px 8px",
            whiteSpace: "nowrap",
          }}
        >
          &larr; {t("common.close")}
        </button>
        <h1
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            margin: 0,
            flexShrink: 0,
          }}
        >
          {title}
        </h1>
        {subtitle !== undefined && (
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </span>
        )}
      </div>

      {/* Body: the list + the open entry. On a phone exactly one shows. */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {showList && (
          <nav
            aria-label={listLabel}
            style={{
              width: isMobile ? "100%" : 260,
              flexShrink: 0,
              borderRight: isMobile
                ? undefined
                : "1px solid var(--border-subtle)",
              overflowY: "auto",
              overscrollBehavior: "contain",
              display: "flex",
              flexDirection: "column",
              padding: "12px 0",
              boxSizing: "border-box",
            }}
          >
            {list}
          </nav>
        )}

        {showDetail && (
          <div
            {...detailAttrs}
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              overscrollBehavior: "contain",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {isMobile && (
              <button
                onClick={onBackToList}
                data-page-back-to-list=""
                {...backAttrs}
                style={{
                  alignSelf: "flex-start",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  cursor: "pointer",
                  padding: "10px 16px 4px",
                }}
              >
                &larr; {backLabel}
              </button>
            )}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
