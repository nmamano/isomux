import { afterAll, beforeEach } from "bun:test";
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { SceneDecorationContext } = await import("../office/scene-decoration.tsx");
const { App } = await import("../App.tsx");
const { StoreProvider } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { connect, setShim, shimEmit } = await import("../ws.ts");
const { saveView, loadSavedView } = await import("../view-persistence.ts");

export function setupLandingTests() {
setApiShim(async (_method, path) =>
  path.startsWith("/api/members-chat")
    ? { messages: [], hasMore: false, readPointer: null, unread: 0 }
    : {},
);
afterAll(() => {
  setApiShim(null);
  setShim(
    () => {},
    () => {},
  );
  connect(
    () => {},
    () => {},
  );
});
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

}

export const rooms = [
  { id: "r1", name: "First room", prompt: null, canCloseWhenEmpty: true },
  { id: "r2", name: "Saved room", prompt: null, canCloseWhenEmpty: true },
];

export async function boot(visibleRooms: typeof rooms, { stageHydration = false, decorations = true } = {}) {
  const fullState = () => shimEmit({
    type: "full_state",
    agents: [],
    rooms: visibleRooms,
    office: { name: "Test Office" },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  } as never);
  let hydrated!: () => void;
  const hydration = new Promise<void>((resolve) => {
    hydrated = resolve;
  });
  setShim(
    () => {},
    () => {
      shimEmit({
        type: "session_context",
        context: {
          username: "member",
          userId: "u1",
          role: "member",
        },
      } as never);
      if (!stageHydration) fullState();
      hydrated();
    },
  );
  const view = render(createElement(StoreProvider, null,
    createElement(SceneDecorationContext.Provider, { value: decorations }, createElement(App))));
  await act(async () => {
    await hydration;
  });
  // The saved-room case also tests the gap between separate WS messages.
  if (stageHydration) await act(async () => fullState());
  return view;
}


export { saveView, loadSavedView };
