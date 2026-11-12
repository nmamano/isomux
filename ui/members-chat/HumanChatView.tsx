// A human chat full screen in the main pane (task 019e4d7c): Members chat or a
// 1:1 chat, where LogView shows an agent chat. On a phone (no sidebar), its
// title is the chat switcher.
import { humanChatId, type HumanChatKey } from "../human-chat.ts";
import { useAppState } from "../store.tsx";
import { MembersChatPanel } from "./MembersChatPanel.tsx";
import { HumanChatSwitcher } from "./HumanChatSwitcher.tsx";
import { useHumanChatHydration } from "./useMembersChatHydration.ts";

export interface HumanChatViewProps {
  chat: HumanChatKey;
  // The header's Back: to what was under the chat.
  onBack: () => void;
  // Switch to another human chat (the switcher).
  onSelectChat: (chat: HumanChatKey) => void;
  // An owner's "<name>'s settings": Settings on that member.
  onOpenMemberSettings: (userId: string) => void;
  // The desktop sidebar is shown beside the chat.
  sidebarOpen?: boolean;
  // Shows the collapsed desktop sidebar; absent when there is none.
  onShowSidebar?: () => void;
}

export function HumanChatView({
  chat,
  onBack,
  onSelectChat,
  onOpenMemberSettings,
  sidebarOpen = false,
  onShowSidebar,
}: HumanChatViewProps) {
  const { isMobile } = useAppState();
  const { loadFailed, retry } = useHumanChatHydration(chat);
  const id = humanChatId(chat);
  return (
    <div
      data-human-chat={id}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-base)",
        color: "var(--text-primary)",
      }}
    >
      <MembersChatPanel
        // One panel per chat: its reply, files and errors stay with it.
        key={id}
        chat={chat}
        onClose={sidebarOpen ? undefined : onBack}
        onShowSidebar={onShowSidebar}
        switcher={
          isMobile ? (
            <HumanChatSwitcher
              current={chat}
              onSelect={onSelectChat}
              onOpenMemberSettings={onOpenMemberSettings}
            />
          ) : undefined
        }
        onOpenMemberSettings={onOpenMemberSettings}
        loadFailed={loadFailed}
        onRetry={retry}
        style={{ flex: 1, minHeight: 0 }}
      />
    </div>
  );
}
