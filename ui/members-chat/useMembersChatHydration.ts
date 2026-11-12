import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import * as chatApi from "./api.ts";
import { chatApiFor } from "./api.ts";
import type { HumanChatKey } from "../human-chat.ts";

// Load the chat page while a panel is open; full_state carries the unread
// count. Only the visible panel advances the read pointer. full_state
// invalidates loaded after reconnect.
export function useMembersChatHydration(enabled: boolean) {
  const {
    membersChat: { loaded, messages, pinsRevision = 0, pinsStale = false },
    hydrationEpoch,
  } = useAppState();
  const dispatch = useDispatch();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const snapshotRequest = useEffectEvent(() => ({
    heldAtRequest: messages.map((message) => message.id),
    pinsRevisionAtRequest: pinsRevision,
  }));
  useEffect(() => {
    if (!enabled || loaded) return;
    const snapshot = snapshotRequest();
    let cancelled = false;
    chatApi
      .fetchPage({ limit: chatApi.MEMBERS_CHAT_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        if (!Array.isArray(page.messages))
          throw new Error("Invalid members chat page");
        dispatch({
          type: "members_chat_page",
          ...page,
          prepend: false,
          ...snapshot,
        });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    // A retry or reconnect cancels the previous response before issuing a
    // new fetch, so overlapping requests cannot overwrite the newer result.
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, hydrationEpoch, dispatch, attempt]);
  // Refill the pinned list and its overflow sentinel after a live mutation. Revision matching
  // prevents an older HTTP snapshot from undoing a newer socket update.
  // On failure, keep the live list; refill waits for Retry or the next pin event.
  useEffect(() => {
    if (!enabled || !loaded || !pinsStale) return;
    let cancelled = false;
    chatApi
      .fetchPage({ limit: chatApi.MEMBERS_CHAT_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        if (!Array.isArray(page.pinned))
          throw new Error("Invalid members chat pins");
        dispatch({
          type: "members_chat_pins",
          pinned: page.pinned,
          pinsRevisionAtRequest: pinsRevision,
        });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, pinsStale, pinsRevision, dispatch, attempt]);
  return { loadFailed, retry };
}

// A 1:1 chat's page while it is open: fetched once per hydration epoch (a
// full_state drops loaded), by the peer's id.
function useDmHydration(peerId: string | null) {
  const { memberDms, hydrationEpoch } = useAppState();
  const dm = peerId === null ? null : memberDms[peerId];
  const loaded = dm?.loaded ?? false;
  const dispatch = useDispatch();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const heldNow = useEffectEvent(() =>
    (dm?.messages ?? []).map((message) => message.id),
  );
  useEffect(() => {
    if (peerId === null || loaded) return;
    const heldAtRequest = heldNow();
    let cancelled = false;
    chatApiFor({ kind: "dm", peerId })
      .fetchPage({ limit: chatApi.MEMBERS_CHAT_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        if (!Array.isArray(page.messages))
          throw new Error("Invalid 1:1 chat page");
        dispatch({
          type: "dm_page",
          peerId,
          messages: page.messages,
          hasMore: page.hasMore,
          readPointer: page.readPointer,
          unread: page.unread,
          prepend: false,
          heldAtRequest,
        });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [peerId, loaded, hydrationEpoch, dispatch, attempt]);
  return { loadFailed: peerId !== null && loadFailed, retry };
}

// The open human chat's page: Members chat or a 1:1 chat.
export function useHumanChatHydration(chat: HumanChatKey) {
  const members = useMembersChatHydration(chat.kind === "members");
  const dm = useDmHydration(chat.kind === "dm" ? chat.peerId : null);
  return chat.kind === "members" ? members : dm;
}
