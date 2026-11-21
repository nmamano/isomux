// The stack of open asks above the chat input
// (internal-docs/asks-design.md): one agent's entries for this member,
// newest first, open on a desktop and collapsed on a phone, and an answer that
// posts to the member route and closes the card only when the server took it;
// the card's links and its file, editor and command cards.
// ui/log-view/AsksStack.reply.dom.test.tsx holds the options and the reply
// field, ui/log-view/AsksStack.prompt.dom.test.tsx the prompt's markup, the
// simplify banner and the stack's height and scroll, and
// ui/test-support/asks-stack-fixture.tsx the office.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch, useAppState, FeaturesProvider } =
  await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { OfficeLinkOpener } = await import("../office-link.tsx");
const { sendFailureText, ENTERPRISE_HELP_EMAIL } =
  await import("../send-failure.ts");
const { expectValueAsData } = await import("../test-support/data-values.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { Seed, cards, entry, mount } =
  await import("../test-support/asks-stack-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
type OfficeLink = import("../../shared/office-links.ts").OfficeLink;

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

it("shows this agent's asks only, newest first, open on a desktop", async () => {
  const view = mount(false);
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]),
  );
  expect(
    view.container
      .querySelector("[data-asks-stack]")
      ?.getAttribute("data-asks-stack"),
  ).toBe("open");
  view.unmount();
});

it("names the app that opened an ask on that ask's card only", async () => {
  const view = mount(false, "a9");
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["pppp0016", "oooo0015"]),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  expect(card("oooo0015").textContent).toContain("triage-bot");
  expect(card("pppp0016").textContent).not.toContain("triage-bot");
  view.unmount();
});

it("starts collapsed on a phone, with the count and the newest prompt, and opens on a tap", async () => {
  const view = mount(true);
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  const bar = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  expect(cards(view.container)).toEqual([]);
  expect(bar.textContent).toContain("2");
  expect(bar.textContent).toContain("Second question?");
  expect(bar.textContent).not.toContain("First question?");
  fireEvent.click(bar);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  view.unmount();
});

it("replies with the field's text and closes the card once the server took it", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve(undefined)));
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="aaaa0001"]',
  )!;
  const field = card.querySelector<HTMLTextAreaElement>(
    "[data-ask-reply-input]",
  )!;
  // Prefilled, so one click answers.
  expect(field.value.length).toBeGreaterThan(0);
  const prefilled = field.value;
  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([
    { path: "/api/asks/aaaa0001/reply", body: { text: prefilled } },
  ]);
  // Still there while the request is open.
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(cards(view.container)).toEqual(["bbbb0002"]);
  view.unmount();
});

it("keeps the card with the reason when the server refuses a dismiss", async () => {
  answer = async () => {
    throw new ApiError(409, "agent_stopped", "agent_stopped");
  };
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="bbbb0002"]',
  )!;
  // A dismiss: the tag, then the send button that names it (task 1466ea8b).
  for (const selector of [
    '[data-ask-tag="dismiss"]',
    '[data-ask-send="dismiss"]',
  ])
    await act(async () => {
      fireEvent.click(card.querySelector<HTMLButtonElement>(selector)!);
      await new Promise((r) => setTimeout(r, 0));
    });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/bbbb0002/dismiss"]);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain(
    "agent_stopped",
  );
  view.unmount();
});

// Task f1304a60: a reply refused by the Enterprise Contract lock reads in
// the member's language, not as the server's English text.
it("keeps the card with the Enterprise Contract lock in the member's words", async () => {
  const serverText = "This office is marked as an Enterprise office.";
  const err = new ApiError(409, "enterprise_secret_needed", serverText);
  answer = async () => {
    throw err;
  };
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="aaaa0001"]',
  )!;
  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/aaaa0001/reply"]);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  const alert = card.querySelector("[role=alert]")?.textContent ?? "";
  expect(alert).toContain(sendFailureText(translatorFor("en").t, err));
  expect(alert).not.toContain(serverText);
  // The help email is a value in the alert (task 419dcb70).
  expectValueAsData(card.querySelector("[role=alert]")!, ENTERPRISE_HELP_EMAIL);
  view.unmount();
});

