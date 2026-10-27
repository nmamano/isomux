// The page the member sees, the reload the agent asks for, and the "App
// changed" control after a turn that changed the app with no reload (task
// d7ac4f73). The reload waits run on fake timers: real 1 s polls put this file
// at 4.5 s of its 5 s cap.
import { afterAll, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { AppWidgetPage } = await import("./AppWidgetPage.tsx");
const { setApiShim } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
afterAll(() => setApiShim(null));
const EN = translatorFor("en");

const boot = { name: "hello", registration: 1 };
const agent = {
  id: "one",
  name: "One",
  state: "idle",
  outfit: { color: "#218cff", hair: "#3e3025", skin: "#FFD5B8" },
  queue: [],
} as unknown as import("../shared/types.ts").AgentInfo;
// No remote page loads in a DOM test: the widget's iframe stays empty. Returns
// the undo.
function iframesOff(): () => void {
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM.settings;
  const before = settings.disableIframePageLoading;
  settings.disableIframePageLoading = true;
  return () => {
    settings.disableIframePageLoading = before;
  };
}

const APP_URL = "https://hello.office.example";
type FrameWindow = Window & { posted: [unknown, string][] };

async function mountWidget(
  opts: {
    isMobile?: boolean;
    serving?: boolean;
    reloadRequestedAt?: number | null;
  } = {},
) {
  sessionStorage.clear();
  const { StateCtx, initialState } = await import("./store.tsx");
  const iframesOn = iframesOff();
  const server = {
    revision: "r1" as string | null,
    serving: opts.serving ?? true,
    reloadRequestedAt: opts.reloadRequestedAt ?? null,
    gets: 0,
  };
  // The office socket's app rows, as the store holds them: empty until the
  // first app_upserted delta, since full_state carries no apps.
  let apps: unknown[] = [];
  let agentState = "idle";
  const posts: { appContext?: unknown }[] = [];
  setApiShim(async (method, _path, body) => {
    if (method === "GET") {
      server.gets++;
      return {
        ...boot,
        appUrl: APP_URL,
        sessionExpiresAt: Date.now() + 1000000,
        chat: { agentId: agent.id, agentName: agent.name, sessionId: null },
        revision: server.revision,
        serving: server.serving,
        reloadRequestedAt: server.reloadRequestedAt,
      };
    }
    posts.push(body as { appContext?: unknown });
    return {};
  });
  const tree = (state: string = agentState) => (
    <StateCtx.Provider
      value={{
        ...initialState,
        agents: [{ ...agent, state } as typeof agent],
        apps: apps as typeof initialState.apps,
        connected: true,
        isMobile: !!opts.isMobile,
      }}
    >
      <AppWidgetPage boot={boot} />
    </StateCtx.Provider>
  );
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(tree("idle"));
  });
  const iframe = () => view!.container.querySelector("iframe");
  // No remote page loads in a DOM test: give the mounted frame a window that
  // records what the widget posts to it, and a marker that a new frame lacks.
  const posted: [unknown, string][] = [];
  const frameWindow = {
    posted,
    postMessage(data: unknown, targetOrigin: string) {
      posted.push([data, targetOrigin]);
    },
  } as unknown as FrameWindow;
  Object.defineProperty(iframe()!, "contentWindow", { value: frameWindow });
  iframe()!.setAttribute("data-test-first-frame", "");
  const firstFrame = () =>
    iframe()?.hasAttribute("data-test-first-frame") ?? false;
  const report = async (
    data: unknown,
    source: unknown = frameWindow,
    origin = APP_URL,
  ) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: source as Window,
          origin,
          data,
        }),
      );
    });
  };
  const setAgent = async (state: string) => {
    agentState = state;
    await act(async () => {
      view!.rerender(tree(state));
    });
  };
  const send = async (text: string) => {
    if (!opts.isMobile) {
      const launcher = view!.container.querySelector<HTMLButtonElement>(
        ".app-widget-launcher",
      )!;
      if (launcher.getAttribute("aria-expanded") !== "true")
        fireEvent.click(launcher);
    }
    await act(async () => {
      fireEvent.change(view!.getByRole("textbox"), {
        target: { value: text },
      });
    });
    await act(async () => {
      fireEvent.submit(view!.container.querySelector("form")!);
    });
  };
  // An app_upserted for the app, with the agent's reload request on it (or
  // without one: undefined).
  const requestReload = async (at: number | undefined) => {
    apps = [
      {
        name: boot.name,
        state: "running",
        canManage: false,
        ...(at === undefined ? {} : { reloadRequestedAt: at }),
      },
    ];
    await act(async () => {
      view!.rerender(tree());
    });
    await settle();
  };
  // The "App changed" control's button, or null.
  const control = () =>
    view!.queryByRole("button", { name: EN.t("appWidget.reload") });
  const loaded = async () => {
    await act(async () => {
      iframe()!.dispatchEvent(new Event("load"));
    });
  };
  const done = () => {
    jest.useRealTimers();
    view?.unmount();
    iframesOn();
  };
  return {
    server,
    posts,
    iframe,
    frameWindow,
    firstFrame,
    report,
    loaded,
    requestReload,
    control,
    setAgent,
    send,
    done,
  };
}

