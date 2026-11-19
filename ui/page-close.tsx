// Where a page's Close goes, and the words on it (task 930a1385): Close names
// the screen it uncovers, not "Close". App decides the target once, from the
// page stack and what is open under the pages; closePage, Back and the label
// all read that one decision.

import { createContext, useContext, useMemo } from "react";
import type { PlainMessageKey } from "../shared/i18n/translate.ts";
import type { Page } from "../shared/office-links.ts";
import type { HumanChatKey } from "./human-chat.ts";
import { useI18n } from "./i18n.tsx";
import { useDmPeer } from "./members-chat/member-rows.ts";
import { useRoomChatTitle } from "./members-chat/room-chat-rows.ts";
import { PageNavButton } from "./components/PageNavButton.tsx";
import { LOBBY_ROOM_ID } from "../shared/types.ts";

/** What shows when the top page closes. */
export type PageCloseTarget =
  | { kind: "page"; page: Page }
  | { kind: "chat"; chat: HumanChatKey }
  | { kind: "agent"; name: string }
  | { kind: "office" };

/** The target, in the order the content render picks what shows: the page
 *  under the top one, a members chat or DM, an agent's chat, the office. */
export function pageCloseTarget({
  pageBelow,
  humanChat,
  agentName,
}: {
  pageBelow: Page | null;
  humanChat: HumanChatKey | null;
  agentName: string | null;
}): PageCloseTarget {
  if (pageBelow !== null) return { kind: "page", page: pageBelow };
  if (humanChat !== null) return { kind: "chat", chat: humanChat };
  if (agentName !== null) return { kind: "agent", name: agentName };
  return { kind: "office" };
}

// Each page by the name its own header shows (the Inbox, not "Asks").
const PAGE_NAME: Record<Page, PlainMessageKey> = {
  tasks: "common.tasks",
  cronjobs: "common.automations",
  apps: "common.apps",
  skills: "common.skills",
  integrations: "common.integrations",
  settings: "common.settings",
  asks: "nav.inbox",
};

/** The words on a page's Close. A name (an agent, a member, a room's chat)
 *  keeps its form under browser translation; a page name does not. */
export type PageCloseLabel = { text: string; noTranslate: boolean };

/** App provides the label; without a provider Close names the office. */
export const PageCloseLabelContext = createContext<PageCloseLabel | null>(null);

/** The label for a target. A DM names its peer as the chat's header does. */
export function usePageCloseLabelFor(target: PageCloseTarget): PageCloseLabel {
  const { t } = useI18n();
  const peer = useDmPeer(
    target.kind === "chat" && target.chat.kind === "dm"
      ? target.chat.peerId
      : "",
  );
  const roomTitle = useRoomChatTitle(
    target.kind === "chat" && target.chat.kind === "room"
      ? target.chat.roomId
      : "",
  );
  const [text, noTranslate] = ((): [string, boolean] => {
    switch (target.kind) {
      case "page":
        return [t(PAGE_NAME[target.page]), false];
      case "chat":
        return target.chat.kind === "dm"
          ? [peer.name, true]
          : [roomTitle, target.chat.roomId !== LOBBY_ROOM_ID];
      case "agent":
        return [target.name, true];
      case "office":
        return [t("sidebar.office"), false];
    }
  })();
  // One object per label: a memoized page under the provider renders again
  // only when its label changes.
  return useMemo(() => ({ text, noTranslate }), [text, noTranslate]);
}

export function usePageCloseLabel(): PageCloseLabel {
  const { t } = useI18n();
  return (
    useContext(PageCloseLabelContext) ?? {
      text: t("sidebar.office"),
      noTranslate: false,
    }
  );
}

/** A page header's Close: PageNavButton with the label from the context. */
export function PageCloseButton({
  onClick,
  ...attrs
}: {
  onClick: () => void;
  [attr: `data-${string}`]: string;
}): React.ReactElement {
  const { text, noTranslate } = usePageCloseLabel();
  return (
    <PageNavButton
      label={text}
      noTranslate={noTranslate}
      onClick={onClick}
      {...attrs}
    />
  );
}
