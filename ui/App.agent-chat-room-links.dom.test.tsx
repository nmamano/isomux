// A chat opened from the Apps page or from an agent's name in another chat
// follows its agent into the agent's room (task 1faeb586), through the real
// App and store. The Inbox doors are in ui/App.agent-chat-room.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const { shimEmit } = await import("./ws.ts");
const { activeRoom, backScreen, boot, escape, setApps, setUpAgentLinkTests } =
  await import("./test-support/agent-link-fixture.tsx");
type AppListWire = import("../shared/types.ts").AppListWire;
type View = import("./test-support/agent-link-fixture.tsx").View;

setUpAgentLinkTests();

// Out of Faraway's chat, the office shows its room, at the front.
async function leaveFarawayChat(view: View) {
  expect(document.title).toContain("Faraway");
  await escape();
  expect(document.title).not.toContain("Faraway");
  expect(activeRoom(view)).toBe("r2");
  expect(backScreen(view)).toBe(false);
}

it("leaves a chat opened from an app's creator on the Lobby's Apps for the agent's room", async () => {
  setApps([
    {
      name: "board",
      port: 21000,
      userId: "u1",
      username: "member",
      createdBy: "Faraway",
      createdByAgentId: "a2",
      createdAt: 1,
      state: "running",
      restartCount: 0,
    } as AppListWire,
  ]);
  // The office opens on the Lobby, where Apps lists every room's apps (in a
  // room it lists only that room's).
  const view = await boot();
  expect(activeRoom(view)).toBeNull();
  // Open Apps with its key.
  await act(async () =>
    fireEvent.keyDown(document.body, { key: "a", bubbles: true }),
  );
  expect(window.location.pathname).toBe("/apps");
  // Let GET /api/apps land.
  await act(async () => {});
  const creator = view.container.querySelector<HTMLButtonElement>(
    `[data-app-row="board"] button[title="${en["apps.openAgent"]}"]`,
  );
  expect(creator).not.toBeNull();
  await act(async () => fireEvent.click(creator!));
  expect(view.container.querySelector("[data-app-row]")).toBeNull();
  await leaveFarawayChat(view);
  view.unmount();
});

it("leaves a chat opened from an agent's name in another room's chat for that agent's room", async () => {
  // Scout's chat, in the first room.
  const view = await boot("/agents/a1");
  expect(document.title).toContain("Scout");
  // A message from Faraway names its sender with a link.
  await act(async () => {
    shimEmit({
      type: "log_entry",
      entry: {
        id: "m1",
        agentId: "a1",
        kind: "user_message",
        content: "Hello from the second room",
        timestamp: 1_000,
        metadata: {
          sender_agent_id: "a2",
          sender_agent_name: "Faraway",
          sender_agent_room: "Second room",
        },
      },
    } as never);
  });
  const link = view.container.querySelector<HTMLElement>(
    '[data-agent-link="a2"]',
  );
  expect(link).not.toBeNull();
  await act(async () => fireEvent.click(link!));
  await leaveFarawayChat(view);
  view.unmount();
});
