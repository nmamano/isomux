// The desk menu offers "Move to back room" only where the room's back room
// setting is on (task b16f1e6a), and the live setting reaches the store.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { ContextMenu } = await import("./ContextMenu.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { reducer, initialState } = await import("../store.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { DEFAULT_AGENT_CAPABILITIES } = await import("../../shared/types.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type RoomWire = import("../../shared/types.ts").RoomWire;

const moveToBack = translatorFor("en").t("contextMenu.moveToBackRoom");

const agent: AgentInfo = {
  id: "a1",
  name: "Front",
  roomId: "r1",
  desk: 0,
  cwd: "~",
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: null,
    hat: "none",
  },
  permissionMode: "bypassPermissions",
  modelFamily: "sonnet",
  effort: "high",
  state: "idle",
  topic: null,
  topicGenerating: false,
  customInstructions: "",
  customInstructionsVersion: "v1",
  agentType: "claude",
  capabilities: DEFAULT_AGENT_CAPABILITIES,
  userId: "u1",
  manager: "Tester",
  queue: [],
  sessionSwapping: false,
  turnMemberIds: [],
};

const room = (backRoom?: boolean): RoomWire => ({
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
  ...(backRoom === undefined ? {} : { backRoom }),
});

describe("desk menu", () => {
  for (const backRoom of [true, false, undefined]) {
    it(`back room ${backRoom === true ? "on" : `off (${backRoom})`}: ${backRoom ? "offers" : "hides"} the move to the back room`, async () => {
      const requests: Array<{ path: string; body: unknown }> = [];
      setApiShim(async (_method, path, body) => {
        requests.push({ path, body });
        if (path.includes("/sessions"))
          return { sessions: [], currentSessionId: null };
        return {};
      });
      const view = render(
        onLanguage(
          "en",
          <ContextMenu
            x={0}
            y={0}
            agent={agent}
            onClose={() => {}}
            onEdit={() => {}}
          />,
          {
            rooms: [room(backRoom)],
            agents: [agent],
            hasReceivedInitialState: true,
          },
        ),
      );
      try {
        await act(async () => {});
        const items = [...view.container.querySelectorAll("button")].filter(
          (b) => b.textContent === moveToBack,
        );
        expect(items).toHaveLength(backRoom ? 1 : 0);
        if (backRoom) {
          await act(async () => fireEvent.click(items[0]));
          expect(requests).toContainEqual({
            path: "/api/agents/a1/move",
            body: { targetRoomId: "r1", desk: null },
          });
        }
      } finally {
        view.unmount();
        setApiShim(null);
      }
    });
  }
});

it("room_back_room_updated sets the room's flag in the store", () => {
  const state = { ...initialState, rooms: [room(), { ...room(), id: "r2" }] };
  const next = reducer(state, {
    type: "room_back_room_updated",
    roomId: "r1",
    backRoom: true,
  });
  // Only that room: the other keeps no flag.
  expect(next.rooms.map((r) => r.backRoom)).toStrictEqual([true, undefined]);
});
