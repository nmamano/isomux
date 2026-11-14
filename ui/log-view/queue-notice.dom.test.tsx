// An office notice waiting in the queue (task 9019f2f8): the chat already
// shows its system line, so the queue strip does not show it again as a chip
// from the member whose act it reports.
import { expect, it } from "bun:test";
import { setUpDomTestFile, stubGlobal } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { LogView } = await import("./LogView.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type QueuedMessage = import("../../shared/types.ts").QueuedMessage;

const NOTICE: QueuedMessage = {
  id: "q1",
  sender: { kind: "user", username: "Tester" },
  text: "[Isomux: NOTICE-LINE]",
  notice: true,
  queuedAt: 1,
};
const MEMBER: QueuedMessage = {
  id: "q2",
  sender: { kind: "user", username: "Tester" },
  text: "MEMBER-LINE",
  queuedAt: 2,
};

const agent = {
  id: "a1",
  name: "Asker",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "thinking",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

function textWith(queue: QueuedMessage[]): string {
  const withQueue: AgentInfo = { ...agent, queue };
  const view = render(
    onLanguage(
      "en",
      createElement(LogView, {
        agent: withQueue,
        logs: [],
        onBack: () => {},
        onEditAgent: () => {},
      }),
      { agents: [withQueue], hasReceivedInitialState: true, connected: true },
    ),
  );
  const text = view.container.textContent ?? "";
  view.unmount();
  return text;
}

it("the queue strip leaves out a waiting notice and keeps the member's message", () => {
  setApiShim(async () => undefined);
  try {
    const both = textWith([NOTICE, MEMBER]);
    expect(both).toContain("MEMBER-LINE");
    expect(both).not.toContain("NOTICE-LINE");
    // The strip counts what it shows: the same as with the member's message
    // alone.
    expect(both).toBe(textWith([MEMBER]));
    // A notice alone leaves no strip at all.
    expect(textWith([NOTICE])).toBe(textWith([]));
  } finally {
    setApiShim(null);
  }
});

// A queued message's text is lost when it is removed, with no Undo (task
// c6589760): its remove button asks first.
it("removing a queued message arms on the first click and sends nothing; the second removes that message once", async () => {
  const deletes: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "DELETE") deletes.push(path);
    return undefined;
  });
  const OTHER: QueuedMessage = { ...MEMBER, id: "q3", text: "OTHER-LINE" };
  const withQueue: AgentInfo = { ...agent, queue: [MEMBER, OTHER] };
  const view = render(
    onLanguage(
      "en",
      createElement(LogView, {
        agent: withQueue,
        logs: [],
        onBack: () => {},
        onEditAgent: () => {},
      }),
      { agents: [withQueue], hasReceivedInitialState: true, connected: true },
    ),
  );
  // The one button in the chip that holds the message.
  const removeOf = (text: string) => {
    const buttons = [
      ...view.container.querySelectorAll<HTMLElement>("button"),
    ].filter((b) => {
      const chip = b.parentElement;
      return (
        !!chip?.textContent?.includes(text) &&
        !chip.textContent.includes(
          text === "MEMBER-LINE" ? "OTHER-LINE" : "MEMBER-LINE",
        )
      );
    });
    expect(buttons).toHaveLength(1);
    return buttons[0];
  };
  try {
    await act(async () => fireEvent.click(removeOf("MEMBER-LINE")));
    expect(deletes).toEqual([]);
    expect(removeOf("MEMBER-LINE").hasAttribute("data-confirm-armed")).toBe(
      true,
    );
    expect(removeOf("OTHER-LINE").hasAttribute("data-confirm-armed")).toBe(
      false,
    );
    await act(async () => fireEvent.click(removeOf("MEMBER-LINE")));
    expect(deletes).toEqual(["/api/agents/a1/queue/q2"]);
  } finally {
    view.unmount();
    setApiShim(null);
  }
});

