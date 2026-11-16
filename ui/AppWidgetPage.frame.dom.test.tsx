// The app frame the shell starts (task ac70b38c). For a member with a live
// app session, the server writes the frame into the page before #root and a
// script that holds the window's messages until the widget listens. The
// widget adopts that frame and never loads it again. Without one, the widget
// makes the frame at the same place. The shell's own markup and script are
// tested through the office in server/test-support/app-widget.test.ts; here
// the page is set up as that script leaves it.
import { afterAll, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, act } = await import("@testing-library/react");
const { AppWidgetPage } = await import("./AppWidgetPage.tsx");
const { ApiError, setApiShim } = await import("./api.ts");
const { StateCtx, initialState } = await import("./store.tsx");
const {
  APP_FRAME_BUFFER,
  APP_FRAME_ID,
  APP_FRAME_LOADED_ATTR,
  APP_WIDGET_ALLOW,
  APP_WIDGET_SANDBOX,
} = await import("../shared/app-widget-frame.ts");
afterAll(() => setApiShim(null));

const APP_URL = "https://hello.office.example";
// The widget address of an app page, and the frame src the shell gave it.
const PAGE = "/hello/blog?x=1";
const SHELL_SRC = `${APP_URL}/blog?x=1`;
const ADOPTED = "data-test-shell-frame";

type FrameWindow = Window & { posted: [unknown, string][] };

// No remote page loads in a DOM test: the frame stays empty. Returns the undo.
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

// A window for a frame: it records what the widget posts to it.
function frameWindowFor(frame: HTMLIFrameElement): FrameWindow {
  const posted: [unknown, string][] = [];
  const frameWindow = {
    posted,
    postMessage(data: unknown, targetOrigin: string) {
      posted.push([data, targetOrigin]);
    },
  } as unknown as FrameWindow;
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: frameWindow,
  });
  return frameWindow;
}

// The page as the shell's script leaves it: the frame first in <body> with
// its src, the load mark when the frame loaded early, and the held messages.
// srcWrites records every later write of the frame's src.
function shellPage(
  opts: {
    loaded?: boolean;
    held?: (frameWindow: Window) => MessageEvent[];
  } = {},
) {
  const frame = document.createElement("iframe");
  frame.id = APP_FRAME_ID;
  frame.className = "app-widget-frame";
  frame.title = "hello";
  frame.setAttribute("sandbox", APP_WIDGET_SANDBOX);
  frame.setAttribute("allow", APP_WIDGET_ALLOW);
  frame.setAttribute("src", SHELL_SRC);
  frame.setAttribute(ADOPTED, "");
  if (opts.loaded) frame.setAttribute(APP_FRAME_LOADED_ATTR, "");
  document.body.insertBefore(frame, document.body.firstChild);
  const frameWindow = frameWindowFor(frame);
  const srcWrites: string[] = [];
  const setAttribute = frame.setAttribute.bind(frame);
  frame.setAttribute = (name: string, value: string) => {
    if (name.toLowerCase() === "src") srcWrites.push(value);
    setAttribute(name, value);
  };
  Object.defineProperty(frame, "src", {
    configurable: true,
    get: () => frame.getAttribute("src") ?? "",
    set: (value: string) => {
      srcWrites.push(value);
      setAttribute("src", value);
    },
  });
  const held = {
    messages: opts.held?.(frameWindow) ?? [],
    stops: 0,
    stop() {
      held.stops++;
    },
  };
  (window as unknown as Record<string, unknown>)[APP_FRAME_BUFFER] = held;
  return { frame, frameWindow, srcWrites, held };
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

// Mounts the widget at PAGE. The office answers each status read with a live
// app session, or refuses the app once `gone` is set.
async function mountWidget(opts: { appUrlInBoot: boolean }) {
  sessionStorage.clear();
  const iframesOn = iframesOff();
  history.replaceState(null, "", PAGE);
  const boot = {
    name: "hello",
    registration: 1,
    ...(opts.appUrlInBoot ? { appUrl: APP_URL } : {}),
  };
  const server = { gets: 0, gone: false };
  setApiShim(async (method) => {
    expect(method).toBe("GET");
    server.gets++;
    if (server.gone) throw new ApiError(404, "not_found", "not found");
    return {
      registration: 1,
      appUrl: APP_URL,
      sessionExpiresAt: Date.now() + 1_000_000,
      chat: null,
      revision: "r1",
      serving: true,
      reloadRequestedAt: null,
    };
  });
  let apps: unknown[] = [];
  const tree = () => (
    <StateCtx.Provider
      value={{
        ...initialState,
        apps: apps as typeof initialState.apps,
        connected: true,
      }}
    >
      <AppWidgetPage boot={boot} />
    </StateCtx.Provider>
  );
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(tree());
  });
  await settle();
  const frames = () => document.querySelectorAll("iframe");
  // The agent's reload request, as the office socket brings it.
  const requestReload = async (at: number) => {
    apps = [
      {
        name: "hello",
        state: "running",
        canManage: false,
        reloadRequestedAt: at,
      },
    ];
    await act(async () => {
      view!.rerender(tree());
    });
    await settle();
  };
  const recheck = async () => {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
  };
  const unmount = () => {
    view?.unmount();
    view = undefined;
  };
  const done = () => {
    unmount();
    // A frame the widget failed to remove must not reach the next case.
    for (const frame of document.querySelectorAll("iframe")) frame.remove();
    Reflect.deleteProperty(window, APP_FRAME_BUFFER);
    history.replaceState(null, "", "/");
    iframesOn();
  };
  return {
    view: () => view!,
    server,
    frames,
    requestReload,
    recheck,
    unmount,
    done,
  };
}