const linkButtons = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask-office-link]")].map((b) => [
    b.closest<HTMLElement>("[data-ask]")?.dataset.ask,
    b.dataset.askOfficeLink,
  ]);

it("draws a button for an office page it knows, and a click opens that page", async () => {
  const opened: OfficeLink[] = [];
  const view = mount(false, "a3", (link) => opened.push(link));
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  // The unknown page draws nothing.
  expect(linkButtons(view.container)).toEqual([
    ["dddd0004", "/integrations/mcp"],
  ]);
  const button = view.container.querySelector<HTMLButtonElement>(
    "[data-ask-office-link]",
  )!;
  // A button, not an anchor: there is no address to open in a new tab.
  expect(button.tagName).toBe("BUTTON");
  expect(view.container.querySelector("a[href]")).toBeNull();
  fireEvent.click(button);
  expect(opened).toEqual([{ page: "integrations", tab: "mcp" }]);
  // The ask stays open, and nothing was posted.
  expect(cards(view.container)).toEqual(["eeee0005", "dddd0004"]);
  expect(posts).toEqual([]);
  view.unmount();
});

it("draws a button for an agent it knows, named for the agent, and a click opens that agent", async () => {
  const opened: OfficeLink[] = [];
  const view = mount(false, "a7", (link) => opened.push(link));
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  // The agent the store does not have draws nothing.
  expect(linkButtons(view.container)).toEqual([["kkkk0011", "/agents/a1"]]);
  const button = view.container.querySelector<HTMLButtonElement>(
    "[data-ask-office-link]",
  )!;
  expect(button.tagName).toBe("BUTTON");
  expect(button.textContent).toContain("Scout");
  expect(button.textContent).not.toBe("Scout");
  fireEvent.click(button);
  expect(opened).toEqual([{ agentId: "a1" }]);
  expect(cards(view.container)).toEqual(["llll0012", "kkkk0011"]);
  expect(posts).toEqual([]);
  view.unmount();
});

// An outside page (task 0355f4b7): an anchor that opens a new tab with no
// opener, at the address whose site it names. It needs no office opener.
const outsideLinks = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask-outside-link]")].map(
    (a) => ({
      ask: a.closest<HTMLElement>("[data-ask]")?.dataset.ask,
      tag: a.tagName,
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      rel: (a.getAttribute("rel") ?? "").split(/\s+/).sort(),
      namesSite:
        (a.textContent ?? "").includes("github.com") &&
        !(a.textContent ?? "").toLowerCase().includes("www."),
    }),
  );

for (const [label, isMobile, opener] of [
  ["on a desktop, with an office opener", false, () => {}],
  ["on a phone, with no office opener", true, null],
] as const)
  it(`draws an outside page as a new-tab link that names its site, ${label}`, async () => {
    const view = mount(isMobile, "b5", opener);
    if (isMobile) {
      const bar = await waitFor(() => {
        const found = view.container.querySelector<HTMLElement>(
          "[data-asks-stack=collapsed] button",
        );
        expect(found).not.toBe(null);
        return found!;
      });
      fireEvent.click(bar);
    }
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    // The refused link draws nothing, and neither is an office button.
    expect(outsideLinks(view.container)).toEqual([
      {
        ask: "abcd0024",
        tag: "A",
        href: "https://www.github.com/settings/tokens/new?scopes=repo",
        target: "_blank",
        rel: ["noopener", "noreferrer"],
        namesSite: true,
      },
    ]);
    expect(linkButtons(view.container)).toEqual([]);
    expect(view.container.innerHTML).not.toContain("javascript:");
    view.unmount();
  });

// View in Inbox (tasks bc525a93, 586ebfe1): the open stack has one button,
// next to its toggle, that opens the Inbox filtered to this agent. No card
// has one.
const headerLinks = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>("[data-asks-view-inbox]"),
];
const cardLinks = (root: HTMLElement) =>
  root.querySelectorAll(
    "[data-ask] [data-asks-view-inbox], [data-ask-view-inbox]",
  ).length;