// Send now in the full chat (task 9f2f337b moved its calls into shared code
// with the app widget): the button by the queue count and Ctrl/Cmd+Enter.
// `draft` is the composer text: the fixture state is fixed, so typing does not
// reach the store.
async function steerChat(queue: QueuedMessage[], draft = "") {
  const { en } = await import("../../shared/i18n/en.ts");
  const calls: { method: string; path: string; body: unknown }[] = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return undefined;
  });
  const withQueue: AgentInfo = { ...agent, queue };
  const view = render(
    onLanguage(
      "en",
      createElement(LogView, {
        agent: withQueue,
        logs: [],
        onBack: () => {},
        onEditAgent: () => {},
      }),
      {
        agents: [withQueue],
        hasReceivedInitialState: true,
        connected: true,
        drafts: new Map([[withQueue.id, draft]]),
      },
    ),
  );
  const boxes = view.container.querySelectorAll("textarea");
  const box = boxes[boxes.length - 1];
  const sendNowButton = () =>
    [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === en["logView.queue.flushNow"],
    );
  const sent = () => calls.filter((c) => c.method === "POST");
  const done = async () => {
    await act(async () => {});
    view.unmount();
    setApiShim(null);
  };
  return { box, sendNowButton, sent, done };
}

it("the Send now button by the queue count delivers this agent's queue", async () => {
  const { sendNowButton, sent, done } = await steerChat([MEMBER]);
  try {
    expect(sendNowButton()).toBeDefined();
    await act(async () => fireEvent.click(sendNowButton()!));
    expect(sent()).toEqual([
      { method: "POST", path: "/api/agents/a1/send-now", body: undefined },
    ]);
  } finally {
    await done();
  }
});

it("Ctrl/Cmd+Enter posts the message with sendNow, or on an empty composer delivers the queue", async () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const { box, sent, done } = await steerChat([MEMBER], "correct course");
    try {
      expect(box.value).toBe("correct course");
      await act(async () => {
        fireEvent.keyDown(box, { key: "Enter", ...modifier });
      });
      expect(sent()).toHaveLength(1);
      expect(sent()[0].path).toBe("/api/agents/a1/messages");
      expect(sent()[0].body).toMatchObject({
        text: "correct course",
        sendNow: true,
      });
    } finally {
      await done();
    }
  }
  const { box, sent, done } = await steerChat([MEMBER]);
  try {
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(sent()).toEqual([
      { method: "POST", path: "/api/agents/a1/send-now", body: undefined },
    ]);
  } finally {
    await done();
  }
});

// A long queued message (task 56dc8307): the chip clamps its text and offers
// Show more only when the clamp cuts it. happy-dom has no layout and drops
// the line clamp, so the cut is stubbed through scrollHeight/clientHeight and
// the clamped state is read from the text's overflow; the real clamp is
// checked in a browser.
const CUT = new Set<string>();
const observers = new Map<Element, (() => void)[]>();

async function chipView(queue: QueuedMessage[]) {
  const { en } = await import("../../shared/i18n/en.ts");
  const deletes: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "DELETE") deletes.push(path);
    return undefined;
  });
  const proto = HTMLElement.prototype;
  const ownScroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const ownClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  // A text in CUT overflows its box; every other element fits.
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const text = this.textContent ?? "";
      return [...CUT].some((t) => text.includes(t)) ? 100 : 20;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: () => 20,
  });
  // The harness puts the real one back when the file ends.
  stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {}
      observe(el: Element) {
        observers.set(el, [...(observers.get(el) ?? []), this.cb]);
      }
      unobserve() {}
      disconnect() {}
    },
  );

  // Puts back what this view stubbed; `view` is missing when render threw.
  const restore = () => {
    setApiShim(null);
    observers.clear();
    CUT.clear();
    for (const [name, own] of [
      ["scrollHeight", ownScroll],
      ["clientHeight", ownClient],
    ] as const) {
      if (own) Object.defineProperty(proto, name, own);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  };
  const withQueue: AgentInfo = { ...agent, queue };
  let view: ReturnType<typeof render>;
  try {
    view = render(
      onLanguage(
        "en",
        createElement(LogView, {
          agent: withQueue,
          logs: [],
          onBack: () => {},
          onEditAgent: () => {},
        }),
        { agents: [withQueue], hasReceivedInitialState: true, connected: true },
      ),
    );
  } catch (error) {
    restore();
    throw error;
  }
  // The chip of a message: the nearest ancestor of its text that holds a
  // remove button.
  const chipOf = (text: string) => {
    for (
      let node = textOf(text).parentElement;
      node;
      node = node.parentElement
    ) {
      const removes = [...node.querySelectorAll("button")].filter(
        (b) => b.getAttribute("title") === en["logView.queue.cancel"],
      );
      if (removes.length > 0) {
        expect(removes.length).toBe(1);
        return node;
      }
    }
    throw new Error(`no chip holds ${text}`);
  };
  const buttons = (text: string) => [
    ...chipOf(text).querySelectorAll<HTMLElement>("button"),
  ];
  // The Show more / Show less control of a chip, or undefined.
  const toggleOf = (text: string) => {
    const found = buttons(text).filter((b) => b.hasAttribute("aria-expanded"));
    expect(found.length).toBeLessThanOrEqual(1);
    return found[0] as HTMLElement | undefined;
  };
  const removeOf = (text: string) => {
    const found = buttons(text).filter((b) => !b.hasAttribute("aria-expanded"));
    expect(found.length).toBe(1);
    return found[0];
  };
  // The element that holds exactly the message text.
  const textOf = (text: string) => {
    const found = [
      ...view.container.querySelectorAll<HTMLElement>("div"),
    ].filter((d) => d.textContent === text);
    expect(found.length).toBe(1);
    return found[0];
  };
  // Click the Show more of a chip that has one.
  const expand = async (text: string) => {
    const more = toggleOf(text);
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(more!));
  };
  const clamped = (text: string) => textOf(text).style.overflow === "hidden";
  const resize = async (text: string) => {
    const callbacks = observers.get(textOf(text)) ?? [];
    await act(async () => {
      for (const cb of callbacks) cb();
    });
    return callbacks.length;
  };
  const done = async () => {
    await act(async () => {});
    view.unmount();
    restore();
  };
  return { en, deletes, toggleOf, removeOf, expand, clamped, resize, done };
}

