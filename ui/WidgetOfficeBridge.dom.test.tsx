import { afterAll, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { WidgetOfficeBridge } = await import("./WidgetOfficeBridge.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("./store.tsx");
const { useReducer } = await import("react");
type Action = Parameters<typeof reducer>[1];
const { claudeAgent, viewer, room } =
  await import("./test-support/claude-limits-fixture.tsx");
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
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM.settings;
  const previous = settings.disableIframePageLoading;
  settings.disableIframePageLoading = true;
  setApiShim(async (_method, path) =>
    path.includes("/widget?")
      ? {
          registration: 1,
          appUrl: "https://sample.office.example",
          sessionExpiresAt: Date.now() + 60000,
          chat: { agentId: agent.id, agentName: agent.name },
        }
      : path.includes("/sessions")
        ? { sessions: [], currentSessionId: null }
        : {},
  );
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => {
      view = render(
        <StateCtx.Provider
          value={{
            ...initialState,
            agents: [agent],
            rooms: [room],
            currentRoomId: room.id,
            focusedAgentId: agent.id,
            connected: true,
            isMobile: true,
            sessionContext,
          }}
        >
          <DispatchCtx.Provider value={(action) => actions.push(action)}>
            <WidgetOfficeBridge boot={boot} />
          </DispatchCtx.Provider>
        </StateCtx.Provider>,
      );
    });
    expect(view!.container.querySelector(".app-widget-panel")).toBeNull();
    await act(async () => {
      fireEvent.click(view!.container.querySelector(".app-widget-launcher")!);
    });
    expect(
      actions.some(
        (action) => action.type === "focus" && action.agentId === agent.id,
      ),
    ).toBe(true);
    expect(loadSavedView(sessionContext.username)?.agentId).toBe(agent.id);
    expect(view!.container.querySelector(".chat-messages")).not.toBeNull();
    const marker = replace.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry?.isomuxAppWrapper);
    expect(typeof marker?.isomuxAppWrapper).toBe("string");
    await act(async () => {
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: { isomux: true, page: null } }),
      );
    });
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent("popstate", { state: marker }));
    expect(reload).toHaveBeenCalledTimes(1);
    view!.unmount();
    view = undefined;
    window.dispatchEvent(new PopStateEvent("popstate", { state: marker }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    view?.unmount();
    reload.mockRestore();
    replace.mockRestore();
    settings.disableIframePageLoading = previous;
  }
});

