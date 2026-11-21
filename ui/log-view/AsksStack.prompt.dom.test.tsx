// The stack of open asks above the chat input (internal-docs/asks-design.md):
// an ask's colour markup on the card and the collapsed bar, the simplify
// banner with Undo and the original prompt, and the stack's height, fade and
// scroll. Split from ui/log-view/AsksStack.dom.test.tsx, which holds the
// cards, their answers and links, because the 5 s cap is per file;
// ui/log-view/AsksStack.reply.dom.test.tsx holds the options and the reply
// field.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { askExcerpt } = await import("./ask-about.ts");
const { ENTRIES, NOW, cards, entry, mount, seeded, tree } =
  await import("../test-support/asks-stack-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; body: Record<string, unknown> }[] = [];
let answer: (path: string) => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  answer = async () => undefined;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
      return answer(path);
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

// The reply field of one card.
const field = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLTextAreaElement>(
    `[data-ask="${id}"] form [data-ask-reply-input]`,
  )!;
// Only the Inbox holds an answer on a one-line Undo line and scrolls it into
// view (ui/components/AsksView.held.dom.test.tsx): the chat's stack sends at once
// and never scrolls.
it("scrolls nothing when an answer closes a card in the chat's stack", async () => {
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  )!;
  expect(typeof original.value).toBe("function");
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.closest<HTMLElement>("[data-ask]")?.dataset.ask ?? "");
  };
  try {
    // Reply, Dismiss and filing as a task (task 1466ea8b: the last two are
    // a tag, then the send button).
    for (const clicks of [
      ["form button[type=submit]"],
      ['[data-ask-tag="dismiss"]', "[data-ask-send]"],
      [
        '[data-ask-tag="postpone"]',
        '[data-ask-suggestion="file"]',
        "[data-ask-send]",
      ],
    ]) {
      const selector = clicks.join(" > ");
      posts = [];
      const view = mount(false);
      await waitFor(() => expect(cards(view.container).length).toBe(2));
      for (const click of clicks)
        await act(async () => {
          fireEvent.click(
            view.container.querySelector<HTMLButtonElement>(
              `[data-ask="aaaa0001"] ${click}`,
            )!,
          );
          await new Promise((r) => setTimeout(r, 0));
        });
      expect([selector, posts.length, cards(view.container)]).toEqual([
        selector,
        1,
        ["bbbb0002"],
      ]);
      view.unmount();
    }
    expect(scrolled).toEqual([]);
  } finally {
    Object.defineProperty(Element.prototype, "scrollIntoView", original);
  }
});

// Colour markup on every kind of ask (task b2f055c6): agents open an ask with
// a coloured kind label, and a sudo or secret card draws it as a plain ask's
// card does. The collapsed bar draws the newest plain ask's first line with
// its markup too.
const KIND_LABEL = ":purple[**Quick action**]";
const LABELED: AskEntry[] = [
  entry("cdef0101", "c1", `${KIND_LABEL} Ship it?`, 1),
  {
    ...entry("cdef0102", "c1", `${KIND_LABEL} Restart the service.`, 2),
    sudo: {
      requestId: "sudo-1",
      command: "systemctl restart isomux",
      cwd: "/w",
    },
  },
  {
    ...entry("cdef0103", "c1", `${KIND_LABEL} To open the pull request.`, 3),
    secret: {
      requestId: "req-2",
      scope: "personal",
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      reason: `${KIND_LABEL} To open the pull request.`,
    },
  },
];
function SeedLabeled({ children }: { children?: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({ type: "asks_loaded", entries: LABELED, revision: 0 });
  }, [dispatch]);
  return <>{children}</>;
}
const mountLabeled = (isMobile: boolean) =>
  render(
    <StoreProvider>
      <SeedLabeled>
        <AsksStack agentId="c1" isMobile={isMobile} />
      </SeedLabeled>
    </StoreProvider>,
  );