it("draws no link without an opener", async () => {
  const view = mount(false, "a3");
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(
    view.container
      .querySelector("[data-asks-stack]")
      ?.getAttribute("data-asks-stack"),
  ).toBe("open");
  expect(linkButtons(view.container)).toEqual([]);
  expect(headerLinks(view.container)).toHaveLength(0);
  view.unmount();
});

it("draws one View in Inbox beside the open stack's toggle; a click opens the Inbox filtered to the agent and keeps the stack open", async () => {
  const opened: OfficeLink[] = [];
  // a3's asks carry office links, so the cards have link rows of their own.
  const view = mount(false, "a3", (link) => opened.push(link));
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const c = view.container;
  expect(linkButtons(c).length).toBeGreaterThan(0);
  const links = headerLinks(c);
  expect(links).toHaveLength(1);
  expect(cardLinks(c)).toBe(0);
  const link = links[0];
  expect(link.tagName).toBe("BUTTON");
  expect(link.textContent?.trim()).not.toBe("");
  // A sibling of the toggle, not inside it and not inside the list.
  const toggle = c.querySelector<HTMLButtonElement>(
    "[data-asks-stack=open] button[aria-expanded]",
  )!;
  expect(toggle.contains(link)).toBe(false);
  expect(link.parentElement === toggle.parentElement).toBe(true);
  expect(link.closest("[data-asks-body]")).toBeNull();

  fireEvent.click(link);
  expect(opened).toEqual([{ page: "asks", onlyAgent: "a3" }]);
  expect(
    c.querySelector("[data-asks-stack]")?.getAttribute("data-asks-stack"),
  ).toBe("open");
  expect(cards(c)).toEqual(["eeee0005", "dddd0004"]);
  expect(posts).toEqual([]);

  // The toggle still folds the stack, and the folded bar has no link.
  fireEvent.click(toggle);
  expect(
    c.querySelector("[data-asks-stack]")?.getAttribute("data-asks-stack"),
  ).toBe("collapsed");
  expect(headerLinks(c)).toHaveLength(0);
  expect(opened).toHaveLength(1);
  view.unmount();
});

it("draws View in Inbox on a phone only once the stack is open", async () => {
  const opened: OfficeLink[] = [];
  const view = mount(true, "a1", (link) => opened.push(link));
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  expect(headerLinks(view.container)).toHaveLength(0);
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    )!,
  );
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(headerLinks(view.container)).toHaveLength(1);
  expect(cardLinks(view.container)).toBe(0);
  fireEvent.click(headerLinks(view.container)[0]);
  expect(opened).toEqual([{ page: "asks", onlyAgent: "a1" }]);
  view.unmount();
});

// The reply field of one card.
const field = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLTextAreaElement>(
    `[data-ask="${id}"] form [data-ask-reply-input]`,
  )!;
it("sends a typed note with a dismiss or a file-task, and nothing for a blank field or the untouched one, and closes the card", async () => {
  // A tag, then the send button that names it (task 1466ea8b).
  const clicks = {
    dismiss: ['[data-ask-tag="dismiss"]'],
    "file-task": ['[data-ask-tag="postpone"]', '[data-ask-suggestion="file"]'],
  };
  // Both verbs read one note rule, so the blank fields run on dismiss only.
  const cases = [
    ["dismiss", "  not this week ", { text: "  not this week " }],
    ["dismiss", "", {}],
    ["dismiss", "   ", {}],
    // The member typed the old default: the field goes as it is (task
    // 1466ea8b dropped the "changed from the prefill" rule).
    ["dismiss", "DEFAULT", { text: "DEFAULT" }],
    ["file-task", "  not this week ", { text: "  not this week " }],
    ["file-task", null, {}],
  ] as const;
  for (const [verb, typed, want] of cases) {
    posts = [];
    const view = mount(false);
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const input = field(view.container, "aaaa0001");
    const prefilled = input.value;
    const body =
      "text" in want && want.text === "DEFAULT" ? { text: prefilled } : want;
    for (const click of clicks[verb])
      await act(async () => {
        fireEvent.click(
          view.container.querySelector<HTMLButtonElement>(
            `[data-ask="aaaa0001"] ${click}`,
          )!,
        );
      });
    if (typed !== null) {
      fireEvent.change(input, { target: { value: "" } });
      if (typed !== "")
        fireEvent.change(input, {
          target: { value: typed === "DEFAULT" ? prefilled : typed },
        });
    }
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-ask="aaaa0001"] [data-ask-send]',
    )!;
    await act(async () => {
      fireEvent.click(button);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([verb, typed, posts]).toEqual([
      verb,
      typed,
      [{ path: `/api/asks/aaaa0001/${verb}`, body }],
    ]);
    expect([verb, cards(view.container)]).toEqual([verb, ["bbbb0002"]]);
    view.unmount();
  }
});

