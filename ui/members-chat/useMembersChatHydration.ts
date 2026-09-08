import { useCallback, useEffect, useState } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import * as chatApi from "./api.ts";

// Load unread state even when the chat is closed. Only the visible panel
// advances the read pointer. full_state invalidates loaded after reconnect.
export function useMembersChatHydration(enabled: boolean) {
  const {
    membersChat: { loaded },
    hydrationEpoch,
  } = useAppState();
  const dispatch = useDispatch();
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || loaded) return;
    let cancelled = false;
    chatApi
      .fetchPage({ limit: chatApi.MEMBERS_CHAT_PAGE_LIMIT })
      .then((page) => {
        if (cancelled) return;
        if (!Array.isArray(page.messages))
          throw new Error("Invalid members chat page");
        dispatch({ type: "members_chat_page", ...page, prepend: false });
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, hydrationEpoch, dispatch, attempt]);
  return { loadFailed, retry };
}
