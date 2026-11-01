// The Inbox's in-place agent chat (task e3c25581): the app page's chat panel
// (WidgetChat, ui/AppWidgetPage.tsx) over the Inbox, on the agent an ask came
// from. A select in its header moves it to any front-desk agent the member
// sees, and "Open full chat" goes to the agent's chat. Its text draft is the agent's
// chat draft (store drafts), so the full chat opens on what was typed here; a
// message is an ordinary member message. App closes the panel when the member
// leaves the Inbox or its agent goes.

import { useCallback, useMemo } from "react";
import { useAppState, useDispatch } from "../store.tsx";
import { useI18n } from "../i18n.tsx";
import { isBackSeat } from "../../shared/desks.ts";
import { noTranslate } from "../no-translate.ts";
import { chatVisibleEntries } from "../log-view/chat-entries.ts";
import {
  CHAT_PANEL_CSS,
  WidgetChat,
  usePhonePanelBox,
} from "../AppWidgetPage.tsx";
import { CloseIcon } from "./install-icons.tsx";

// The panel has no dock under it, as the app page has: it sits at the bottom.
// In the header, "Open full chat" goes under the title, so the select has the
// title's whole line for the agent's name, and Close stays in the corner.
const PANEL_CSS = `
.agent-chat-panel { bottom:max(20px,env(safe-area-inset-bottom)); }
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
  const agentLogs = state.logs.get(agentId);
  const logs = useMemo(() => chatVisibleEntries(agentLogs ?? []), [agentLogs]);
  const phoneBox = usePhonePanelBox(state.isMobile, true, null);
  // The choices: each room in office order, its front-desk agents by desk.
  // A back-room agent is a choice only while the panel is on it (its ask
  // opened the panel), after its room's front desks.
  const groups = useMemo(
    () =>
      state.rooms
        .map((room) => ({
          room,
          agents: state.agents
            .filter(
              (item) =>
                item.roomId === room.id &&
                (!isBackSeat(item.desk) || item.id === agentId),
            )
            .sort((a, b) => a.desk - b.desk),
        }))
        .filter((group) => group.agents.length > 0),
    [state.rooms, state.agents, agentId],
  );
  const onDraft = useCallback(
    (text: string) => dispatch({ type: "set_draft", agentId, text }),
    [dispatch, agentId],
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
      {groups.map(({ room, agents }) => (
        <optgroup key={room.id} label={room.name}>
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </optgroup>
      ))}
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
      // Placed by its bottom edge: the site demo wraps the office in a
      // transformed box under its banner (ui/demo-entry.tsx), which moves a
      // top placement down by the banner and puts Send off screen; the box
      // ends at the window's bottom, so a bottom placement holds.
      style={
        phoneBox
          ? { bottom: phoneBox.inset, height: phoneBox.height, top: "auto" }
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
      {/* Images upload to one agent, so a new agent starts without them. */}
      <WidgetChat
        key={agent.id}
        agent={agent}
        logs={logs}
        stateChangedAt={state.stateChangedAt.get(agent.id)}
        connected={state.connected}
        open
        isMobile={state.isMobile}
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
        focusRequest={state.pendingComposerFocus.get(agent.id)}
        onFocusRequestHandled={onFocusHandled}
      />
    </section>
  );
}