// Settles the widget's status reads, which resolve in microtasks.
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}
// Moves the widget's fake clock: its poll for the app and any reload timer.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}
// Longer than any wait the widget may make for a page to reload.
const RELOAD_WINDOW_MS = 10_000;

const viewReport = (path: string, title?: string) => ({
  type: "isomux:app-view",
  path,
  ...(title === undefined ? {} : { title }),
});

it("sends the page the member sees, from the frame's own report only", async () => {
  const w = await mountWidget();
  try {
    // No report yet: the frame's first page, with no title.
    await w.send("before any report");
    expect(w.posts.at(-1)?.appContext).toEqual({
      ...boot,
      view: { path: "/" + window.location.search },
    });
    await w.report(viewReport("/recipes/3?step=2#notes", "Pasta"));
    // Not this frame, or not this app: ignored.
    await w.report(viewReport("/other", "Other"), {});
    await w.report(
      viewReport("/other", "Other"),
      w.frameWindow,
      "https://evil.example",
    );
    await w.send("after a report");
    expect(w.posts).toHaveLength(2);
    expect(w.posts.at(-1)?.appContext).toEqual({
      ...boot,
      view: { path: "/recipes/3?step=2#notes", title: "Pasta" },
    });
  } finally {
    w.done();
  }
});

for (const isMobile of [false, true]) {
  it(`reloads the page in place once the app serves, when the agent asks (mobile: ${isMobile})`, async () => {
    const w = await mountWidget({ isMobile });
    try {
      await w.report(viewReport("/recipes/3", "Pasta"));
      // One run waits for the app to serve again; the other finds it serving.
      w.server.serving = isMobile;
      jest.useFakeTimers();
      await w.requestReload(1000);
      if (!isMobile) {
        // The app does not serve: no reload yet, while the widget waits.
        await advance(1);
        expect(w.frameWindow.posted).toEqual([]);
        w.server.serving = true;
        await advance(1000);
      }
      expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
      // The page reloads, so the widget mounts no new frame: the same frame
      // keeps the app's route.
      await w.loaded();
      await advance(RELOAD_WINDOW_MS);
      expect(w.firstFrame()).toBe(true);
      // The same request, seen again, does not reload again.
      await w.requestReload(1000);
      await advance(RELOAD_WINDOW_MS);
      expect(w.frameWindow.posted).toHaveLength(1);
    } finally {
      w.done();
    }
  });
}

// The request is a time. An office restart forgets it (absent on the wire), and
// a row the widget already saw is not a new request.
it("reloads nothing for a request it already saw, an absent one, or an older one", async () => {
  const w = await mountWidget({ reloadRequestedAt: 500 });
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    for (const at of [500, undefined, 400]) {
      await w.requestReload(at);
      await advance(RELOAD_WINDOW_MS);
      expect([at, w.frameWindow.posted]).toEqual([at, []]);
    }
    expect(w.firstFrame()).toBe(true);
    // Enabling condition: a newer request still reloads.
    await w.requestReload(501);
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
  } finally {
    w.done();
  }
});

// A widget whose socket missed the delta (it was reconnecting) learns of the
// request from its next status read.
it("reloads on a request it reads in a later status", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    w.server.reloadRequestedAt = 2000;
    const before = w.server.gets;
    await w.setAgent("thinking");
    await w.setAgent("idle");
    await settle();
    expect(w.server.gets).toBeGreaterThan(before);
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
  } finally {
    w.done();
  }
});

// A frame load reads the status too, and so learns of a request it missed.
it("reloads on a request it reads when the frame loads", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    w.server.reloadRequestedAt = 2000;
    const before = w.server.gets;
    await w.loaded();
    await settle();
    expect(w.server.gets).toBeGreaterThan(before);
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
  } finally {
    w.done();
  }
});

it("mounts a new frame when the page never reported, when the agent asks", async () => {
  const w = await mountWidget();
  try {
    const src = w.iframe()!.getAttribute("src");
    jest.useFakeTimers();
    await w.requestReload(1000);
    expect(w.firstFrame()).toBe(false);
    expect(w.iframe()!.getAttribute("src")).toBe(src);
    expect(w.frameWindow.posted).toEqual([]);
  } finally {
    w.done();
  }
});

// The agent decides when the member sees a change: a turn that changed the
// app reloads nothing by itself. With no request, the widget offers a reload.
it("does not reload at turn end, and offers a reload after a turn that changed the app with no request", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    expect(w.control()).toBe(null);
    await w.setAgent("thinking");
    w.server.revision = "r2";
    await w.setAgent("idle");
    await settle();
    await advance(RELOAD_WINDOW_MS);
    expect(w.frameWindow.posted).toEqual([]);
    expect(w.firstFrame()).toBe(true);
    expect(w.control()).not.toBe(null);
    await act(async () => {
      fireEvent.click(w.control()!);
    });
    await settle();
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
    expect(w.control()).toBe(null);
  } finally {
    w.done();
  }
});

