import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { saveView, loadSavedView } = await import("./view-persistence.ts");

setApiShim(async (_method, path) => path.startsWith("/api/members-chat")
  ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
  : {});
afterAll(() => {
  setApiShim(null);
  setShim(() => {}, () => {});
  connect(() => {}, () => {});
});
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const rooms = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Saved room", prompt: null, canCloseWhenEmpty: true },
];

async function boot(visibleRooms: typeof rooms) {
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
  setShim(() => {}, () => {
    shimEmit({ type: "session_context", context: {
      username: "member", userId: "u1", role: "member",
    } } as never);
    shimEmit({ type: "full_state", agents: [], rooms: visibleRooms,
      office: { name: "Test Office" }, recentCwds: [], killedAgents: [], interactions: [],
    } as never);
    hydrated();
  });
  const view = render(createElement(StoreProvider, null, createElement(App)));
  await act(async () => { await hydration; });
  return view;
}

for (const visibleRooms of [[], rooms]) {
  it(`lands on Lobby without a saved view with ${visibleRooms.length} room grants`, async () => {
    expect(loadSavedView("member")).toBeNull();
    const view = await boot(visibleRooms);
    expect(view.getByText("Members chat", { exact: false })).toBeDefined();
    expect(document.title).toBe("Test Office | Isomux");
    expect(loadSavedView("member")?.lobby).toBe(true);
  });
}

it("restores the saved room instead of opening Lobby", async () => {
  saveView("member", { roomId: "r2", agentId: null, panel: null, lobby: false });
  const view = await boot(rooms);
  expect(view.queryByText("Members chat", { exact: false })).toBeNull();
  expect(document.title).toBe("Saved room | Isomux");
  expect(loadSavedView("member")?.roomId).toBe("r2");
  expect(loadSavedView("member")?.lobby).toBe(false);
});