// The label as drawn: its colour, its bold text, and whether any of the
// markup's own characters are left in the text.
const drawnLabel = (root: HTMLElement | null) => ({
  color: root?.querySelector<HTMLElement>("[data-color]")?.dataset.color,
  bold: root?.querySelector("[data-color] strong")?.textContent,
  raw: /:purple\[|\*\*/.test(root?.textContent ?? ""),
});
const LABEL_DRAWN = { color: "purple", bold: "Quick action", raw: false };

it("draws an ask's colour markup on a plain, a sudo and a secret card", async () => {
  const ids = LABELED.map((e) => e.id);
  const view = mountLabeled(false);
  await waitFor(() => expect(cards(view.container)).toEqual(ids));
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  // The sudo and secret cards are the kinds the test is about.
  expect(
    ids.map((id) => ({
      id,
      sudo: card(id).dataset.sudoRequest ?? null,
      secret: card(id).dataset.secretRequest ?? null,
      ...drawnLabel(card(id)),
    })),
  ).toEqual([
    { id: ids[0], sudo: null, secret: null, ...LABEL_DRAWN },
    { id: ids[1], sudo: "sudo-1", secret: null, ...LABEL_DRAWN },
    { id: ids[2], sudo: null, secret: "req-2", ...LABEL_DRAWN },
  ]);
  view.unmount();
});

it("draws the newest plain ask's colour markup on the collapsed bar", async () => {
  const view = mountLabeled(true);
  await waitFor(() =>
    expect(
      view.container.querySelector("[data-asks-stack=collapsed] button"),
    ).not.toBe(null),
  );
  const bar = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  expect(bar.textContent).toContain("Ship it?");
  expect(drawnLabel(bar)).toEqual(LABEL_DRAWN);
  view.unmount();
});

// The bar is a one-line view of the ask, as the excerpt of its Discuss in
// chat button is (task 198af893): the same text, with no markup left. The
// bar still draws colour, bold and code; block markup, images, links and
// HTML give their text or nothing.
const RICH_PROMPT =
  ":red[**Decide**] Since yesterday the *bar* shows `code` and [the doc](docs/x.md).\n\n![](before-after-x.png)\n\n- **Fix it**: do [this](https://x.com/a) ~~old~~\n1. one <b>html</b> <img src=x onerror=alert(1)>\n\n# Head\n\n> quoted [bad](javascript:alert%281%29)\n\n- [ ] todo\n\nEnd *x*\nnext";
const RICH_TEXT =
  "Decide Since yesterday the bar shows code and the doc. Fix it: do this old one html Head quoted bad todo End x next";
function SeedRich({ children }: { children?: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "asks_loaded",
      entries: [entry("cdef0201", "c2", RICH_PROMPT, 1)],
      revision: 0,
    });
  }, [dispatch]);
  return <>{children}</>;
}

it("draws the prompt's text on the collapsed bar, the text the excerpt quotes, with its colour, bold and code", async () => {
  const view = render(
    <StoreProvider>
      <SeedRich>
        <AsksStack agentId="c2" isMobile />
      </SeedRich>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector("[data-asks-stack=collapsed] button"),
    ).not.toBe(null),
  );
  const bar = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  // A soft line break stays in the text; nowrap draws it as a space.
  const text = (bar.textContent ?? "").replace(/\s+/g, " ").trim();
  const excerpt = askExcerpt(RICH_PROMPT);
  // The excerpt is the start of the bar's text, cut with an ellipsis.
  const head = excerpt.endsWith("…") ? excerpt.slice(0, -1) : "";
  expect({
    text: text.slice(-RICH_TEXT.length),
    head: RICH_TEXT.slice(0, Math.max(head.length, 1)),
    color: bar.querySelector<HTMLElement>("[data-color]")?.dataset.color,
    bold: bar.querySelector("[data-color] strong")?.textContent,
    code: bar.querySelector("code")?.textContent,
    elements:
      bar.querySelector("a,img,li,ul,ol,h1,blockquote,del,b,input,script")
        ?.tagName ?? null,
  }).toEqual({
    text: RICH_TEXT,
    head: head,
    color: "red",
    bold: "Decide",
    code: "code",
    elements: null,
  });
  view.unmount();
});

