import { afterAll, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { WidgetChat, AppWidgetPage } = await import("./AppWidgetPage.tsx");
const { beginAppHandshake } = await import("./app-widget-state.ts");
const { setApiShim } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");
afterAll(() => setApiShim(null));

const boot = { name: "hello", registration: 1 };
const agent = {
  id: "one",
  name: "One",
  state: "idle",
  outfit: { color: "#218cff", hair: "#3e3025", skin: "#FFD5B8" },
  queue: [],
} as unknown as import("../shared/types.ts").AgentInfo;
const props = {
  boot,
  agent,
  logs: [],
  connected: true,
  open: true,
  onRecheck: () => {},
};

for (const [platform, hint] of [
  ["Win32", "appWidget.windowsHint"],
  ["MacIntel", "appWidget.macHint"],
] as const) {
  it(`renders the screenshot shortcut for ${platform}`, () => {
    sessionStorage.clear();
    const values = { platform, userAgent: "Mozilla/5.0", maxTouchPoints: 0 };
    const descriptors = Object.getOwnPropertyDescriptors(navigator);
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(navigator, key, { configurable: true, value });
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<WidgetChat {...props} />);
      expect(
        view.container.querySelector(".app-widget-hint")?.textContent,
      ).toBe(en[hint]);
    } finally {
      view?.unmount();
      for (const key of Object.keys(values)) {
        if (descriptors[key])
          Object.defineProperty(navigator, key, descriptors[key]);
        else Reflect.deleteProperty(navigator, key);
      }
    }
  });
}

it("keeps a failed draft and retry id across remount, and separates a changed target", async () => {
  sessionStorage.clear();
  const posts: {
    text: string;
    clientMessageId: string;
    appContext: unknown;
  }[] = [];
  let fail = true;
  setApiShim(async (method, path, body) => {
    expect(method).toBe("POST");
    expect(path).toBe("/api/agents/one/messages");
    posts.push(body as (typeof posts)[number]);
    if (fail) throw new Error("offline");
    return {};
  });
  let view = render(<WidgetChat {...props} />);
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "original draft" },
    });
  });
  await act(async () => {
    fireEvent.submit(view.container.querySelector("form")!);
  });
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "original draft",
  );
  expect(posts[0].appContext).toEqual(boot);
  view.unmount();
  view = render(<WidgetChat {...props} />);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "original draft",
  );
  fail = false;
  await act(async () => {
    fireEvent.submit(view.container.querySelector("form")!);
  });
  expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "only for one" },
    });
  });
  view.rerender(<WidgetChat {...props} agent={{ ...agent, id: "two" }} />);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  await act(async () => {
    fireEvent.submit(view.container.querySelector("form")!);
  });
  expect(posts).toHaveLength(2);
  view.unmount();
});

it("does not send while the reply connection is offline", async () => {
  sessionStorage.clear();
  let sends = 0;
  setApiShim(async () => {
    sends++;
    return {};
  });
  const view = render(<WidgetChat {...props} connected={false} />);
  await act(async () => {
    fireEvent.change(view.getByRole("textbox"), {
      target: { value: "wait for reconnect" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
  });
  expect(sends).toBe(0);
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "wait for reconnect",
  );
});

for (const serverLive of [false, true]) {
  it(`latches failed recovery across later refreshes (server live: ${serverLive})`, async () => {
    sessionStorage.clear();
    const settings = (
      window as unknown as {
        happyDOM: { settings: { disableIframePageLoading: boolean } };
      }
    ).happyDOM.settings;
    const iframeLoading = settings.disableIframePageLoading;
    settings.disableIframePageLoading = true;
    let now = 100000;
    const date = spyOn(Date, "now").mockImplementation(() => now);
    const assign = spyOn(window.location, "assign").mockImplementation(
      () => {},
    );
    beginAppHandshake(sessionStorage, boot, now);
    const appUrl = "https://hello.office.example";
    setApiShim(async () => ({
      ...boot,
      appUrl,
      sessionExpiresAt: serverLive ? now + 1000000 : null,
      chat: null,
    }));
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => {
        view = render(<AppWidgetPage boot={boot} />);
      });
      if (serverLive) {
        const frame = view!.container.querySelector("iframe")!;
        expect(frame).not.toBeNull();
        // No remote iframe loads in the DOM test; supply its window identity.
        const frameWindow = {} as Window;
        Object.defineProperty(frame, "contentWindow", { value: frameWindow });
        await act(async () => {
          window.dispatchEvent(
            new MessageEvent("message", {
              source: frame.contentWindow,
              origin: appUrl,
              data: "isomux:app-session-required",
            }),
          );
        });
      }
      expect(
        view!.container.querySelector(".app-widget-unavailable"),
      ).not.toBeNull();
      now += 61000;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(assign).not.toHaveBeenCalled();
      expect(
        view!.container.querySelector(".app-widget-unavailable"),
      ).not.toBeNull();
      expect(view!.container.querySelector("iframe")).toBeNull();
    } finally {
      view?.unmount();
      assign.mockRestore();
      date.mockRestore();
      settings.disableIframePageLoading = iframeLoading;
    }
  });
}