// On a phone the widget has no chat: its launcher opens the office in the same
// page, and the member writes in the office composer (task d7ac4f73). A message
// to the app's agent from there still says which app and page the member came
// from; a message to any other agent does not. Back reloads the wrapper, and
// the frame opens on the page the member left, when that page is on the app.
for (const [variant, reported, frameAfter] of [
  ["the app's page", "/recipes/3?step=2#notes", "/recipes/3?step=2#notes"],
  ["a path that leaves the app", "//evil.example/x", "/"],
] as const) {
  it(`carries the app view into the office chat and back (${variant})`, async () => {
    const agent = claudeAgent("sonnet", "default", []);
    const other = { ...agent, id: "other-agent", name: "Other" };
    const boot = { name: "sample", registration: 1 };
    const appUrl = "https://sample.office.example";
    const sessionContext = viewer([]);
    window.history.replaceState(null, "", "/sample");
    localStorage.clear();
    sessionStorage.clear();
    const reload = spyOn(window.location, "reload").mockImplementation(
      () => {},
    );
    const replace = spyOn(window.history, "replaceState");
    const settings = (
      window as unknown as {
        happyDOM: { settings: { disableIframePageLoading: boolean } };
      }
    ).happyDOM.settings;
    const previous = settings.disableIframePageLoading;
    settings.disableIframePageLoading = true;
    const posts: { path: string; body: { appContext?: unknown } }[] = [];
    setApiShim(async (method, path, body) => {
      if (path.includes("/widget?"))
        return {
          registration: 1,
          appUrl,
          sessionExpiresAt: Date.now() + 60000,
          chat: { agentId: agent.id, agentName: agent.name, sessionId: null },
          revision: "r1",
          serving: true,
        };
      if (method === "POST" && path.endsWith("/messages")) {
        posts.push({ path, body: body as { appContext?: unknown } });
        return {};
      }
      return path.includes("/sessions")
        ? { sessions: [], currentSessionId: null }
        : {};
    });
    // A live store: the office composer keeps its draft in it, and the test
    // moves the office to another agent's chat through it.
    let dispatch: (action: Action) => void = () => {};
    function Harness() {
      const [state, apply] = useReducer(reducer, {
        ...initialState,
        agents: [agent, other],
        rooms: [room],
        currentRoomId: room.id,
        focusedAgentId: agent.id,
        connected: true,
        isMobile: true,
        sessionContext,
      });
      dispatch = apply;
      return (
        <StateCtx.Provider value={state}>
          <DispatchCtx.Provider value={apply}>
            <WidgetOfficeBridge boot={boot} />
          </DispatchCtx.Provider>
        </StateCtx.Provider>
      );
    }
    const frameSrc = (v: ReturnType<typeof render>) =>
      v.container.querySelector("iframe")?.getAttribute("src");
    const sendFromOffice = async (
      v: ReturnType<typeof render>,
      text: string,
    ) => {
      const all = v.container.querySelectorAll("textarea");
      const composer = all[all.length - 1];
      await act(async () => {
        fireEvent.change(composer, { target: { value: text } });
      });
      await act(async () => {
        fireEvent.keyDown(composer, { key: "Enter" });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => {
        view = render(<Harness />);
      });
      const frame = view!.container.querySelector("iframe")!;
      const frameWindow = { postMessage() {} } as unknown as Window;
      Object.defineProperty(frame, "contentWindow", { value: frameWindow });
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frameWindow,
            origin: appUrl,
            data: { type: "isomux:app-view", path: reported, title: "Pasta" },
          }),
        );
      });
      await act(async () => {
        fireEvent.click(view!.container.querySelector(".app-widget-launcher")!);
      });
      expect(view!.container.querySelector(".chat-messages")).not.toBeNull();

      await sendFromOffice(view!, "change this page");
      expect(posts.map((post) => post.path)).toEqual([
        `/api/agents/${agent.id}/messages`,
      ]);
      expect(posts[0].body.appContext).toEqual({
        ...boot,
        view: { path: reported, title: "Pasta" },
      });

      // Another agent's chat in the same office gets no app context: the
      // server would refuse it as a changed target.
      await act(async () => {
        dispatch({ type: "focus", agentId: other.id });
      });
      await sendFromOffice(view!, "unrelated");
      expect(posts.map((post) => post.path)).toEqual([
        `/api/agents/${agent.id}/messages`,
        `/api/agents/${other.id}/messages`,
      ]);
      expect(posts[1].body).not.toHaveProperty("appContext");

      // Back: the bridge's own history entry reloads the page. A reload keeps
      // history.state and sessionStorage; the new page mounts a new bridge.
      const marker = replace.mock.calls
        .map(([entry]) => entry)
        .find((entry) => entry?.isomuxAppWrapper);
      expect(typeof marker?.isomuxAppWrapper).toBe("string");
      // Back lands on the wrapper's own entry: its state is the marker.
      window.history.replaceState(marker, "");
      window.dispatchEvent(new PopStateEvent("popstate", { state: marker }));
      expect(reload).toHaveBeenCalledTimes(1);
      view!.unmount();
      view = undefined;
      await act(async () => {
        view = render(<Harness />);
      });
      expect(frameSrc(view!)).toBe(appUrl + frameAfter);
      // Used once: a later load opens the app's first page again.
      view!.unmount();
      view = undefined;
      await act(async () => {
        view = render(<Harness />);
      });
      expect(frameSrc(view!)).toBe(appUrl + "/");
    } finally {
      view?.unmount();
      reload.mockRestore();
      replace.mockRestore();
      settings.disableIframePageLoading = previous;
    }
  });
}