const LONG: QueuedMessage = { ...MEMBER, id: "q4", text: "LONG-LINE" };
const SHORT: QueuedMessage = { ...MEMBER, id: "q5", text: "SHORT-LINE" };
const LONG2: QueuedMessage = { ...MEMBER, id: "q6", text: "LONG2-LINE" };

it("a queued text the clamp does not cut has no Show more", async () => {
  const v = await chipView([SHORT]);
  try {
    expect(v.toggleOf("SHORT-LINE")).toBeUndefined();
  } finally {
    await v.done();
  }
});

it("a cut queued text shows Show more, expands to the full text and clamps again", async () => {
  CUT.add("LONG-LINE");
  const v = await chipView([LONG]);
  try {
    expect(v.clamped("LONG-LINE")).toBe(true);
    const more = v.toggleOf("LONG-LINE");
    expect(more?.getAttribute("type")).toBe("button");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(more?.textContent).toBe(v.en["cards.toolResult.showMore"]);

    await act(async () => fireEvent.click(more!));
    expect(v.clamped("LONG-LINE")).toBe(false);
    const less = v.toggleOf("LONG-LINE");
    expect(less?.getAttribute("aria-expanded")).toBe("true");
    expect(less?.textContent).toBe(v.en["cards.toolResult.showLess"]);

    await act(async () => fireEvent.click(less!));
    expect(v.clamped("LONG-LINE")).toBe(true);
    expect(v.toggleOf("LONG-LINE")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  } finally {
    await v.done();
  }
});

it("expanding one queued message leaves the others clamped", async () => {
  CUT.add("LONG-LINE");
  CUT.add("LONG2-LINE");
  const v = await chipView([LONG, LONG2]);
  try {
    await v.expand("LONG-LINE");
    expect(v.clamped("LONG-LINE")).toBe(false);
    expect(v.clamped("LONG2-LINE")).toBe(true);
    expect(v.toggleOf("LONG2-LINE")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  } finally {
    await v.done();
  }
});

it("an expanded queued message is still removed by its x and confirm", async () => {
  CUT.add("LONG-LINE");
  const v = await chipView([LONG, SHORT]);
  try {
    await v.expand("LONG-LINE");
    expect(v.clamped("LONG-LINE")).toBe(false);
    await act(async () => fireEvent.click(v.removeOf("LONG-LINE")));
    expect(v.deletes).toEqual([]);
    expect(v.removeOf("LONG-LINE").hasAttribute("data-confirm-armed")).toBe(
      true,
    );
    await act(async () => fireEvent.click(v.removeOf("LONG-LINE")));
    expect(v.deletes).toEqual(["/api/agents/a1/queue/q4"]);
  } finally {
    await v.done();
  }
});

it("a chip that becomes narrower and cuts its text then shows Show more", async () => {
  const v = await chipView([LONG]);
  try {
    expect(v.toggleOf("LONG-LINE")).toBeUndefined();
    CUT.add("LONG-LINE");
    // The resize observer of the text is what tells the chip.
    expect(await v.resize("LONG-LINE")).toBeGreaterThan(0);
    expect(v.toggleOf("LONG-LINE")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  } finally {
    await v.done();
  }
});
