// The agent's open asks for this member, less those answered on the Inbox
// (openAsks), stacked newest first above the chat input
// (internal-docs/asks-design.md), one AskCard each. The stack scrolls past a
// maximum height and collapses to one bar: open by default on a desktop,
// collapsed on a phone. A fold is kept per member and agent in this browser
// (ui/view-persistence.ts) until an ask that was not open at the fold arrives.
// Beside the open stack's toggle, "View in Inbox" opens the Inbox's Asks tab
// filtered to this agent (task 586ebfe1), where a long ask reads better.
// Above it, a sign-in link or token an Apply on this agent's ask made
// (AskResultCard) stays until the member closes it, though its ask closed.

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAppState, useFeatures } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { asksFor, openAsks } from "../asks-sync.ts";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { AskCard } from "./AskCard.tsx";
import { AskResultCard } from "./AskResultCard.tsx";
import { sudoAskTitle } from "./SudoAskCard.tsx";
import { valueAskTitle } from "./SecretAskCard.tsx";
import { loadFoldedAsks, saveFoldedAsks } from "../view-persistence.ts";
import { OfficeLinkOpener } from "../office-link.tsx";

// The stack's height before it scrolls: about two and a half cards on a
// desktop, so a cut card shows there is more. On a phone the chat passes a
// share of the visible height (MOBILE_VISIBLE_SHARE), and the stack also
// shrinks to keep the chat input in view; 45vh applies without it.
const MAX_HEIGHT_DESKTOP = 240;
const MAX_HEIGHT_MOBILE = "45vh";
// iOS does not shrink vh when the keyboard opens, so a vh cap let a tall ask
// push the chat input below the keyboard (task 589a8f4f).
export const MOBILE_VISIBLE_SHARE = 0.4;

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
  maxHeight,
}: {
  agentId: string;
  isMobile: boolean;
  maxHeight?: number;
}) {
  const { t } = useI18n();
  const { asks, answeredAsks, askResults, sessionContext } = useAppState();
  const openLink = useContext(OfficeLinkOpener);
  // Newest first, so the ask the agent just opened is the one in view.
  const entries = asksFor(openAsks(asks, answeredAsks), agentId).reverse();
  // No name in the demo, as App's persistEnabled keeps nothing per browser
  // there.
  const { llmConnected } = useFeatures();
  const user = llmConnected ? (sessionContext?.username ?? null) : null;
  // The ask ids open at the member's fold, or null. Read again when the
  // member's name arrives; with no name the fold lives in this mount only.
  const readFold = (u: string | null) => {
    const ids = u ? loadFoldedAsks(u, agentId) : null;
    return ids ? new Set(ids) : null;
  };
  const [foldUser, setFoldUser] = useState(user);
  const [fold, setFold] = useState(() => readFold(user));
  if (foldUser !== user) {
    setFoldUser(user);
    setFold(readFold(user));
  }
  const [openedHere, setOpenedHere] = useState(false);
  const covered = !!fold && entries.every((e) => fold.has(e.id));
  const collapsed = covered || (isMobile && !openedHere);
  // A new ask ends the fold: the stack goes back to the device default.
  const foldEnded = !!fold && !covered;
  useEffect(() => {
    if (!foldEnded) return;
    if (user) saveFoldedAsks(user, agentId, null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFold(null);
  }, [foldEnded, user, agentId]);
  const setCollapsed = (next: boolean) => {
    const ids = next ? entries.map((e) => e.id) : null;
    setFold(ids && new Set(ids));
    setOpenedHere(!next);
    if (user) saveFoldedAsks(user, agentId, ids);
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  // Fade the bottom edge while more cards wait below it.
  const [moreBelow, setMoreBelow] = useState(false);
  // The body's scroll at the end of the last commit or scroll, and the ids
  // it showed; nothing while the stack is collapsed.
  const lastScroll = useRef({ top: 0, height: 0, ids: new Set<string>() });
  const remember = () => {
    const el = bodyRef.current;
    if (!el) {
      lastScroll.current = { top: 0, height: 0, ids: new Set() };
      return;
    }
    lastScroll.current = {
      top: el.scrollTop,
      height: el.scrollHeight,
      ids: new Set(entries.map((e) => e.id)),
    };
  };
  const measure = () => {
    const el = bodyRef.current;
    setMoreBelow(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  const onScroll = () => {
    remember();
    measure();
  };
  // A new ask on top of a scrolled body moves the member's cards down. Keep
  // their place, as iOS Safari has no scroll anchoring. The value is absolute,
  // so a browser that anchored already gets the same scrollTop. At the top the
  // new ask stays in view; a removal is left to the browser.
  const newestId = entries[0]?.id;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const last = lastScroll.current;
    if (el && newestId && last.top > 0 && !last.ids.has(newestId))
      el.scrollTop = last.top + (el.scrollHeight - last.height);
    remember();
  });
  useEffect(measure, [entries.length, collapsed, asks]);
  // The body also shrinks without a change here: the keyboard opens and the
  // chat gives the stack less height.
  const bodyShown = !collapsed && entries.length > 0;
  useEffect(() => {
    const el = bodyRef.current;
    if (!bodyShown || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bodyShown]);

  const results = [...askResults].filter(
    ([, result]) => result.agentId === agentId,
  );
  const resultCards =
    results.length > 0 ? (
      <div data-ask-results="" style={{ flexShrink: 0 }}>
        {results.map(([askId, result]) => (
          <AskResultCard
            key={askId}
            askId={askId}
            result={result}
            isMobile={isMobile}
          />
        ))}
      </div>
    ) : null;
  if (entries.length === 0) return resultCards;
  const toggleStyle = {
    display: "flex",
    alignItems: "center",
    fontFamily: "var(--font-ui)",
    cursor: "pointer",
  } as const;

  if (collapsed)
    return (
      <>
        {resultCards}
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
              {entries[0].secret ? (
                valueAskTitle(t, entries[0].secret)
              ) : entries[0].sudo ? (
                sudoAskTitle(t)
              ) : (
                <InlineMarkdown
                  content={entries[0].prompt.replace(/\s+/g, " ")}
                  code
                  colors
                  links={false}
                  whiteSpace="nowrap"
                />
              )}
            </span>
          </button>
        </div>
      </>
    );

  const fade =
    "linear-gradient(to bottom, black calc(100% - 28px), transparent)";
  return (
    <>
      {resultCards}
      <div
        data-asks-stack="open"
        style={{
          marginBottom: 10,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexShrink: 0,
            padding: "0 0 6px 2px",
          }}
        >
          <button
            type="button"
            aria-expanded={true}
            onClick={() => setCollapsed(true)}
            style={{
              ...toggleStyle,
              gap: 6,
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--text-muted)",
              fontSize: isMobile ? 12 : 11,
              fontWeight: 600,
            }}
          >
            <Chevron open size={isMobile ? 12 : 10} />
            <span>{t("asks.title")}</span>
            <CountPill count={entries.length} isMobile={isMobile} />
          </button>
          {openLink && (
            <button
              type="button"
              data-asks-view-inbox=""
              onClick={() => openLink({ page: "asks", onlyAgent: agentId })}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--accent-text)",
                fontFamily: "var(--font-ui)",
                fontSize: isMobile ? 12 : 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("asks.viewInInbox")}
            </button>
          )}
        </div>
        <div
          ref={bodyRef}
          onScroll={onScroll}
          data-asks-body=""
          data-asks-list=""
          style={{
            maxHeight: isMobile
              ? maxHeight !== undefined
                ? `${maxHeight}px`
                : MAX_HEIGHT_MOBILE
              : MAX_HEIGHT_DESKTOP,
            minHeight: 0,
            overflowY: "auto",
            ...(moreBelow ? { maskImage: fade, WebkitMaskImage: fade } : {}),
          }}
        >
          {entries.map((entry) => (
            <AskCard key={entry.id} entry={entry} isMobile={isMobile} />
          ))}
        </div>
      </div>
    </>
  );
}