const imageAttachment = {
  filename: "image.png",
  originalName: "shot.png",
  mediaType: "image/png",
  size: 3,
};
const imageFile = () => new File(["png"], "shot.png", { type: "image/png" });

it("uploads file selection, preserves image retries, and rotates ids for changed image sets", async () => {
  sessionStorage.clear();
  const uploads = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init,
  ) => {
    expect(url).toBe("/api/upload/one");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    return new Response(JSON.stringify({ attachments: [imageAttachment] }));
  }) as typeof fetch);
  const posts: { attachments: unknown[]; clientMessageId: string }[] = [];
  setApiShim(async (_method, _path, body) => {
    posts.push(body as (typeof posts)[number]);
    throw new Error("send failed");
  });
  let view = render(<WidgetChat {...props} />);
  try {
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [imageFile()] },
      });
    });
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelectorAll(".app-widget-image img"),
    ).toHaveLength(1);
    await act(async () => {
      fireEvent.submit(view.container.querySelector("form")!);
    });
    expect(posts[0].attachments).toEqual([imageAttachment]);
    view.unmount();
    view = render(<WidgetChat {...props} />);
    expect(
      view.container.querySelectorAll(".app-widget-image img"),
    ).toHaveLength(1);
    await act(async () => {
      fireEvent.submit(view.container.querySelector("form")!);
    });
    expect(posts[1].clientMessageId).toBe(posts[0].clientMessageId);
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [imageFile()] },
      });
    });
    await act(async () => {
      fireEvent.submit(view.container.querySelector("form")!);
    });
    expect(posts[2].clientMessageId).not.toBe(posts[1].clientMessageId);
    expect(posts[2].attachments).toHaveLength(2);
    await act(async () => {
      fireEvent.click(
        view.container.querySelector(".app-widget-image button")!,
      );
    });
    await act(async () => {
      fireEvent.submit(view.container.querySelector("form")!);
    });
    expect(posts[3].clientMessageId).not.toBe(posts[2].clientMessageId);
    expect(posts[3].attachments).toHaveLength(1);
  } finally {
    view.unmount();
    uploads.mockRestore();
  }
});

it("uploads image paste and drop, and leaves text paste and other files alone", async () => {
  sessionStorage.clear();
  const uploads = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ attachments: [imageAttachment] })),
  );
  const view = render(<WidgetChat {...props} />);
  try {
    const target = view.container.querySelector(".app-widget-chat-content")!;
    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", {
      value: { items: [{ kind: "string", type: "text/plain" }] },
    });
    await act(async () => {
      fireEvent(target, textPaste);
    });
    expect(textPaste.defaultPrevented).toBe(false);
    expect(uploads).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: {
          files: [new File(["txt"], "note.txt", { type: "text/plain" })],
        },
      });
    });
    expect(uploads).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.paste(target, {
        clipboardData: {
          items: [{ kind: "file", type: "image/png", getAsFile: imageFile }],
        },
      });
    });
    expect(uploads).toHaveBeenCalledTimes(1);
    uploads.mockResolvedValue(
      new Response(JSON.stringify({ attachments: [imageAttachment] })),
    );
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: { files: [imageFile()] } });
    });
    expect(uploads).toHaveBeenCalledTimes(2);
    expect(
      view.container.querySelectorAll(".app-widget-image img"),
    ).toHaveLength(2);
  } finally {
    view.unmount();
    uploads.mockRestore();
  }
});

