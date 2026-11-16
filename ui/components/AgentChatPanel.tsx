// The Inbox's in-place agent chat (task e3c25581): the app page's chat panel
// (WidgetChat, ui/AppWidgetPage.tsx) over the Inbox, on the agent an ask came
// from. A select in its header moves it to any front-desk agent the member
// sees, and "Open full chat" goes to the agent's chat. Its text draft is the agent's
// chat draft (store drafts), so the full chat opens on what was typed here; a
// message is an ordinary member message. App closes the panel when the member
// leaves the Inbox or its agent goes.

import { useAgentLog } from "../agent-log.ts";
import { useCallback, useMemo } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { isBackSeat } from "../../shared/desks.ts";
import { noTranslate } from "../no-translate.ts";
import { chatVisibleEntries } from "../log-view/chat-entries.ts";
import { uploadDraftFiles } from "../log-view/draft-attachments.ts";
import {
  CHAT_PANEL_CSS,
  WidgetChat,
  usePhonePanelBox,
} from "../AppWidgetPage.tsx";
import { CloseIcon } from "./install-icons.tsx";
import { AgentOptions } from "./AgentOptions.tsx";
import { PHONE_TOP } from "../safe-area.ts";

// The top of the phone panel in the office's box: never under the status bar
// or the phone top bar (ui/safe-area.ts).
// The site demo puts the office in a transformed box under its banner
// (ui/demo-entry.tsx), so a fixed top counts from the banner's bottom.
function phoneTop(windowTop: number): string {
  return `max(${windowTop}px - var(--banner-h, 0px), ${PHONE_TOP})`;
}

// The panel has no dock under it, as the app page has: it sits at the bottom.
// On a phone it fills the visible area (task f2e2e953): the whole window with
// the keyboard down, the part above the keyboard with it up. Over the Inbox's
// header (zIndex 500) and under the phone sidebar drawer (styles.ts).
// In the header, "Open full chat" goes under the title, so the select has the
// title's whole line for the agent's name, and Close stays in the corner.
const PANEL_CSS = `
.agent-chat-panel { bottom:max(20px,env(safe-area-inset-bottom)); }
.agent-chat-panel.app-widget-panel-phone { top:${phoneTop(8)}; height:auto; z-index:600; }
.agent-chat-panel .app-widget-header { display:grid; grid-template-columns:auto minmax(0,1fr) auto; grid-template-areas:"avatar title close" "avatar links close"; column-gap:12px; row-gap:4px; }
.agent-chat-panel .app-widget-header .app-widget-avatar { grid-area:avatar; }
.agent-chat-panel .app-widget-header h1 { grid-area:title; display:flex; align-items:center; gap:6px; white-space:nowrap; }
.agent-chat-panel .app-widget-header-links { grid-area:links; align-items:flex-start; }
.agent-chat-panel select { min-width:0; max-width:100%; padding:3px 6px; border:1px solid var(--border); border-radius:7px; background:var(--bg-base); color:var(--accent-text); font-weight:600; text-overflow:ellipsis; cursor:pointer; }
.agent-chat-panel .agent-chat-close { grid-area:close; align-self:start; display:flex; padding:4px; border:0; background:none; color:var(--text-secondary); }
.agent-chat-panel .agent-chat-close:hover { color:var(--text-primary); }
`;

export function AgentChatPanel({
  agentId,
  onSelectAgent,
  onClose,
  onOpenFullChat,
}: {
  agentId: string;
  onSelectAgent: (agentId: string) => void;
  onClose: () => void;
  onOpenFullChat: (agentId: string) => void;
}) {
  const state = useAppState();
  const dispatch = useDispatch();
  const { t, rich } = useI18n();
  const agent = state.agents.find((item) => item.id === agentId);
  // Loads this chat when the server loads chats on open (task 9ebe887d).
  useAgentLog(agentId);
  const agentLogs = state.logs.get(agentId);
  const logs = useMemo(() => chatVisibleEntries(agentLogs ?? []), [agentLogs]);
  const phoneBox = usePhonePanelBox(state.isMobile, true, null, 1);
  // The choices, grouped by room (AgentOptions): the front-desk agents. A
  // back-room agent is a choice only while the panel is on it (its ask
  // opened the panel), after its room's front desks.
  const choices = useMemo(
    () =>
      state.agents.filter(
        (item) => !isBackSeat(item.desk) || item.id === agentId,
      ),
    [state.agents, agentId],
  );
  const onDraft = useCallback(
    (text: string) => dispatch({ type: "set_draft", agentId, text }),
    [dispatch, agentId],
  );
  const draftItems = state.draftAttachments.get(agentId);
  const attachmentsDraft = useMemo(
    () => ({
      items: draftItems ?? [],
      add: (files: File[]) =>
        uploadDraftFiles(dispatch, agentId, files, { imagesOnly: true }),
      remove: (ids: string[]) =>
        dispatch({ type: "remove_draft_attachments", agentId, ids }),
    }),
    [draftItems, dispatch, agentId],
  );
  const onFocusHandled = useCallback(
    () => dispatch({ type: "composer_focus_handled", agentId }),
    [dispatch, agentId],
  );
  if (!agent) return null;

  const select = (
    <select
      {...noTranslate()}
      data-agent-chat-select=""
      aria-label={t("common.agent")}
      value={agent.id}
      onChange={(event) => onSelectAgent(event.target.value)}
    >
      <AgentOptions agents={choices} rooms={state.rooms} />
    </select>
  );
  return (
    <section
      data-agent-chat-panel=""
      className={
        state.isMobile
          ? "app-widget-panel app-widget-panel-phone agent-chat-panel"
          : "app-widget-panel agent-chat-panel"
      }
      role="dialog"
      aria-label={t("appWidget.title", { agentName: agent.name })}
      // Placed by its top edge, as the app page's panel: in the iPhone Home
      // Screen app the keyboard shrinks innerHeight but not the box fixed
      // elements sit in, so a bottom placement put the panel behind the
      // keyboard (task f2e2e953).
      style={
        phoneBox
          ? {
              top: `calc(${phoneTop(phoneBox.top)})`,
              height: `calc(${phoneBox.top + phoneBox.height}px - var(--banner-h, 0px) - ${phoneTop(phoneBox.top)})`,
              bottom: "auto",
            }
          : undefined
      }
      onKeyDown={(event) => {
        // Only the panel closes: App's Escape would close the Inbox too.
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <style>{CHAT_PANEL_CSS + PANEL_CSS}</style>
      {/* Keyed: the widget's own state starts fresh for each agent. */}
      <WidgetChat
        key={agent.id}
        agent={agent}
        logs={logs}
        stateChangedAt={state.stateChangedAt.get(agent.id)}
        connected={state.connected}
        open
        title={rich("appWidget.title", { agentName: select })}
        headerActions={
          <>
            <div className="app-widget-header-links">
              <button
                type="button"
                className="app-widget-direct"
                data-agent-chat-full=""
                onClick={() => onOpenFullChat(agent.id)}
              >
                {t("appWidget.openFullChat")}
              </button>
            </div>
            <button
              type="button"
              className="agent-chat-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </>
        }
        textDraft={{
          text: state.drafts.get(agent.id) ?? "",
          onChange: onDraft,
        }}
        attachmentsDraft={attachmentsDraft}
        focusRequest={state.pendingComposerFocus.get(agent.id)}
        onFocusRequestHandled={onFocusHandled}
      />
    </section>
  );
}