it("keeps the card with the error when the server refuses a file-task, and draws the button on a phone too", async () => {
  answer = async () => {
    throw new ApiError(409, "agent_stopped", "agent_stopped");
  };
  const view = mount(true);
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    )!,
  );
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="aaaa0001"]',
  )!;
  // Filing: the Postpone tag, its File as a task suggestion, then the send
  // button (task 1466ea8b).
  for (const selector of [
    '[data-ask-tag="postpone"]',
    '[data-ask-suggestion="file"]',
    '[data-ask-send="file"]',
  ])
    await act(async () => {
      fireEvent.click(card.querySelector<HTMLButtonElement>(selector)!);
      await new Promise((r) => setTimeout(r, 0));
    });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/aaaa0001/file-task"]);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain(
    "agent_stopped",
  );
  view.unmount();
});

// What the store holds for agent a6 after a click.
type Seen = { editor?: string; terminal?: string; panel?: string };
let seen: Seen = {};
function Probe() {
  const state = useAppState();
  useEffect(() => {
    seen = {
      editor: state.pendingEditorPaths.get("a6"),
      terminal: state.pendingTerminalCommands.get("a6"),
      panel: state.sidePanels.get("a6"),
    };
  });
  return null;
}
function mountAffordances(features = PRODUCTION_FEATURES) {
  seen = {};
  return render(
    <StoreProvider>
      <FeaturesProvider features={features}>
        <Seed>
          <AsksStack agentId="a6" isMobile={false} />
          <Probe />
        </Seed>
      </FeaturesProvider>
    </StoreProvider>,
  );
}
const ASK = '[data-ask="jjjj0010"]';
const pathOf = (url: string | null) =>
  new URL(url ?? "", "http://office.test").pathname;