for (const change of ["remove", "target"] as const) {
  it(`ignores an upload completion after ${change}`, async () => {
    sessionStorage.clear();
    let finish!: (response: Response) => void;
    const uploads = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
        { preconnect: () => {} },
      ),
    );
    let sends = 0;
    setApiShim(async () => {
      sends++;
      return {};
    });
    const view = render(<WidgetChat {...props} />);
    try {
      await act(async () => {
        fireEvent.change(view.container.querySelector('input[type="file"]')!, {
          target: { files: [imageFile()] },
        });
      });
      expect(uploads.mock.calls[0][0]).toBe("/api/upload/one");
      await act(async () => {
        fireEvent.submit(view.container.querySelector("form")!);
      });
      expect(sends).toBe(0);
      if (change === "remove")
        await act(async () => {
          fireEvent.click(
            view.container.querySelector(".app-widget-image button")!,
          );
        });
      else
        view.rerender(
          <WidgetChat {...props} agent={{ ...agent, id: "two" }} />,
        );
      await act(async () => {
        finish(
          new Response(JSON.stringify({ attachments: [imageAttachment] })),
        );
      });
      expect(view.container.querySelectorAll(".app-widget-image")).toHaveLength(
        0,
      );
      await act(async () => {
        fireEvent.submit(view.container.querySelector("form")!);
      });
      expect(sends).toBe(0);
      await act(async () => {
        fireEvent.change(view.getByRole("textbox"), {
          target: { value: "fresh text" },
        });
        fireEvent.submit(view.container.querySelector("form")!);
      });
      expect(sends).toBe(1);
    } finally {
      view.unmount();
      uploads.mockRestore();
    }
  });
}

it("keeps oversize and failed images removable without sending them", async () => {
  sessionStorage.clear();
  const uploads = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("failed", { status: 500 }),
  );
  const view = render(<WidgetChat {...props} />);
  try {
    const tooLarge = imageFile();
    Object.defineProperty(tooLarge, "size", { value: 201 * 1024 * 1024 });
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [tooLarge] },
      });
    });
    expect(uploads).not.toHaveBeenCalled();
    expect(
      view.container.querySelector(".app-widget-image [role=status]"),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        view.container.querySelector(".app-widget-image button")!,
      );
    });
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [imageFile()] },
      });
    });
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector(".app-widget-image [role=status]"),
    ).not.toBeNull();
    expect(
      (
        view.container.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(
        view.container.querySelector(".app-widget-image button")!,
      );
    });
    expect(view.container.querySelectorAll(".app-widget-image")).toHaveLength(
      0,
    );
  } finally {
    view.unmount();
    uploads.mockRestore();
  }
});