it("adopts the shell's frame: the same element, its src never written again", async () => {
  const shell = shellPage();
  const w = await mountWidget({ appUrlInBoot: true });
  try {
    await w.recheck();
    expect(w.server.gets).toBeGreaterThanOrEqual(2);
    const frames = w.frames();
    expect(frames.length).toBe(1);
    expect(frames[0].hasAttribute(ADOPTED)).toBe(true);
    expect(shell.srcWrites).toEqual([]);
    expect(frames[0].getAttribute("src")).toBe(SHELL_SRC);
    // The widget took the held messages and stopped the holding.
    expect(shell.held.stops).toBe(1);
    // The frame stays where the shell put it, before the widget's root.
    expect(
      frames[0].compareDocumentPosition(w.view().container) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    w.unmount();
    expect(w.frames().length).toBe(0);
  } finally {
    w.done();
  }
});

it("asks for the app sign-in on a session signal the shell held before the widget listened", async () => {
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  shellPage({
    held: (frameWindow) => [
      new MessageEvent("message", {
        source: frameWindow,
        origin: APP_URL,
        data: "isomux:app-session-required",
      }),
    ],
  });
  const w = await mountWidget({ appUrlInBoot: true });
  try {
    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(String(assign.mock.calls[0][0]), "http://localhost");
    expect(target.pathname).toBe("/auth/app");
    expect(target.searchParams.get("app")).toBe("hello");
  } finally {
    w.done();
    assign.mockRestore();
  }
});

// The page the frame reported decides how a reload runs: a page that reported
// reloads in place (a message to the frame), one that did not gets a new frame.
it("keeps a page report the shell held, so a reload runs in place", async () => {
  const shell = shellPage({
    held: (frameWindow) => [
      new MessageEvent("message", {
        source: frameWindow,
        origin: APP_URL,
        data: { type: "isomux:app-view", path: "/recipes/3", title: "Pasta" },
      }),
    ],
  });
  const w = await mountWidget({ appUrlInBoot: true });
  try {
    await w.requestReload(1000);
    expect(shell.frameWindow.posted).toEqual([["isomux:app-reload", APP_URL]]);
    expect(w.frames()[0].hasAttribute(ADOPTED)).toBe(true);
  } finally {
    w.done();
  }
});

// A frame load reads the app's status (a page loaded while the app did not
// serve is reloaded). The status read at mount is one read; each frame load
// adds exactly one more.
for (const loadedEarly of [false, true]) {
  it(`reads the status once per frame load, also for a load before the widget ran (loaded early: ${loadedEarly})`, async () => {
    const shell = shellPage({ loaded: loadedEarly });
    const w = await mountWidget({ appUrlInBoot: true });
    try {
      expect({ loadedEarly, gets: w.server.gets }).toEqual({
        loadedEarly,
        gets: loadedEarly ? 2 : 1,
      });
      await act(async () => {
        shell.frame.dispatchEvent(new Event("load"));
      });
      await settle();
      expect({ loadedEarly, gets: w.server.gets }).toEqual({
        loadedEarly,
        gets: loadedEarly ? 3 : 2,
      });
    } finally {
      w.done();
    }
  });
}

it("puts a new frame in place of the shell's when the page must be mounted again", async () => {
  const shell = shellPage();
  const w = await mountWidget({ appUrlInBoot: true });
  try {
    // The page never reported: the agent's reload mounts a new frame.
    await w.requestReload(1000);
    const frames = w.frames();
    expect(frames.length).toBe(1);
    expect(frames[0].hasAttribute(ADOPTED)).toBe(false);
    expect(shell.frame.isConnected).toBe(false);
    expect({
      src: frames[0].getAttribute("src"),
      sandbox: frames[0].getAttribute("sandbox"),
      allow: frames[0].getAttribute("allow"),
      title: frames[0].getAttribute("title"),
    }).toEqual({
      src: SHELL_SRC,
      sandbox: APP_WIDGET_SANDBOX,
      allow: APP_WIDGET_ALLOW,
      title: "hello",
    });
    expect(
      frames[0].compareDocumentPosition(w.view().container) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  } finally {
    w.done();
  }
});

it("removes the shell's frame when the office refuses the app", async () => {
  const shell = shellPage();
  const w = await mountWidget({ appUrlInBoot: true });
  try {
    w.server.gone = true;
    await w.recheck();
    expect(w.frames().length).toBe(0);
    expect(shell.frame.isConnected).toBe(false);
    expect(
      w.view().container.querySelector(".app-widget-unavailable"),
    ).not.toBeNull();
  } finally {
    w.done();
  }
});

it("makes the frame at the start of the page when the shell wrote none", async () => {
  const w = await mountWidget({ appUrlInBoot: false });
  try {
    const frames = w.frames();
    expect(frames.length).toBe(1);
    expect({
      src: frames[0].getAttribute("src"),
      sandbox: frames[0].getAttribute("sandbox"),
      allow: frames[0].getAttribute("allow"),
      title: frames[0].getAttribute("title"),
    }).toEqual({
      src: SHELL_SRC,
      sandbox: APP_WIDGET_SANDBOX,
      allow: APP_WIDGET_ALLOW,
      title: "hello",
    });
    expect(
      frames[0].compareDocumentPosition(w.view().container) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    w.unmount();
    expect(w.frames().length).toBe(0);
  } finally {
    w.done();
  }
});