// A simplify request (task 30915188): the member asks the agent to rewrite
// the ask, which stays open. Since task 1466ea8b it is the Rewrite tag with a
// blank field, sent from the send button.
const inCard = (root: HTMLElement, id: string, selector: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${id}"] ${selector}`);

// While the agent rewrites the ask (task fc2021b7), nothing on the card can
// answer it: a banner with Undo stands in for the reply area.
const ANSWER_CONTROLS = [
  "form",
  "textarea",
  "[data-ask-reply-input]",
  "[data-ask-option]",
  "[data-ask-tag]",
  "[data-ask-suggestion]",
  "[data-ask-about]",
];
const answerControls = (root: HTMLElement, id: string) =>
  ANSWER_CONTROLS.filter((sel) => inCard(root, id, sel) !== null);
const tick = () => new Promise((r) => setTimeout(r, 0));

it("asks for a simpler ask with no text; the pushed mark puts the banner with Undo in place of the reply area; Undo posts the withdrawal once; the cleared mark brings the reply area back with the draft", async () => {
  const view = mount(false, "b1");
  await waitFor(() => expect(cards(view.container).length).toBe(3));
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-simplify-pending]"),
  ).toBe(null);
  // The tag replaces the untouched default, so the field is blank and the
  // request has no text.
  await act(async () => {
    fireEvent.click(
      inCard(view.container, "qqqq0017", '[data-ask-tag="rewrite"]')!,
    );
    await tick();
  });
  expect(posts).toEqual([]);
  await act(async () => {
    fireEvent.click(inCard(view.container, "qqqq0017", "[data-ask-send]")!);
    await tick();
  });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/qqqq0017/rewrite"]);
  expect("text" in posts[0].body).toBe(false);
  expect(cards(view.container)).toEqual(["ssss0019", "rrrr0018", "qqqq0017"]);

  // With options, so the banner is seen to take their place too.
  const base = {
    ...ENTRIES.find((e) => e.id === "qqqq0017")!,
    options: ["Now", "Later"],
  };
  act(() =>
    seeded({
      type: "ask_upserted",
      entry: { ...base, simplifyRequestedAt: NOW, updatedAt: NOW },
    }),
  );
  const banner = inCard(
    view.container,
    "qqqq0017",
    "[data-ask-simplify-pending]",
  )!;
  expect(banner).not.toBe(null);
  expect(answerControls(view.container, "qqqq0017")).toEqual([]);
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-prompt]")?.textContent,
  ).toContain("Merge t-1 after the CI on f00d?");
  const undo = banner.querySelector<HTMLButtonElement>(
    "[data-ask-simplify-undo]",
  )!;
  expect(undo.disabled).toBe(false);

  // Held open: in flight, the button is off and a second click sends nothing.
  let release = () => {};
  answer = () =>
    new Promise((resolve) => {
      release = () => resolve(undefined);
    });
  await act(async () => {
    fireEvent.click(undo);
    await tick();
  });
  expect(posts.map((p) => p.path)).toEqual([
    "/api/asks/qqqq0017/rewrite",
    "/api/asks/qqqq0017/simplify/undo",
  ]);
  expect("text" in posts[1].body).toBe(false);
  const inFlight = inCard(
    view.container,
    "qqqq0017",
    "[data-ask-simplify-undo]",
  ) as HTMLButtonElement;
  expect(inFlight.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(inFlight);
    await tick();
  });
  expect(posts).toHaveLength(2);
  await act(async () => {
    release();
    await tick();
  });
  // The server's push, not the answer, clears the mark.
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-simplify-pending]"),
  ).not.toBe(null);

  act(() =>
    seeded({
      type: "ask_upserted",
      entry: { ...base, updatedAt: NOW + 1 },
    }),
  );
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-simplify-pending]"),
  ).toBe(null);
  // The sent request started the field and its tag again: the untouched
  // default of an ask with options and no pick is empty.
  expect(field(view.container, "qqqq0017").value).toBe("");
  expect(inCard(view.container, "qqqq0017", "[data-ask-tag-chip]")).toBe(null);
  expect(
    view.container.querySelectorAll('[data-ask="qqqq0017"] [data-ask-option]'),
  ).toHaveLength(2);
  expect(
    inCard(
      view.container,
      "qqqq0017",
      '[data-ask-tag="rewrite"]',
    )?.hasAttribute("disabled"),
  ).toBe(false);
  view.unmount();
});

