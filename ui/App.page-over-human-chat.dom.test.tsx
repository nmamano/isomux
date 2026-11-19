// A page opened over a room chat or a DM (task 930a1385): its Close names
// that chat - a room chat by its title, a DM by the peer's name, kept
// from browser translation - and goes back to it. Over an agent chat Close
// names the agent (ui/test-support/over-chat-fixture.ts); over the office it
// names the office (ui/App.pages.dom.test.tsx).

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { initialState } = await import("./store.tsx");
const { en } = await import("../shared/i18n/en.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { lobbyChats } = await import("./test-support/room-chats.ts");
const { Harness, clickClose, closeLabel, closesInPlace, press, setUpOverChat } =
  await import("./test-support/over-chat-fixture.ts");
type View = import("./test-support/over-chat-fixture.ts").View;
type HumanChatKey = import("./human-chat.ts").HumanChatKey;

setUpOverChat();

const PEER = { id: "u2", name: "Robin", username: "robin" };
const ALPHA = {
  id: "r1",
  name: "Alpha",
  prompt: null,
  canCloseWhenEmpty: true,
};

function overChat(chat: HumanChatKey): typeof initialState {
  return {
    ...initialState,
    hasReceivedInitialState: true,
    usersLoaded: true,
    users: new Map([[PEER.username, PEER]]),
    // full_state's summaries: the lobby's chat and Alpha's are reached.
    rooms: [ALPHA],
    roomChats: { ...lobbyChats({}), [ALPHA.id]: lobbyChats({}).lobby },
    openHumanChat: chat,
  } as unknown as typeof initialState;
}

const chatShown = (view: View, id: string) =>
  view.baseElement.querySelector(`[data-human-chat="${id}"]`) !== null;
const tasksOpen = (view: View) =>
  view.baseElement.querySelector("[data-tasks-page]") !== null;

const CASES: Array<{
  name: string;
  chat: HumanChatKey;
  id: string;
  label: { text: string; noTranslate: boolean };
}> = [
  {
    name: "the lobby's room chat",
    chat: { kind: "room", roomId: "lobby" },
    id: "room:lobby",
    label: {
      text: translatorFor("en").t("roomChat.title", {
        room: en["common.lobby"],
      }),
      noTranslate: false,
    },
  },
  // A room's name is member content: kept from browser translation, as a
  // peer's name is (task 5b055cf3). The lobby's title is the catalog's.
  {
    name: "a room's chat",
    chat: { kind: "room", roomId: ALPHA.id },
    id: "room:r1",
    label: {
      text: translatorFor("en").t("roomChat.title", { room: ALPHA.name }),
      noTranslate: true,
    },
  },
  {
    name: "a DM",
    chat: { kind: "dm", peerId: PEER.id },
    id: PEER.id,
    label: { text: PEER.name, noTranslate: true },
  },
];

describe("Tasks over a human chat", () => {
  for (const { name, chat, id, label } of CASES)
    it(`Close names ${name} and returns to it`, async () => {
      const view = render(createElement(Harness, { initial: overChat(chat) }));
      expect(chatShown(view, id)).toBe(true);
      await press("t");
      expect(tasksOpen(view)).toBe(true);
      expect(chatShown(view, id)).toBe(false);

      expect(closeLabel(view)).toEqual(label);
      await closesInPlace(() => clickClose(view));
      expect(tasksOpen(view)).toBe(false);
      expect(chatShown(view, id)).toBe(true);
      view.unmount();
    });
});
