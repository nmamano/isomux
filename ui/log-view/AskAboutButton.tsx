// The ask card's "Discuss in chat" button, last in the card's bottom row and
// styled by the card like its neighbours: it puts "About your ask
// "<excerpt>": " in front of the agent's chat draft and has the composer take
// focus with the caret after it (prefix_draft; LogView does the focus). The
// member writes and sends a normal message, and the ask stays open. On the
// Inbox, onChatAgent opens the chat panel over it on the agent (task
// e3c25581), which takes the focus request; without it onFocusAgent opens the
// agent's chat.

import { useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import type { CSSProperties } from "react";
import type { AskMemberWire } from "../../shared/types.ts";
import { askExcerpt } from "./ask-about.ts";

export function AskAboutButton({
  entry,
  style,
  disabled,
  onFocusAgent,
  onChatAgent,
}: {
  entry: AskMemberWire;
  style: CSSProperties;
  disabled: boolean;
  onFocusAgent?: (agentId: string) => void;
  onChatAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const dispatch = useDispatch();
  return (
    <button
      type="button"
      data-ask-about=""
      disabled={disabled}
      onClick={() => {
        dispatch({
          type: "prefix_draft",
          agentId: entry.agentId,
          prefix: t("asks.aboutPrefix", { question: askExcerpt(entry.prompt) }),
        });
        (onChatAgent ?? onFocusAgent)?.(entry.agentId);
      }}
      style={style}
    >
      {t("asks.discuss")}
    </button>
  );
}