it("folds a settled tool group, expands results on demand, and updates the office avatar", () => {
  const entries: import("../shared/types.ts").LogEntry[] = [
    {
      id: "c1",
      agentId: "one",
      timestamp: 1,
      kind: "tool_call",
      content: "Bash",
      metadata: { toolId: "t1", input: { command: "pwd" } },
    },
    {
      id: "r1",
      agentId: "one",
      timestamp: 2,
      kind: "tool_result",
      content: "first result body",
      metadata: { toolUseId: "t1" },
    },
    {
      id: "c2",
      agentId: "one",
      timestamp: 3,
      kind: "tool_call",
      content: "Bash",
      metadata: { toolId: "t2", input: { command: "ls" } },
    },
    {
      id: "r2",
      agentId: "one",
      timestamp: 4,
      kind: "tool_result",
      content: "second result body",
      metadata: { toolUseId: "t2" },
    },
  ];
  const view = render(<WidgetChat {...props} logs={entries} />);
  const log = view.container.querySelector('[role="log"]')!;
  expect(log.textContent?.includes("first result body")).toBe(false);
  const group = log.querySelector("button")!;
  expect(group).not.toBeNull();
  fireEvent.click(group);
  expect(log.textContent?.includes("pwd")).toBe(true);
  fireEvent.click(log.querySelector("button")!);
  expect(log.textContent?.includes("pwd")).toBe(false);
  view.rerender(
    <WidgetChat
      {...props}
      logs={entries}
      agent={{ ...agent, state: "thinking" }}
      stateChangedAt={Date.now() - 180000}
    />,
  );
  expect(
    view.container
      .querySelector(".app-widget-avatar")
      ?.getAttribute("data-agent-state"),
  ).toBe("thinking");
  expect(view.container.querySelector(".app-widget-avatar svg")).not.toBeNull();
  expect(log.textContent?.includes("pwd")).toBe(true);
  // Only the tool disclosure/copy controls occur in the transcript; no abort.
  expect(
    log.querySelector('button[title="' + en["logView.abortTitle"] + '"]'),
  ).toBeNull();
});

it("toggles the desktop chat with its launcher, and Escape closes it", async () => {
  sessionStorage.clear();
  const { StateCtx, initialState } = await import("./store.tsx");
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM.settings;
  const iframeLoading = settings.disableIframePageLoading;
  settings.disableIframePageLoading = true;
  setApiShim(async () => ({
    ...boot,
    appUrl: "https://hello.office.example",
    sessionExpiresAt: Date.now() + 1000000,
    chat: { agentId: agent.id, agentName: agent.name },
  }));
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => {
      view = render(
        <StateCtx.Provider
          value={{ ...initialState, agents: [agent], connected: true }}
        >
          <AppWidgetPage boot={boot} />
        </StateCtx.Provider>,
      );
    });
    const launcher = view!.container.querySelector<HTMLButtonElement>(
      ".app-widget-launcher",
    )!;
    const panel = view!.container.querySelector<HTMLElement>(
      "#" + launcher.getAttribute("aria-controls"),
    )!;
    const isOpen = () => {
      const expanded = launcher.getAttribute("aria-expanded");
      expect(panel.style.display).toBe(expanded === "true" ? "flex" : "none");
      return expanded === "true";
    };
    // The direct link is only in the open panel's header: the closed dock
    // holds the launcher alone (Nil, 2026-10-20).
    const direct = "https://hello.office.example/" + window.location.search;
    const dock = view!.container.querySelector(".app-widget-dock")!;
    const dockLink = () =>
      view!.container.querySelector<HTMLAnchorElement>(".app-widget-dock a");
    const headerLink = () =>
      panel.querySelector<HTMLAnchorElement>("header a.app-widget-direct");
    expect(isOpen()).toBe(false);
    expect(dock.contains(launcher)).toBe(true);
    expect(dockLink()).toBeNull();
    fireEvent.click(launcher);
    expect(isOpen()).toBe(true);
    expect(dockLink()).toBeNull();
    expect(headerLink()?.href).toBe(direct);
    expect(headerLink()?.target).toBe("_blank");
    // The launcher is the only close control: the chat header holds none.
    expect(panel.querySelector("header button")).toBeNull();
    fireEvent.click(launcher);
    expect(isOpen()).toBe(false);
    expect(dockLink()).toBeNull();
    fireEvent.click(launcher);
    fireEvent.keyDown(panel.querySelector("textarea")!, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(launcher);
  } finally {
    view?.unmount();
    settings.disableIframePageLoading = iframeLoading;
  }
});

