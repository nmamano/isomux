import { afterAll, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { WidgetOfficeBridge } = await import("./WidgetOfficeBridge.tsx");
const { StateCtx, DispatchCtx, initialState } = await import("./store.tsx");
const { claudeAgent, viewer, room } = await import("./test-support/claude-limits-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { loadSavedView } = await import("./view-persistence.ts");
afterAll(() => setApiShim(null));

it("hands mobile chat to App and reloads only its own wrapper history entry", async () => {
  const agent = claudeAgent("sonnet", "default", []);
  const boot = { name: "sample", registration: 1 };
  const sessionContext = viewer([]);
  const actions: Parameters<typeof import("./store.tsx").reducer>[1][] = [];
  window.history.replaceState(null, "", "/sample");
  localStorage.clear();
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const replace = spyOn(window.history, "replaceState");
  const settings = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings;
  const previous = settings.disableIframePageLoading;
  settings.disableIframePageLoading = true;
  setApiShim(async (_method, path) => path.includes("/widget?") ? {
    registration: 1, appUrl: "https://sample.office.example", sessionExpiresAt: Date.now() + 60000,
    chat: { agentId: agent.id, agentName: agent.name },
  } : path.includes("/sessions") ? { sessions: [], currentSessionId: null } : {});
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => {
      view = render(<StateCtx.Provider value={{ ...initialState, agents: [agent], rooms: [room], currentRoomId: room.id, focusedAgentId: agent.id, connected: true, isMobile: true, sessionContext }}>
        <DispatchCtx.Provider value={(action) => actions.push(action)}><WidgetOfficeBridge boot={boot} /></DispatchCtx.Provider>
      </StateCtx.Provider>);
    });
    expect(view!.container.querySelector(".app-widget-panel")).toBeNull();
    await act(async () => { fireEvent.click(view!.container.querySelector(".app-widget-launcher")!); });
    expect(actions.some((action) => action.type === "focus" && action.agentId === agent.id)).toBe(true);
    expect(loadSavedView(sessionContext.username)?.agentId).toBe(agent.id);
    expect(view!.container.querySelector(".chat-messages")).not.toBeNull();
    const marker = replace.mock.calls.map(([entry]) => entry).find((entry) => entry?.isomuxAppWrapper);
    expect(typeof marker?.isomuxAppWrapper).toBe("string");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: { isomux: true, page: null } })); });
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent("popstate", { state: marker }));
    expect(reload).toHaveBeenCalledTimes(1);
    view!.unmount();
    view = undefined;
    window.dispatchEvent(new PopStateEvent("popstate", { state: marker }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    view?.unmount();
    reload.mockRestore(); replace.mockRestore(); settings.disableIframePageLoading = previous;
  }
});
