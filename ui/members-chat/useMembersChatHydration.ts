import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import * as chatApi from "./api.ts";

// Load unread state even when the chat is closed. Only the visible panel
// advances the read pointer. full_state invalidates loaded after reconnect.
export function useMembersChatHydration(enabled: boolean) {
  const {
    membersChat: { loaded, messages },
    hydrationEpoch,
  } = useAppState();
  const dispatch = useDispatch();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const snapshotHeldIds = useEffectEvent(() =>
    messages.map((message) => message.id),
  );
  useEffect(() => {
    if (!enabled || loaded) return;
    const heldAtRequest = snapshotHeldIds();
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
          heldAtRequest,
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
  return { loadFailed, retry };
}