// With no expanded view the widget shows no direct link: a phone's chat
// launcher opens the office instead. With no chat target there is no widget,
// and the lone dock link is the way out of the frame; on the iPhone Home
// Screen it must leave for Safari, since that window has no Back button.
for (const [variant, phone, homeScreen] of [
  ["phone", true, false],
  ["phone on the iPhone Home Screen", true, true],
  ["no chat target", false, false],
  ["no chat target on the iPhone Home Screen", false, true],
] as const) {
  it(`shows the direct link only where no chat launcher is (${variant})`, async () => {
    sessionStorage.clear();
    const { asDevice, IPHONE_HOME_SCREEN } =
      await import("./test-support/ios-home-screen.ts");
    const undo = homeScreen ? asDevice(IPHONE_HOME_SCREEN) : () => {};
    const { StateCtx, initialState } = await import("./store.tsx");
    const settings = (
      window as unknown as {
        happyDOM: { settings: { disableIframePageLoading: boolean } };
      }
    ).happyDOM.settings;
    const iframeLoading = settings.disableIframePageLoading;
    settings.disableIframePageLoading = true;
    setApiShim(async () => ({
      ...boot,
      appUrl: "https://hello.office.example",
      sessionExpiresAt: Date.now() + 1000000,
      chat: phone ? { agentId: agent.id, agentName: agent.name } : null,
    }));
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => {
        view = render(
          <StateCtx.Provider
            value={{
              ...initialState,
              agents: [agent],
              connected: true,
              isMobile: phone,
            }}
          >
            <AppWidgetPage boot={boot} />
          </StateCtx.Provider>,
        );
      });
      const dock = view!.container.querySelector(".app-widget-dock")!;
      const links = view!.container.querySelectorAll<HTMLAnchorElement>("a");
      expect(view!.container.querySelector("#app-widget-chat")).toBeNull();
      expect(dock.querySelector(".app-widget-launcher") !== null).toBe(phone);
      if (phone) {
        // On the iPhone Home Screen the launcher is itself a link to Safari
        // (ui/AppWidgetPage.install.dom.test.tsx); no other link shows.
        expect(
          [...links].filter(
            (link) => !link.classList.contains("app-widget-launcher"),
          ),
        ).toHaveLength(0);
        return;
      }
      expect(links).toHaveLength(1);
      expect(dock.contains(links[0])).toBe(true);
      expect(links[0].getAttribute("href")).toBe(
        (homeScreen ? "x-safari-" : "") +
          "https://hello.office.example/" +
          window.location.search,
      );
      expect(links[0].getAttribute("aria-label")).toBeTruthy();
    } finally {
      view?.unmount();
      settings.disableIframePageLoading = iframeLoading;
      undo();
    }
  });
}

// A scroll model for the widget log: scrollHeight is set by the test, any
// scrollTop change is clamped and fires scroll as a browser does, and
// scrollIntoView on a node inside the log moves it to the bottom.
function scrollModel(log: HTMLElement) {
  const viewport = 200;
  let top = 0;
  const model = {
    height: 1000,
    get top() {
      return top;
    },
    get gap() {
      return model.height - viewport - top;
    },
    // The member scrolls the log.
    scrollTo(value: number) {
      log.scrollTop = value;
    },
  };
  Object.defineProperty(log, "scrollHeight", { get: () => model.height });
  Object.defineProperty(log, "clientHeight", { get: () => viewport });
  Object.defineProperty(log, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      const next = Math.max(0, Math.min(value, model.height - viewport));
      if (next === top) return;
      top = next;
      log.dispatchEvent(new Event("scroll"));
    },
  });
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  Element.prototype.scrollIntoView = function (this: Element) {
    if (log.contains(this)) log.scrollTop = model.height;
  };
  const restore = () => {
    if (original)
      Object.defineProperty(Element.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  };
  return { model, restore };
}

function textEntry(n: number): import("../shared/types.ts").LogEntry {
  return {
    id: `m${n}`,
    agentId: "one",
    timestamp: n,
    kind: "text",
    content: `message ${n}`,
  };
}