it("draws an ask still waiting for its rewrite with the banner in place of the reply area, the original prompt still on its toggle; a rewritten ask keeps its reply area; no Simplify on a secret request", async () => {
  const view = mount(false, "b1");
  await waitFor(() => expect(cards(view.container).length).toBe(3));
  const banner = inCard(
    view.container,
    "rrrr0018",
    "[data-ask-simplify-pending]",
  )!;
  expect(banner).not.toBe(null);
  expect(answerControls(view.container, "rrrr0018")).toEqual([]);
  expect(
    banner.querySelector<HTMLButtonElement>("[data-ask-simplify-undo]")
      ?.disabled,
  ).toBe(false);
  // The link row under the prompt keeps the toggle, apart from the banner.
  const toggle = inCard(
    view.container,
    "rrrr0018",
    "[data-ask-show-original]",
  )!;
  expect(banner.contains(toggle)).toBe(false);
  expect(toggle.parentElement?.contains(banner)).toBe(false);
  fireEvent.click(toggle);
  expect(
    inCard(view.container, "rrrr0018", "[data-ask-original]")?.textContent,
  ).toContain("Rotate k-7?");
  // The rewritten ask can be answered and simplified again.
  expect(
    inCard(view.container, "ssss0019", "[data-ask-simplify-pending]"),
  ).toBe(null);
  expect(field(view.container, "ssss0019")).not.toBe(null);
  expect(
    inCard(
      view.container,
      "ssss0019",
      '[data-ask-tag="rewrite"]',
    )?.hasAttribute("disabled"),
  ).toBe(false);
  view.unmount();

  const secrets = mount(false, "a5");
  await waitFor(() => expect(cards(secrets.container).length).toBe(3));
  expect(
    inCard(secrets.container, "gggg0007", '[data-ask-tag="rewrite"]'),
  ).not.toBe(null);
  expect(
    inCard(secrets.container, "hhhh0008", '[data-ask-tag="rewrite"]'),
  ).toBe(null);
  secrets.unmount();
});

it("keeps the banner and Undo live with the error when the server refuses the withdrawal, on a phone too", async () => {
  answer = async () => {
    throw new ApiError(409, "agent_stopped", "agent_stopped");
  };
  const view = mount(true, "b1");
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    )!,
  );
  const click = async () =>
    act(async () => {
      fireEvent.click(
        inCard(view.container, "rrrr0018", "[data-ask-simplify-undo]")!,
      );
      await tick();
    });
  await click();
  expect(posts.map((p) => p.path)).toEqual([
    "/api/asks/rrrr0018/simplify/undo",
  ]);
  expect(
    inCard(view.container, "rrrr0018", "[role=alert]")?.textContent,
  ).toContain("agent_stopped");
  expect(
    inCard(view.container, "rrrr0018", "[data-ask-simplify-pending]"),
  ).not.toBe(null);
  expect(answerControls(view.container, "rrrr0018")).toEqual([]);
  await click();
  expect(posts).toHaveLength(2);
  view.unmount();
});

it("shows the original prompt on a toggle and hides it again, and draws no toggle without one", async () => {
  const view = mount(false, "b1");
  await waitFor(() => expect(cards(view.container).length).toBe(3));
  expect(inCard(view.container, "qqqq0017", "[data-ask-show-original]")).toBe(
    null,
  );
  expect(inCard(view.container, "ssss0019", "[data-ask-original]")).toBe(null);
  const toggle = inCard(
    view.container,
    "ssss0019",
    "[data-ask-show-original]",
  )!;
  const closedLabel = toggle.textContent;
  fireEvent.click(toggle);
  const original = inCard(view.container, "ssss0019", "[data-ask-original]")!;
  // Drawn as the prompt is: markdown, not the raw backticks.
  expect(original.querySelector("code")?.textContent).toBe("t-1");
  expect(original.textContent).toContain("after the CI on f00d?");
  expect(original.textContent).not.toContain("`");
  expect(
    inCard(view.container, "ssss0019", "[data-ask-prompt]")?.textContent,
  ).toContain("Merge the fix now?");
  expect(
    inCard(view.container, "ssss0019", "[data-ask-show-original]")?.textContent,
  ).not.toBe(closedLabel);
  fireEvent.click(
    inCard(view.container, "ssss0019", "[data-ask-show-original]")!,
  );
  expect(inCard(view.container, "ssss0019", "[data-ask-original]")).toBe(null);
  view.unmount();
});

