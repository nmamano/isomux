import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./log-view/LogView.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");

type LogEntry = import("../shared/types.ts").LogEntry;
type AgentInfo = import("../shared/types.ts").AgentInfo;
const agent = {
  id: "a1",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
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
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
  capabilities: { edit: true },
} as unknown as AgentInfo;
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

// The two controls' names, from the catalog of the language on screen.
const controls = (language: "es" | null) => {
  const { t } = translatorFor(language ?? "en");
  return {
    expand: t("cards.userMessage.expand"),
    collapse: t("cards.userMessage.collapse"),
  };
};
const { expand: EXPAND, collapse: COLLAPSE } = controls(null);

// happy-dom has no layout. Supply only the measured height; the real LogView
// still decides sender scope, clips the body and keeps the expansion state.
const heightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const clientDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
// The height a two-line clamp shows.
const CLAMP_HEIGHT = 40;
const OriginalObserver = globalThis.ResizeObserver;
const observed = new Map<Element, () => void>();
let measuredHeight = 300;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this.textContent?.includes("Long ") ? measuredHeight : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => CLAMP_HEIGHT,
  });
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(element: Element) {
      observed.set(element, this.callback);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      for (const [element, callback] of observed)
        if (callback === this.callback) observed.delete(element);
    }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalObserver;
  if (heightDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      heightDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  if (clientDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      clientDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});
beforeEach(() => {
  measuredHeight = 300;
});

function message(
  id: string,
  metadata: LogEntry["metadata"] = {},
  kind: LogEntry["kind"] = "user_message",
): LogEntry {
  return {
    id,
    agentId: agent.id,
    timestamp: 1,
    kind,
    content: `Long ${id} message`,
    metadata,
  };
}
const peer = message("peer", { sender_agent_name: "Peer" });
const app = message("app", { sender_app_name: "Monitor" });
const mount = (
  logs: LogEntry[],
  language: "es" | null = null,
  isMobile = false,
) =>
  onLanguage(
    language,
    createElement(LogView, { agent, logs, onBack() {}, onEditAgent() {} }),
    {
      agents: [agent],
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
      ],
      hasReceivedInitialState: true,
      connected: true,
      isMobile,
    },
  );
function body(button: HTMLElement) {
  return document.getElementById(button.getAttribute("aria-controls")!)!;
}

describe("inbound message height", () => {
  it("collapses only agent and app messages, expands independently, and remembers each while the view lives", () => {
    const logs = [
      peer,
      app,
      message("morgan", { username: "Nil" }),
      message("reply", {}, "text"),
      message("cron", { sender_cronjob_name: "Nightly" }),
    ];
    const view = render(mount(logs));
    const buttons = view.getAllByRole("button", { name: EXPAND });
    expect(buttons).toHaveLength(2);
    // The agent's message is clamped by lines (happy-dom drops the line
    // clamp itself), the app's to six lines' height.
    expect(body(buttons[0]).style.overflow).toBe("hidden");
    expect(body(buttons[0]).style.maxHeight).toBe("");
    expect(parseFloat(body(buttons[1]).style.maxHeight)).toBeCloseTo(124.8);
    expect(body(buttons[1]).style.overflow).toBe("hidden");
    fireEvent.click(buttons[1]);
    const collapse = view.getByRole("button", { name: COLLAPSE });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(body(collapse).style.maxHeight).toBe("");
    expect(view.getAllByRole("button", { name: EXPAND })).toHaveLength(1);
    view.rerender(mount([app]));
    view.rerender(mount(logs));
    expect(view.getAllByRole("button", { name: COLLAPSE })).toHaveLength(1);
    fireEvent.click(view.getByRole("button", { name: COLLAPSE }));
    expect(view.getAllByRole("button", { name: EXPAND })).toHaveLength(2);
    for (const id of ["morgan", "cron"])
      expect(
        view.getByText(`Long ${id} message`).parentElement!.parentElement!.style
          .maxHeight,
      ).toBe("");
  });

  it("expands when keyboard focus reaches a clipped attachment and keeps it open on later focus", () => {
    const withFile = {
      ...app,
      attachments: [
        {
          filename: "report.txt",
          originalName: "report.txt",
          mediaType: "text/plain",
          size: 120,
        },
      ],
    };
    const view = render(mount([withFile]));
    expect(view.getByRole("button", { name: EXPAND })).not.toBeNull();
    // The chip, not its download button (a[download]) that names the same file.
    const chips = view
      .getAllByRole("link", { name: /report\.txt/ })
      .filter((link) => !link.hasAttribute("download"));
    expect(chips).toHaveLength(1);
    const attachment = chips[0];
    act(() => attachment.focus());
    expect(document.activeElement).toBe(attachment);
    const collapse = view.getByRole("button", { name: COLLAPSE });
    expect(body(collapse).style.maxHeight).toBe("");
    act(() => {
      attachment.blur();
      attachment.focus();
    });
    expect(view.getByRole("button", { name: COLLAPSE })).toBe(collapse);
  });

  it("does not offer expansion for short messages; resize can make wrapped text overflow", () => {
    measuredHeight = 20;
    const view = render(mount([peer, { ...app, content: "OK" }]));
    expect(view.queryByRole("button", { name: EXPAND })).toBeNull();
    measuredHeight = 300;
    act(() => {
      for (const callback of observed.values()) callback();
    });
    expect(view.getAllByRole("button", { name: EXPAND })).toHaveLength(1);
    measuredHeight = 20;
    act(() => {
      for (const callback of observed.values()) callback();
    });
    expect(view.queryByRole("button", { name: EXPAND })).toBeNull();
  });

  it("uses a six-line phone preview and translates both controls", () => {
    const view = render(mount([app], null, true));
    const expand = view.getByRole("button", { name: EXPAND });
    expect(body(expand).style.maxHeight).toBe("144px");
    for (const language of [null, "es"] as const) {
      const { expand: open, collapse: close } = controls(language);
      view.rerender(mount([app], language, true));
      fireEvent.click(view.getByRole("button", { name: open }));
      fireEvent.click(view.getByRole("button", { name: close }));
      expect(
        view.getByRole("button", { name: open }).getAttribute("aria-expanded"),
      ).toBe("false");
    }
  });
});