it("offers no reload after a turn in which the agent asked for one", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    await w.setAgent("thinking");
    w.server.revision = "r2";
    await w.requestReload(1000);
    await w.setAgent("idle");
    await settle();
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
    expect(w.control()).toBe(null);
  } finally {
    w.done();
  }
});

// The baseline is taken when the turn starts, so files the member's own use of
// the app changed between turns do not count against a turn that changed
// nothing.
it("offers no reload after a turn that changed nothing, even when the app changed between turns", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    w.server.revision = "r-member";
    const before = w.server.gets;
    await w.setAgent("thinking");
    await w.setAgent("idle");
    await settle();
    // The widget read the status after the turn, and found nothing to do.
    expect(w.server.gets).toBeGreaterThan(before + 1);
    expect(w.control()).toBe(null);
    expect(w.frameWindow.posted).toEqual([]);
  } finally {
    w.done();
  }
});

it("hides the offer when the frame loads or the agent asks for a reload", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    jest.useFakeTimers();
    const changingTurn = async (revision: string) => {
      await w.setAgent("thinking");
      w.server.revision = revision;
      await w.setAgent("idle");
      await settle();
      expect([revision, w.control() !== null]).toEqual([revision, true]);
    };
    await changingTurn("r2");
    await w.loaded();
    await settle();
    expect(w.control()).toBe(null);
    await changingTurn("r3");
    await w.requestReload(1000);
    expect(w.control()).toBe(null);
  } finally {
    w.done();
  }
});

// A page that loads while the app is down (Back from the office during the
// agent's restart, or a stopped app the agent then starts) shows the error page
// until the app serves; then it reloads, with no turn and no file change.
it("reloads a page that loaded while the app did not serve, once it serves", async () => {
  const w = await mountWidget({ serving: false });
  try {
    jest.useFakeTimers();
    const before = w.server.gets;
    await w.loaded();
    await settle();
    // The widget looked, and waits: the app does not serve.
    expect(w.server.gets).toBeGreaterThan(before);
    expect(w.firstFrame()).toBe(true);
    w.server.serving = true;
    await advance(1000);
    // The page never reported, so the reload mounts a new frame.
    expect(w.firstFrame()).toBe(false);
  } finally {
    w.done();
  }
});

// Once a page has reported, the widget reloads it in place by message. A page
// that came after it may have no script to hear that message: the office's own
// error page while the app restarts, or a page the proxy did not add the script
// to (an error status, a strict CSP). The reload must still happen, on the
// page the member was on, and the member must never have to reload by hand.
it("reloads the office's error page that replaced a page that reported, at that page", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3", "Pasta"));
    await w.loaded();
    await w.send("while the page shows");
    expect(w.posts.at(-1)?.appContext).toEqual({
      ...boot,
      view: { path: "/recipes/3", title: "Pasta" },
    });
    jest.useFakeTimers();
    // The app restarts and the frame shows the office's error page.
    w.server.serving = false;
    const before = w.server.gets;
    await w.loaded();
    await settle();
    expect(w.server.gets).toBeGreaterThan(before);
    expect(w.firstFrame()).toBe(true);
    // The member does not see the page's title now: the agent is not told so.
    await w.send("while the app is down");
    expect(w.posts.at(-1)?.appContext).toEqual({
      ...boot,
      view: { path: "/recipes/3" },
    });
    w.server.serving = true;
    await advance(1000);
    await advance(RELOAD_WINDOW_MS);
    expect(w.firstFrame()).toBe(false);
    expect(w.iframe()!.getAttribute("src")).toBe(APP_URL + "/recipes/3");
  } finally {
    w.done();
  }
});

it("mounts a new frame at the reported page when the page does not reload on the message", async () => {
  const w = await mountWidget();
  try {
    await w.report(viewReport("/recipes/3?step=2#notes", "Pasta"));
    await w.loaded();
    jest.useFakeTimers();
    await w.requestReload(1000);
    // Enabling condition: the widget asked the page to reload itself.
    expect(w.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
    expect(w.firstFrame()).toBe(true);
    // No load follows: nothing in the frame heard the message.
    await advance(RELOAD_WINDOW_MS);
    expect(w.firstFrame()).toBe(false);
    expect(w.iframe()!.getAttribute("src")).toBe(
      APP_URL + "/recipes/3?step=2#notes",
    );
    // The new frame's page reports the app's root; a later fallback opens the
    // root, not the page of the earlier one.
    Object.defineProperty(w.iframe()!, "contentWindow", {
      value: w.frameWindow,
    });
    await w.loaded();
    await settle();
    await w.report(viewReport("/", "Home"));
    await w.requestReload(2000);
    expect(w.frameWindow.posted).toHaveLength(2);
    await advance(RELOAD_WINDOW_MS);
    expect(w.iframe()!.getAttribute("src")).toBe(APP_URL + "/");
  } finally {
    w.done();
  }
});