it("draws an ask's files, then its editor card, then its command, as the chat draws them", async () => {
  const view = mountAffordances();
  await waitFor(() => expect(cards(view.container)).toEqual(["jjjj0010"]));
  const card = view.container.querySelector<HTMLElement>(ASK)!;
  const order = [
    ...card.querySelectorAll<HTMLElement>(
      // The download buttons (attachment-download.dom.test.tsx) are not parts.
      "img, video, a[href^='/api/']:not([download]), [data-ask-edit-file], [data-ask-command]",
    ),
  ].map((el) =>
    el.tagName === "IMG"
      ? `img ${el.getAttribute("src")}`
      : el.tagName === "VIDEO"
        ? `video ${pathOf(el.getAttribute("src"))}`
        : el.tagName === "A"
          ? `chip ${el.getAttribute("href")}`
          : el.dataset.askEditFile !== undefined
            ? `edit ${el.dataset.askEditFile}`
            : `command ${el.dataset.askCommand}`,
  );
  expect(order).toEqual([
    "img /api/files/a6/ab12.png",
    "video /api/asks/jjjj0010/files/ef56.mp4",
    "chip /api/asks/jjjj0010/files/ef56.mp4",
    "chip /api/files/a6/cd34.txt",
    "edit /w/notes.md",
    "command git branch -D t-a && git push origin --delete t-a",
  ]);
  // Each file downloads from where it is served. An image draws its
  // download once it has loaded.
  for (const img of card.querySelectorAll("img")) fireEvent.load(img);
  expect(
    [...card.querySelectorAll<HTMLAnchorElement>("a[download]")].map((a) => [
      a.getAttribute("download"),
      pathOf(a.getAttribute("href")),
    ]),
  ).toEqual([
    ["plot.png", "/api/files/a6/ab12.png"],
    ["clip.mp4", "/api/asks/jjjj0010/files/ef56.mp4"],
    ["log.txt", "/api/files/a6/cd34.txt"],
  ]);
  // Above the reply field.
  const form = card.querySelector("form")!;
  const cmd = card.querySelector("[data-ask-command]")!;
  expect(
    cmd.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  view.unmount();
});

it("a click on the editor card or the command card hands it to that agent's panel", async () => {
  const view = mountAffordances();
  await waitFor(() => expect(cards(view.container)).toEqual(["jjjj0010"]));
  const card = view.container.querySelector<HTMLElement>(ASK)!;
  await act(async () => {
    fireEvent.click(
      card.querySelector("[data-ask-edit-file] button[data-panel-action]")!,
    );
  });
  expect(seen).toEqual({
    editor: "/w/notes.md",
    terminal: undefined,
    panel: "editor",
  });
  await act(async () => {
    fireEvent.click(
      card.querySelector("[data-ask-command] button[data-panel-action]")!,
    );
  });
  expect(seen).toEqual({
    editor: "/w/notes.md",
    terminal: "git branch -D t-a && git push origin --delete t-a",
    panel: "terminal",
  });
  // A click answers nothing.
  expect(posts).toEqual([]);
  view.unmount();
});

it("shows the path and the command with no panel button when the office has no editor or terminal", async () => {
  const view = mountAffordances({
    ...PRODUCTION_FEATURES,
    editor: false,
    terminal: false,
  });
  await waitFor(() => expect(cards(view.container)).toEqual(["jjjj0010"]));
  const card = view.container.querySelector<HTMLElement>(ASK)!;
  expect(card.textContent).toContain("notes.md");
  expect(card.textContent).toContain(
    "git branch -D t-a && git push origin --delete t-a",
  );
  expect(card.querySelectorAll("[data-panel-action]").length).toBe(0);
  // The files still show: they need no panel.
  expect(
    card.querySelectorAll("img[src='/api/files/a6/ab12.png']").length,
  ).toBe(1);
  view.unmount();
});

// The open ask card renders the prompt with code too, and its links stay live.
it("renders an open card prompt with code and keeps its links live", async () => {
  const mine: AskEntry[] = [
    entry(
      "pppp0101",
      "a1",
      "Ship the **release**? Run `bun test` in [route](https://example.com).",
      1,
    ),
  ];
  function SeedMine({
    entries,
    children,
  }: {
    entries: AskEntry[];
    children?: React.ReactNode;
  }) {
    const dispatch = useDispatch();
    useEffect(() => {
      dispatch({ type: "asks_loaded", entries, revision: 0 });
    }, [dispatch, entries]);
    return <>{children}</>;
  }
  const view = render(
    <StoreProvider>
      <OfficeLinkOpener.Provider value={null}>
        <SeedMine entries={mine}>
          <AsksStack agentId="a1" isMobile={false} />
        </SeedMine>
      </OfficeLinkOpener.Provider>
    </StoreProvider>,
  );
  await waitFor(() => expect(cards(view.container)).toEqual(["pppp0101"]));
  const prompt = view.container.querySelector<HTMLElement>(
    '[data-ask="pppp0101"] [data-ask-prompt]',
  )!;
  expect(prompt.querySelector("code")?.textContent).toBe("bun test");
  expect(prompt.querySelector("strong")?.textContent).toBe("release");
  expect(prompt.querySelector("a")?.getAttribute("href")).toBe(
    "https://example.com",
  );
  expect(prompt.textContent).not.toContain("`");
  view.unmount();
});