// A ```diff block in the prompt draws as diff rows, the -/+ marker kept as
// text, the changed words marked; the text around it stays markdown.
function expectDiff(
  scope: HTMLElement,
  rows: [string, string][],
  changed: string[],
) {
  const block = scope.querySelector<HTMLElement>("[data-ask-diff]")!;
  expect(block).not.toBe(null);
  // The dark-mode re-route of the chat diff card's colors applies to it.
  expect(block.classList.contains("d2h-isomux-host")).toBe(true);
  // The marker stays as text, not color alone; the space after it may be a
  // margin.
  const MARKER: Record<string, string> = { removed: "-", added: "+" };
  const drawn = [
    ...block.querySelectorAll<HTMLElement>("[data-diff-line]"),
  ].map((row) => {
    const kind = row.dataset.diffLine!;
    const text = row.textContent.trim();
    const marker = MARKER[kind];
    if (!marker) return [kind, text];
    expect(text.startsWith(marker)).toBe(true);
    return [kind, `${marker} ${text.slice(1).trim()}`];
  });
  expect(drawn).toStrictEqual(rows);
  expect(
    [...block.querySelectorAll<HTMLElement>('[data-diff-word="changed"]')].map(
      (w) => w.textContent,
    ),
  ).toStrictEqual(changed);
  expect(scope.textContent).not.toContain("```");
}

it("draws a diff block in the prompt and in the original as red and green rows", async () => {
  const view = mount(false, "b2");
  await waitFor(() => expect(cards(view.container)).toEqual(["tttt0020"]));
  const prompt = inCard(view.container, "tttt0020", "[data-ask-prompt]")!;
  expectDiff(
    prompt,
    [
      ["context", "Ask card > link:"],
      ["removed", "- Show original"],
      ["added", "+ Show the first version"],
    ],
    ["original", "the first version"],
  );
  // Text outside the block is still markdown.
  expect(prompt.querySelector("code")?.textContent).toBe("AskCard");
  expect(prompt.textContent).toContain("Ship it?");
  fireEvent.click(
    inCard(view.container, "tttt0020", "[data-ask-show-original]")!,
  );
  expectDiff(
    inCard(view.container, "tttt0020", "[data-ask-original]")!,
    [
      ["removed", "- Save now"],
      ["added", "+ Save later"],
    ],
    ["now", "later"],
  );
  view.unmount();
});

it("keeps the button live with the error when the server refuses a simplify, and draws it on a phone too", async () => {
  answer = async () => {
    throw new ApiError(409, "agent_stopped", "agent_stopped");
  };
  const view = mount(true, "b1");
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    )!,
  );
  await act(async () => {
    fireEvent.click(
      inCard(view.container, "qqqq0017", '[data-ask-tag="rewrite"]')!,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  const click = async () =>
    act(async () => {
      fireEvent.click(inCard(view.container, "qqqq0017", "[data-ask-send]")!);
      await new Promise((r) => setTimeout(r, 0));
    });
  await click();
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/qqqq0017/rewrite"]);
  expect(cards(view.container)).toEqual(["ssss0019", "rrrr0018", "qqqq0017"]);
  expect(
    inCard(view.container, "qqqq0017", "[role=alert]")?.textContent,
  ).toContain("agent_stopped");
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-simplify-pending]"),
  ).toBe(null);
  await click();
  expect(posts).toHaveLength(2);
  view.unmount();
});

// Task 589a8f4f: on a phone the chat gives the stack a cap from the visible
// height (vh does not shrink for the iOS keyboard).
const openBody = async (view: ReturnType<typeof render>, isMobile: boolean) => {
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  if (isMobile)
    fireEvent.click(
      view.container.querySelector<HTMLElement>(
        "[data-asks-stack=collapsed] button",
      )!,
    );
  return view.container.querySelector<HTMLElement>("[data-asks-body]")!;
};

it("caps the open stack at the height the chat gives it on a phone, and keeps its own cap without one and on a desktop", async () => {
  const phone = render(tree(true, "a1", null, 156));
  const body = await openBody(phone, true);
  expect(body.style.maxHeight).toBe("156px");
  phone.rerender(tree(true, "a1", null, 300));
  expect(body.style.maxHeight).toBe("300px");
  phone.unmount();

  // Without a cap from the chat, the phone falls back to a share of vh.
  const fallback = render(tree(true));
  expect((await openBody(fallback, true)).style.maxHeight).toMatch(/vh$/);
  fallback.unmount();

  const own = render(tree(false));
  const desktop = (await openBody(own, false)).style.maxHeight;
  own.unmount();
  const given = render(tree(false, "a1", null, 156));
  expect((await openBody(given, false)).style.maxHeight).toBe(desktop);
  given.unmount();
});

