// The agent's open asks for this member, stacked above the chat input
// (internal-docs/asks-design.md), one AskCard each. The stack scrolls past a
// maximum height and collapses to one bar: open by default on a desktop,
// collapsed on a phone.

import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { asksFor } from "../asks-sync.ts";
import { AskCard } from "./AskCard.tsx";

// The stack's height before it scrolls: about two and a half cards on a
// desktop, so a cut card shows there is more.
const MAX_HEIGHT_DESKTOP = 240;
const MAX_HEIGHT_MOBILE = "45vh";

function Chevron({ open, size }: { open: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : undefined,
        transition: "transform 0.15s",
      }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CountPill({ count, isMobile }: { count: number; isMobile: boolean }) {
  return (
    <span
      style={{
        fontSize: isMobile ? 11 : 10,
        fontWeight: 700,
        color: "var(--bg-base)",
        background: "var(--orange-text)",
        padding: "0 6px",
        borderRadius: 8,
        lineHeight: "16px",
        flexShrink: 0,
      }}
    >
      {count}
    </span>
  );
}

export function AsksStack({
  agentId,
  isMobile,
}: {
  agentId: string;
  isMobile: boolean;
}) {
  const { t } = useI18n();
  const { asks } = useAppState();
  const entries = asksFor(asks, agentId);
  const [collapsed, setCollapsed] = useState(isMobile);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Fade the bottom edge while more cards wait below it.
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = () => {
    const el = bodyRef.current;
    setMoreBelow(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  useEffect(measure, [entries.length, collapsed, asks]);

  if (entries.length === 0) return null;
  const toggleStyle = {
    display: "flex",
    alignItems: "center",
    fontFamily: "var(--font-ui)",
    cursor: "pointer",
  } as const;

  if (collapsed)
    return (
      <div data-asks-stack="collapsed" style={{ marginBottom: 10 }}>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
          style={{
            ...toggleStyle,
            gap: 7,
            width: "100%",
            padding: isMobile ? "9px 10px" : "6px 10px",
            borderRadius: 8,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border-light)",
            borderLeft: "3px solid var(--orange)",
            color: "var(--text-secondary)",
            fontSize: isMobile ? 13 : 12,
            textAlign: "left",
          }}
        >
          <span style={{ color: "var(--text-muted)", display: "flex" }}>
            <Chevron open={false} size={isMobile ? 12 : 10} />
          </span>
          <CountPill count={entries.length} isMobile={isMobile} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {entries[0].secret
              ? t("cards.secretRequest.title", {
                  name: entries[0].secret.name,
                })
              : entries[0].prompt.replace(/\s+/g, " ")}
          </span>
        </button>
      </div>
    );

  const fade =
    "linear-gradient(to bottom, black calc(100% - 28px), transparent)";
  return (
    <div data-asks-stack="open" style={{ marginBottom: 10 }}>
      <button
        type="button"
        aria-expanded={true}
        onClick={() => setCollapsed(true)}
        style={{
          ...toggleStyle,
          gap: 6,
          background: "none",
          border: "none",
          padding: "0 0 6px 2px",
          color: "var(--text-muted)",
          fontSize: isMobile ? 12 : 11,
          fontWeight: 600,
        }}
      >
        <Chevron open size={isMobile ? 12 : 10} />
        <span>{t("asks.title")}</span>
        <CountPill count={entries.length} isMobile={isMobile} />
      </button>
      <div
        ref={bodyRef}
        onScroll={measure}
        data-asks-body=""
        style={{
          maxHeight: isMobile ? MAX_HEIGHT_MOBILE : MAX_HEIGHT_DESKTOP,
          overflowY: "auto",
          ...(moreBelow ? { maskImage: fade, WebkitMaskImage: fade } : {}),
        }}
      >
        {entries.map((entry) => (
          <AskCard key={entry.id} entry={entry} isMobile={isMobile} />
        ))}
      </div>
    </div>
  );
}
