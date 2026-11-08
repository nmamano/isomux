// The desk menu offers "Move to back room" in every room but the lobby, with
// no setting (task e2fb9fa0).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { ContextMenu } = await import("./ContextMenu.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
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
  topicState: null,
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

const room: RoomWire = {
  id: "r1",
  name: "Studio",
  prompt: null,
  canCloseWhenEmpty: true,
};

it("offers the move to the back room in a room with no back room field", async () => {
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
        rooms: [room],
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
    expect(items).toHaveLength(1);
    await act(async () => fireEvent.click(items[0]));
    expect(requests).toContainEqual({
      path: "/api/agents/a1/move",
      body: { targetRoomId: "r1", desk: null },
    });
  } finally {
    view.unmount();
    setApiShim(null);
  }
});

// Kill ends the agent and its running work, with no Undo (task c6589760):
// the first click arms the item and keeps the menu open.
it("Kill Agent asks first: the first click keeps the menu and sends nothing; the second kills once and closes", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  setApiShim(async (method, path) => {
    requests.push({ method, path });
    if (path.includes("/sessions"))
      return { sessions: [], currentSessionId: null };
    return {};
  });
  let closes = 0;
  const view = render(
    onLanguage(
      "en",
      <ContextMenu
        x={0}
        y={0}
        agent={agent}
        onClose={() => {
          closes++;
        }}
        onEdit={() => {}}
      />,
      {
        rooms: [room],
        agents: [agent],
        hasReceivedInitialState: true,
      },
    ),
  );
  const kills = () => requests.filter((r) => r.method === "DELETE");
  try {
    await act(async () => {});
    const killLabel = translatorFor("en").t("contextMenu.killAgent");
    const items = [...view.container.querySelectorAll("button")].filter(
      (b) => b.textContent === killLabel,
    );
    expect(items).toHaveLength(1);
    const kill = items[0];
    await act(async () => fireEvent.click(kill));
    expect([kills(), closes]).toEqual([[], 0]);
    expect(kill.hasAttribute("data-confirm-armed")).toBe(true);
    await act(async () => fireEvent.click(kill));
    expect(kills()).toEqual([{ method: "DELETE", path: "/api/agents/a1" }]);
    expect(closes).toBe(1);
  } finally {
    view.unmount();
    setApiShim(null);
  }
});
