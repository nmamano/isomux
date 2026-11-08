// Recent then complete (task 9ebe887d slice 3). A chat opens with its last
// RECENT_TAIL entries; the rest loads at once (ui/agent-log.ts loadRestOfLog)
// on the first scroll to the top, the top row's button, a jump to an entry
// that is not loaded, or the Copy menu. LogView and WidgetChat call
// useLoadRest for their scroll container; ChatTranscript renders the top row
// and serves jumps (ChatJump) from it.

import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { LogEntry } from "../../shared/types.ts";
import { loadRestOfLog } from "../agent-log.ts";
import { useAppState, useDispatch } from "../store.tsx";

// recent: the chat shows its last entries (or loads them). loadingRest: the
// whole load runs and the chat shows entries that are not the whole log.
// complete: the chat shows (or reloads) the whole log.
export type ChatLevel = "recent" | "loadingRest" | "complete";

export interface ChatRest {
  // null: no stream, or a server that keeps the connect replay (W2).
  level: ChatLevel | null;
  loadRest: () => void;
}

/** The chat's level and loadRest for one surface. Loads the rest on a scroll
 *  that moves up to within LOAD_REST_TOP_PX of the top, and keeps the entry
 *  at the top of the view in place when the swap prepends entries (D6). */
export function useLoadRest(
  scrollRef: RefObject<HTMLElement | null>,
  agentId: string | null,
  logs: readonly LogEntry[],
): ChatRest {
  const { logStreams, logsComplete, logsOnOpen } = useAppState();
  const dispatch = useDispatch();
  const stream = agentId ? logStreams.get(agentId) : undefined;
  let level: ChatLevel | null = null;
  if (logsOnOpen && agentId && stream) {
    if (stream.state === "complete" || logsComplete.has(agentId))
      level = "complete";
    else if (stream.state === "loading" && stream.tail === undefined)
      level = "loadingRest";
    else level = "recent";
  }
  const loadRest = useCallback(() => {
    if (agentId) loadRestOfLog(dispatch, agentId);
  }, [agentId, dispatch]);
  const partial = level === "recent" || level === "loadingRest";

  // D6. While the chat is not whole, the entry at the top of the view and its
  // offset from the container's top are saved at each commit and scroll. When
  // a commit prepends entries (the first id changed and the saved entry is
  // still there), scrollTop moves by the saved entry's change of offset: 0
  // when the browser's own scroll anchoring already kept it (Chrome), the
  // height of the new entries when it did not (Safari). An image that loads
  // above it before the member scrolls again is corrected the same way.
  const saved = useRef<{ id: string; offset: number } | null>(null);
  const firstId = useRef<string | undefined>(undefined);
  // Set after a correction, until the member scrolls: the scrollTop we set.
  const holding = useRef<number | null>(null);
  const measure = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    for (const node of root.querySelectorAll<HTMLElement>(
      "[data-log-entry-id]",
    )) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top) {
        saved.current = {
          id: node.dataset.logEntryId ?? "",
          offset: rect.top - top,
        };
        return;
      }
    }
    saved.current = null;
  }, [scrollRef]);
  const correct = useCallback(() => {
    const root = scrollRef.current;
    const anchor = saved.current;
    if (!root || !anchor) return;
    const node = root.querySelector<HTMLElement>(
      `[data-log-entry-id="${anchor.id}"]`,
    );
    if (!node) return;
    const offset =
      node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    const delta = offset - anchor.offset;
    if (delta !== 0) root.scrollTop += delta;
    holding.current = root.scrollTop;
  }, [scrollRef]);
  useLayoutEffect(() => {
    const first = logs[0]?.id;
    const before = firstId.current;
    firstId.current = first;
    if (
      saved.current &&
      before !== undefined &&
      first !== before &&
      logs.some((entry) => entry.id === before)
    )
      correct();
    if (partial) measure();
  }, [logs, partial, measure, correct]);

  // The listeners on the scroll container read the latest values here.
  const latest = useRef({ level, loadRest, partial, measure, correct });
  useLayoutEffect(() => {
    latest.current = { level, loadRest, partial, measure, correct };
  });
  // The scroll trigger: only a move up that ends near the top, so the first
  // render and the pin to the bottom never load anything.
  const lastTop = useRef<number | null>(null);
  const listened = useRef<HTMLElement | null>(null);
  // No deps: the container can mount after this surface.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (listened.current !== el) {
      listened.current = el;
      lastTop.current = el.scrollTop;
    }
    const onScroll = () => {
      const now = latest.current;
      const top = el.scrollTop;
      const movedUp = lastTop.current !== null && top < lastTop.current;
      lastTop.current = top;
      // Our own correction fires a scroll event too: it keeps the hold.
      if (holding.current === null || top !== holding.current) {
        holding.current = null;
        if (now.partial) now.measure();
      }
      if (movedUp && top <= LOAD_REST_TOP_PX && now.level === "recent")
        now.loadRest();
    };
    const onLoad = () => {
      if (holding.current !== null) latest.current.correct();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // load does not bubble: listen in the capture phase.
    el.addEventListener("load", onLoad, true);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("load", onLoad, true);
    };
  });

  return { level, loadRest };
}

export const LOAD_REST_TOP_PX = 50;

// What a jump link targets: an entry, or the card that created an ask (its
// origin, known only once the entry is loaded).
export type JumpTarget = { entryId: string } | { askId: string };

// A jump from a link inside a chat surface. ChatTranscript provides it: it
// rings the entry in its own surface, or, in a recent chat, loads the rest
// and rings it when it renders. `from` is the clicked element.
export type ChatJumpFn = (target: JumpTarget, from: Element) => void;
export const ChatJump = createContext<ChatJumpFn | null>(null);
// The level of the chat a transcript shows (null outside one, or with no
// level): AskLink offers its jump in a chat that is not whole yet.
export const ChatLevelContext = createContext<ChatLevel | null>(null);