it("follows new messages only while the member is at the bottom of the log", async () => {
  sessionStorage.clear();
  let logs = [textEntry(1)];
  const view = render(<WidgetChat {...props} logs={logs} open={false} />);
  const log = view.container.querySelector<HTMLElement>('[role="log"]')!;
  const { model, restore } = scrollModel(log);
  const arrive = (open = true) => {
    logs = [...logs, textEntry(logs.length + 1)];
    model.height += 100;
    view.rerender(<WidgetChat {...props} logs={logs} open={open} />);
  };
  try {
    view.rerender(<WidgetChat {...props} logs={logs} open />);
    expect(model.gap).toBe(0);
    arrive();
    expect(model.gap).toBe(0);

    // Scrolled up to read: a new message and an unrelated re-render keep the view.
    model.scrollTo(300);
    arrive();
    expect(model.top).toBe(300);
    view.rerender(
      <WidgetChat
        {...props}
        logs={logs}
        open
        agent={{ ...agent, state: "thinking" }}
      />,
    );
    expect(model.top).toBe(300);

    // Back at the bottom: follows again.
    model.scrollTo(model.height);
    arrive();
    expect(model.gap).toBe(0);

    // A small move up near the bottom still follows.
    model.scrollTo(model.top - 20);
    expect(model.gap).toBe(20);
    arrive();
    expect(model.gap).toBe(0);

    // Content grew under the pinned view before its scroll event: no move up,
    // so it still follows.
    model.height += 300;
    fireEvent.scroll(log);
    expect(model.gap).toBe(300);
    arrive();
    expect(model.gap).toBe(0);

    // Scrolled up, closed, a message arrives, reopened: back at the bottom.
    model.scrollTo(200);
    view.rerender(<WidgetChat {...props} logs={logs} open={false} />);
    arrive(false);
    expect(model.top).toBe(200);
    view.rerender(<WidgetChat {...props} logs={logs} open />);
    expect(model.gap).toBe(0);
  } finally {
    restore();
    view.unmount();
  }
});

for (const echo of ["before", "after"] as const) {
  it(`shows the member's own message after a send from an earlier position (echo ${echo} the reply)`, async () => {
    sessionStorage.clear();
    let respond: (ok: boolean) => void = () => {};
    setApiShim(
      () =>
        new Promise((resolve, reject) => {
          respond = (ok) => (ok ? resolve({}) : reject(new Error("offline")));
        }),
    );
    let logs = [textEntry(1)];
    const view = render(<WidgetChat {...props} logs={logs} open={false} />);
    const log = view.container.querySelector<HTMLElement>('[role="log"]')!;
    const { model, restore } = scrollModel(log);
    const echoMessage = () => {
      logs = [...logs, textEntry(logs.length + 1)];
      model.height += 100;
      view.rerender(<WidgetChat {...props} logs={logs} open />);
    };
    const submit = async (value: string) => {
      await act(async () => {
        fireEvent.change(view.getByRole("textbox"), { target: { value } });
      });
      await act(async () => {
        fireEvent.submit(view.container.querySelector("form")!);
      });
    };
    try {
      view.rerender(<WidgetChat {...props} logs={logs} open />);
      model.scrollTo(300);

      // A failed send leaves the member where they were, and still reading.
      await submit("lost");
      await act(async () => respond(false));
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "lost",
      );
      expect(model.top).toBe(300);
      echoMessage();
      expect(model.top).toBe(300);

      await submit("hello");
      if (echo === "before") echoMessage();
      await act(async () => respond(true));
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
      if (echo === "after") echoMessage();
      expect(model.gap).toBe(0);
    } finally {
      restore();
      view.unmount();
    }
  });
}

