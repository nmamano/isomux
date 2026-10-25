// The ask card's "Discuss in chat" button: it puts "About your ask
// "<excerpt>": " in front of the agent's chat draft and has the composer take
// focus with the caret after it (prefix_draft; LogView does the focus). The
// member writes and sends a normal message, and the ask stays open. On the
// Inbox, onFocusAgent also opens the agent's chat.

import { useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import type { AskMemberWire } from "../../shared/types.ts";
import { askExcerpt } from "./ask-about.ts";

export function AskAboutButton({
  entry,
  isMobile,
  disabled,
  onFocusAgent,
}: {
  entry: AskMemberWire;
  isMobile: boolean;
  disabled: boolean;
  onFocusAgent?: (agentId: string) => void;
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
        onFocusAgent?.(entry.agentId);
      }}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        color: "var(--accent-text)",
        fontSize: isMobile ? 13 : 12,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {t("asks.discuss")}
    </button>
  );
}
