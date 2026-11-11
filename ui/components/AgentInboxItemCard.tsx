// A card of the Inbox's Asks tab for an agent item (task ddf02829): an agent
// waiting on a permission request, answered in place with the chat's own
// choice card, or an agent that failed, with its error and a Dismiss for the
// member. Both open the agent's chat. Who sees which item is
// ui/inbox-agent-items.ts.

import { useState } from "react";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";
import { ChoiceInteractionCard } from "../log-view/LogView.tsx";
import { filledSecondaryBtn } from "./dialog-styles.ts";
import { logEntryText } from "../../shared/i18n/log-message.ts";
import type { AgentInfo } from "../../shared/types.ts";
import type { AgentInboxItem } from "../inbox-agent-items.ts";

// The most lines of an error or a permission's input the card shows.
const CLAMP_LINES = 3;

export function AgentInboxItemCard({
  item,
  agent,
  roomName,
  isMobile,
  onOpenChat,
  onDismiss,
}: {
  item: AgentInboxItem;
  agent: AgentInfo;
  roomName: string;
  isMobile: boolean;
  onOpenChat: (agentId: string) => void;
  // Failed items only. Rejects when the dismiss is not saved.
  onDismiss?: () => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [dismiss, setDismiss] = useState<"idle" | "sending" | "failed">("idle");
  const failed = item.kind === "failed";
  const small = isMobile ? 12 : 11;
  const button: React.CSSProperties = {
    ...filledSecondaryBtn,
    padding: isMobile ? "8px 14px" : "5px 14px",
  };
  // Long text (an error, a command) shows its first lines; the chat has it
  // all.
  const clamped: React.CSSProperties = {
    color: "var(--text-dim)",
    fontSize: isMobile ? 13 : 12,
    lineHeight: 1.5,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: CLAMP_LINES,
    overflow: "hidden",
  };
  const permission =
    item.kind === "permission" ? item.interaction?.permission : undefined;

  async function sendDismiss() {
    if (!onDismiss || dismiss === "sending") return;
    setDismiss("sending");
    try {
      await onDismiss();
      setDismiss("idle");
    } catch {
      setDismiss("failed");
    }
  }

  return (
    <div
      data-agent-item={item.key}
      style={{
        padding: isMobile ? "9px 10px 10px 11px" : "8px 10px 9px 11px",
        borderRadius: 8,
        background: "var(--bg-subtle)",
        border: "1px solid var(--border-light)",
        borderLeft: `3px solid ${failed ? "var(--red)" : "var(--orange)"}`,
        marginBottom: 6,
        fontFamily: "var(--font-ui)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span
          style={{
            color: failed ? "var(--red-text)" : "var(--text-primary)",
            fontSize: isMobile ? 14 : 13,
            fontWeight: 600,
          }}
        >
          {t(failed ? "asks.agentItem.failed" : "asks.agentItem.permission")}
        </span>
        <span
          {...noTranslate()}
          style={{ color: "var(--text-primary)", fontSize: isMobile ? 14 : 13 }}
        >
          {agent.name}
        </span>
        <span
          {...noTranslate()}
          style={{ color: "var(--text-muted)", fontSize: small }}
        >
          {roomName}
        </span>
      </div>
      {item.kind === "failed" && (
        <div data-agent-item-text="" style={{ ...clamped, marginTop: 4 }}>
          {logEntryText(i18n, item.failure)}
        </div>
      )}
      {/* What the permission is for, as the chat shows it above its card:
          the backend's reason and the tool input (a command, a file). */}
      {permission?.description && (
        <div
          data-agent-item-description=""
          {...noTranslate()}
          style={{ ...clamped, marginTop: 4 }}
        >
          {permission.description}
        </div>
      )}
      {permission &&
        Object.entries(permission.input).map(([key, value]) => (
          <div
            key={key}
            data-agent-item-input={key}
            {...noTranslate()}
            style={{
              ...clamped,
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
            }}
          >
            {value}
          </div>
        ))}
      {item.kind === "permission" && item.interaction && (
        <ChoiceInteractionCard interaction={item.interaction} />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
        }}
      >
        <button
          type="button"
          data-agent-item-open=""
          onClick={() => onOpenChat(item.agentId)}
          style={button}
        >
          {t("asks.agentItem.openChat")}
        </button>
        {failed && onDismiss && (
          <button
            type="button"
            data-agent-item-dismiss=""
            disabled={dismiss === "sending"}
            onClick={() => void sendDismiss()}
            style={{
              ...button,
              cursor: dismiss === "sending" ? "wait" : "pointer",
            }}
          >
            {t("common.dismiss")}
          </button>
        )}
        {dismiss === "failed" && (
          <span
            role="alert"
            style={{ color: "var(--red-text)", fontSize: small }}
          >
            {t("asks.agentItem.dismissFailed")}
          </span>
        )}
      </div>
    </div>
  );
}