// happy-dom has no layout: the test owns the body's heights. The fade shows
// while content waits below the visible part of the body.
function bodyGeometry(body: HTMLElement) {
  const geometry = { clientHeight: 300, scrollHeight: 300 };
  for (const name of ["clientHeight", "scrollHeight"] as const)
    Object.defineProperty(body, name, {
      configurable: true,
      get: () => geometry[name],
    });
  return geometry;
}
const faded = (body: HTMLElement) =>
  /mask-image/.test(body.getAttribute("style") ?? "");

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  static resize(target: Element) {
    for (const observer of FakeResizeObserver.instances)
      if (!observer.disconnected && observer.targets.includes(target))
        observer.callback([{ target }]);
  }
  targets: Element[] = [];
  disconnected = false;
  constructor(readonly callback: (entries: { target: Element }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

it("fades the stack's bottom edge when the body shrinks under its cards, whatever shrank it", async () => {
  const globals = globalThis as Record<string, unknown>;
  const original = globals.ResizeObserver;
  FakeResizeObserver.instances = [];
  globals.ResizeObserver = FakeResizeObserver;
  try {
    const view = render(tree(true, "a1", null, 400));
    const body = await openBody(view, true);
    const geometry = bodyGeometry(body);
    // The cards fit: no fade.
    await act(async () => FakeResizeObserver.resize(body));
    expect(faded(body)).toBe(false);
    // The column overflows and the body gives way, with no change of cap.
    geometry.clientHeight = 150;
    await act(async () => FakeResizeObserver.resize(body));
    expect(faded(body)).toBe(true);
    geometry.clientHeight = 300;
    await act(async () => FakeResizeObserver.resize(body));
    expect(faded(body)).toBe(false);
    view.unmount();
  } finally {
    globals.ResizeObserver = original;
  }
});

// Newest first puts a new ask above the cards (task afed08d7). iOS Safari has
// no scroll anchoring, so the stack keeps a scrolled member's place itself;
// at the top the new ask is the one in view. A removal above the member is
// left to the browser.
it("keeps a scrolled member's place when a new ask arrives on top, and stays at the top otherwise", async () => {
  const view = render(tree(true));
  const body = await openBody(view, true);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  // A card is 100 px high; the body shows 120 px of them.
  for (const [name, get] of [
    ["scrollHeight", () => 100 * cards(body).length],
    ["clientHeight", () => 120],
  ] as const)
    Object.defineProperty(body, name, { configurable: true, get });
  const scrollTo = (top: number) => {
    body.scrollTop = top;
    fireEvent.scroll(body);
  };
  const arrive = (id: string, ageMin: number) =>
    act(() =>
      seeded({
        type: "ask_upserted",
        entry: entry(id, "a1", `New ${id}?`, ageMin),
      }),
    );

  scrollTo(50);
  arrive("wwww0101", 0);
  expect(cards(body)).toEqual(["wwww0101", "bbbb0002", "aaaa0001"]);
  expect(body.scrollTop).toBe(150);

  // The top card goes: the stack does not move the body.
  act(() => seeded({ type: "ask_removed", id: "wwww0101" }));
  expect(cards(body)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(body.scrollTop).toBe(150);

  // An older ask lands below the member: nothing above them moved.
  scrollTo(50);
  arrive("xxxx0102", 60);
  expect(cards(body)).toEqual(["bbbb0002", "xxxx0102", "aaaa0001"]);
  expect(body.scrollTop).toBe(50);

  scrollTo(0);
  arrive("yyyy0103", 0);
  expect(cards(body)[0]).toBe("yyyy0103");
  expect(body.scrollTop).toBe(0);
  view.unmount();
});

it("opens a fold that a new ask ended at the top, wherever the member had scrolled", async () => {
  // The body is a new element after the fold, so its height goes on the
  // prototype. A fold forgets the scroll it hid.
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-asks-body") ? 100 * cards(this).length : 0;
    },
  });
  try {
    const view = render(tree(false));
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const body = () =>
      view.container.querySelector<HTMLElement>("[data-asks-body]");
    body()!.scrollTop = 50;
    fireEvent.scroll(body()!);
    fireEvent.click(
      view.container.querySelector<HTMLElement>(
        "[data-asks-stack] button[aria-expanded]",
      )!,
    );
    expect(body()).toBe(null);
    act(() =>
      seeded({
        type: "ask_upserted",
        entry: entry("zzzz0104", "a1", "New zzzz0104?", 0),
      }),
    );
    await waitFor(() => expect(cards(view.container)[0]).toBe("zzzz0104"));
    expect(body()!.scrollTop).toBe(0);
    view.unmount();
  } finally {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
  }
});