it("shows the queued count in its own element while messages wait, busy or not", () => {
  sessionStorage.clear();
  const queued = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `q${i}`,
      sender: { kind: "user" },
      text: `message ${i}`,
    })) as unknown as import("../shared/types.ts").QueuedMessage[];
  const pill = () => view.container.querySelector(".app-widget-queue");
  const status = () =>
    view.container.querySelector(".app-widget-status")?.textContent;
  const view = render(
    <WidgetChat
      {...props}
      agent={{ ...agent, state: "thinking", queue: queued(2) }}
    />,
  );
  try {
    // Busy with two waiting: the count shows in its own element. The status
    // text stays empty, since the avatar and the Queue button show the work.
    expect(pill()).not.toBeNull();
    expect(pill()!.closest("form")).not.toBeNull();
    expect(pill()!.closest(".app-widget-status")).toBeNull();
    expect(pill()!.textContent).toContain("2");
    expect(status()).toBe("");

    // The count follows the queue.
    view.rerender(
      <WidgetChat
        {...props}
        agent={{ ...agent, state: "tool_executing", queue: queued(3) }}
      />,
    );
    expect(pill()!.textContent).toContain("3");
    expect(pill()!.textContent).not.toContain("2");

    // Idle with messages still waiting (before the flush): the count stays.
    view.rerender(
      <WidgetChat {...props} agent={{ ...agent, queue: queued(1) }} />,
    );
    expect(pill()!.textContent).toContain("1");
    expect(status()).toBe("");

    // Empty queue: no element at all.
    view.rerender(
      <WidgetChat {...props} agent={{ ...agent, state: "thinking" }} />,
    );
    expect(pill()).toBeNull();
    expect(status()).toBe("");
  } finally {
    view.unmount();
  }
});

it("links the agent's name in the header to its office chat, in a new tab", () => {
  const view = render(<WidgetChat {...props} />);
  const link = view.container.querySelector<HTMLAnchorElement>(
    ".app-widget-header h1 a",
  );
  expect(link).not.toBeNull();
  expect(link!.textContent).toBe(agent.name);
  expect(link!.getAttribute("href")).toBe(`/agents/${agent.id}`);
  expect(link!.getAttribute("target")).toBe("_blank");
  expect(link!.getAttribute("rel")?.split(" ")).toContain("noopener");
  view.unmount();
});

// The server records an agent's sends in its own log (task 40b82508). The
// widget shows no card for such a record, and a record that arrives while the
// chat is closed (a scheduled send fires) does not mark the chat unread.
it("a recorded send neither shows in the widget chat nor marks it unread", async () => {
  sessionStorage.clear();
  const { StateCtx, initialState } = await import("./store.tsx");
  const settings = (
    window as unknown as {
      happyDOM: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM.settings;
  const iframeLoading = settings.disableIframePageLoading;
  settings.disableIframePageLoading = true;
  setApiShim(async () => ({
    ...boot,
    appUrl: "https://hello.office.example",
    sessionExpiresAt: Date.now() + 1000000,
    chat: { agentId: agent.id, agentName: agent.name },
  }));
  type LogEntry = import("../shared/types.ts").LogEntry;
  const reply = (id: string): LogEntry => ({
    id,
    agentId: agent.id,
    timestamp: 1,
    kind: "text",
    content: `reply ${id}`,
  });
  const sent: LogEntry = {
    id: "o1",
    agentId: agent.id,
    timestamp: 2,
    kind: "agent_outbound",
    content: "RECORDED-SEND body",
    metadata: { recipient_agent_id: "two", recipient_agent_name: "Two" },
  };
  const tree = (logs: LogEntry[]) => (
    <StateCtx.Provider
      value={{
        ...initialState,
        agents: [agent],
        connected: true,
        logs: new Map([[agent.id, logs]]),
      }}
    >
      <AppWidgetPage boot={boot} />
    </StateCtx.Provider>
  );
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => {
      view = render(tree([reply("r1")]));
    });
    const launcher = view!.container.querySelector<HTMLButtonElement>(
      ".app-widget-launcher",
    )!;
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    // The unread dot is the launcher's one element besides the avatar.
    const dots = () =>
      Array.from(launcher.children).filter(
        (el) => !el.classList.contains("app-widget-avatar"),
      ).length;
    expect(dots()).toBe(0);
    view!.rerender(tree([reply("r1"), sent]));
    expect(dots()).toBe(0);
    expect(view!.container.textContent).toContain("reply r1");
    expect(view!.container.textContent).not.toContain("RECORDED-SEND");
    // Control: a visible entry does mark the closed chat unread.
    view!.rerender(tree([reply("r1"), sent, reply("r2")]));
    expect(dots()).toBe(1);
  } finally {
    view?.unmount();
    settings.disableIframePageLoading = iframeLoading;
  }
});
