// The stack of open asks above the chat input
// (internal-docs/asks-design.md): one agent's entries for this member,
// newest first, open on a desktop and collapsed on a phone, and an answer that
// posts to the member route and closes the card only when the server took it.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, getByText, waitFor } =
  await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch, useAppState, FeaturesProvider } =
  await import("../store.tsx");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { OfficeLinkOpener } = await import("../office-link.tsx");
const { en } = await import("../../shared/i18n/en.ts");
const { composerMaxHeight } = await import("../composer-height.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type OfficeLink = import("../../shared/office-links.ts").OfficeLink;

const NOW = Date.now();
const entry = (
  id: string,
  agentId: string,
  prompt: string,
  ageMin: number,
): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});
const ENTRIES: AskEntry[] = [
  entry("bbbb0002", "a1", "Second question?", 5),
  entry("aaaa0001", "a1", "First question?", 120),
  entry("cccc0003", "a2", "Another agent's question?", 1),
  // Agent a3's asks carry links: one this UI knows, one it does not.
  {
    ...entry("dddd0004", "a3", "Sign in to Linear?", 3),
    link: "/integrations/mcp",
  },
  { ...entry("eeee0005", "a3", "Open the old page?", 2), link: "/gone" },
  // Agent a4's ask has options.
  {
    ...entry("ffff0006", "a4", "Who gives the toast?", 4),
    options: ["Jim", "Dwight"],
  },
  // Agent a5 has a secret request between two reply asks.
  entry("gggg0007", "a5", "Ship it?", 30),
  {
    ...entry("hhhh0008", "a5", "To open the pull request.", 20),
    secret: {
      requestId: "req-1",
      scope: "personal",
      name: "GH_TOKEN",
      hosts: ["api.github.com"],
      form: { kind: "authorization" },
      reason: "To open the pull request.",
    },
  },
  entry("iiii0009", "a5", "Tag it?", 10),
  // Agent a6's ask carries chat affordances.
  {
    ...entry("jjjj0010", "a6", "Delete the merged branches?", 6),
    commands: ["git branch -D t-a && git push origin --delete t-a"],
    editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
    readFiles: [
      {
        filename: "ab12.png",
        originalName: "plot.png",
        mediaType: "image/png",
        size: 7,
      },
      // A video referenced where it is (task 37a660e8): served by the ask's
      // own file route, not the agent's files dir.
      {
        filename: "ef56.mp4",
        originalName: "clip.mp4",
        mediaType: "video/mp4",
        size: 9,
        path: "/w/clip.mp4",
      },
      {
        filename: "cd34.txt",
        originalName: "log.txt",
        mediaType: "text/plain",
        size: 3,
      },
    ],
  },
  // Agent a7's asks link to agents' chats: one this UI knows, one it does not.
  {
    ...entry("kkkk0011", "a7", "Say go in Scout's chat?", 8),
    link: "/agents/a1",
  },
  {
    ...entry("llll0012", "a7", "Say go in Ghost's chat?", 7),
    link: "/agents/ghost",
  },
  // Agent a8's asks recommend an option: the second one, and one that is not
  // among the options (the card ignores it).
  {
    ...entry("mmmm0013", "a8", "Keep the verifier rule?", 9),
    options: ["Yes", "No"],
    recommended: "No",
  },
  {
    ...entry("nnnn0014", "a8", "Keep the old rule?", 8),
    options: ["Yes", "No"],
    recommended: "Maybe",
  },
  // Agent a9's first ask is from an app behind it (task 1f453011).
  {
    ...entry("oooo0015", "a9", "Merge the queue?", 6),
    app: { name: "triage-bot", createdAt: NOW - 86_400_000 },
  },
  entry("pppp0016", "a9", "Its own question?", 5),
  // Agent b1's asks and a simplify request (task 30915188): none, one
  // waiting for the rewrite, and one rewritten.
  entry("qqqq0017", "b1", "Merge t-1 after the CI on f00d?", 9),
  // A second round: rewritten once, and asked again.
  {
    ...entry("rrrr0018", "b1", "Rotate the key?", 8),
    simplifyRequestedAt: NOW,
    originalPrompt: "Rotate k-7?",
  },
  {
    ...entry("ssss0019", "b1", "Merge the fix now?", 7),
    originalPrompt: "Merge `t-1` after the CI on f00d?",
  },
  // Agent b2's ask carries copy changes as ```diff blocks (task 8c661856),
  // in the prompt and in the original.
  {
    ...entry(
      "tttt0020",
      "b2",
      "Approve the copy in `AskCard`?\n```diff\nAsk card > link:\n- Show original\n+ Show the first version\n```\nShip it?",
      3,
    ),
    originalPrompt: "Old ask:\n```diff\n- Save now\n+ Save later\n```",
  },
  // Agent b3's ask is a step the member does, with one option (task d05f2968).
  {
    ...entry("uuuu0021", "b3", "Reload the extension?", 2),
    options: ["Done"],
  },
  // Agent b4's asks link to one ask in the Inbox: another ask, and the ask
  // itself.
  {
    ...entry("abcd0022", "b4", "See the other ask?", 2),
    link: "/inbox/asks/abcd0099",
  },
  {
    ...entry("abcd0023", "b4", "See this ask?", 1),
    link: "/inbox/asks/abcd0023",
  },
];
// The one agent the store knows: the target of a7's first link.
const SCOUT = { id: "a1", name: "Scout", roomId: "r2", desk: 0 } as never;

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

// The store's dispatch, for a change after the cards are drawn.
let seeded: ReturnType<typeof useDispatch> = () => {};
function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
    seeded = dispatch;
    dispatch({ type: "agent_added", agent: SCOUT });
    dispatch({ type: "asks_loaded", entries: ENTRIES, revision: 0 });
  }, [dispatch]);
  return <>{children}</>;
}

function tree(
  isMobile: boolean,
  agentId = "a1",
  opener: ((link: OfficeLink) => void) | null = null,
  maxHeight?: number,
) {
  return (
    <StoreProvider>
      <OfficeLinkOpener.Provider value={opener}>
        <Seed>
          <AsksStack
            agentId={agentId}
            isMobile={isMobile}
            maxHeight={maxHeight}
          />
        </Seed>
      </OfficeLinkOpener.Provider>
    </StoreProvider>
  );
}

function mount(
  isMobile: boolean,
  agentId = "a1",
  opener: ((link: OfficeLink) => void) | null = null,
) {
  return render(tree(isMobile, agentId, opener));
}

const cards = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask]")].map(
    (c) => c.dataset.ask,
  );

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
  const dismiss = card.querySelector<HTMLButtonElement>(
    "form button[type=button]",
  )!;
  await act(async () => {
    fireEvent.click(dismiss);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/bbbb0002/dismiss"]);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain(
    "agent_stopped",
  );
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

// View in Inbox (task bc525a93): the chat is not comfortable for a long ask,
// so each reply card in the stack opens its ask in the Inbox.
const viewInInbox = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask-view-inbox]")].map(
    (b) => b.closest<HTMLElement>("[data-ask]")?.dataset.ask,
  );

it("draws no link without an opener", async () => {
  const view = mount(false, "a3");
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(linkButtons(view.container)).toEqual([]);
  expect(viewInInbox(view.container)).toEqual([]);
  view.unmount();
});

it("draws View in Inbox on each reply card, and a click opens that ask in the Inbox", async () => {
  const opened: OfficeLink[] = [];
  // a1's asks have no office link and no original: the row has this button
  // only.
  const view = mount(false, "a1", (link) => opened.push(link));
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(viewInInbox(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  const button = view.container.querySelector<HTMLButtonElement>(
    '[data-ask="aaaa0001"] [data-ask-view-inbox]',
  )!;
  expect(button.tagName).toBe("BUTTON");
  expect(button.textContent?.trim()).not.toBe("");
  fireEvent.click(button);
  expect(opened).toEqual([{ page: "asks", askId: "aaaa0001" }]);
  // The ask stays open in the stack, and nothing was posted.
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(posts).toEqual([]);
  view.unmount();
});

it("puts View in Inbox before the ask's own link and Show original", async () => {
  const opener = () => {};
  const linked = mount(false, "a3", opener);
  await waitFor(() => expect(cards(linked.container).length).toBe(2));
  const card = linked.container.querySelector<HTMLElement>(
    '[data-ask="dddd0004"]',
  )!;
  const view = card.querySelector("[data-ask-view-inbox]");
  const office = card.querySelector("[data-ask-office-link]");
  expect([view !== null, office !== null]).toEqual([true, true]);
  // The same row (a scalar: toBe on two nodes dumps both on a failure).
  expect(view!.parentElement === office!.parentElement).toBe(true);
  expect(
    view!.compareDocumentPosition(office!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  linked.unmount();

  const rewritten = mount(false, "b1", opener);
  await waitFor(() => expect(cards(rewritten.container).length).toBe(3));
  const card2 = rewritten.container.querySelector<HTMLElement>(
    '[data-ask="ssss0019"]',
  )!;
  const view2 = card2.querySelector("[data-ask-view-inbox]");
  const original = card2.querySelector("[data-ask-show-original]");
  expect([view2 !== null, original !== null]).toEqual([true, true]);
  expect(view2!.parentElement === original!.parentElement).toBe(true);
  expect(
    view2!.compareDocumentPosition(original!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  rewritten.unmount();
});

it("draws no View in Inbox on a secret request", async () => {
  const view = mount(false, "a5", () => {});
  await waitFor(() => expect(cards(view.container).length).toBe(3));
  expect(viewInInbox(view.container)).toEqual(["iiii0009", "gggg0007"]);
  view.unmount();
});

it("draws no View in Inbox on an ask whose own link opens it in the Inbox", async () => {
  const view = mount(false, "b4", () => {});
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  // Both links are drawn; only the ask that links elsewhere has the button.
  expect(linkButtons(view.container)).toEqual([
    ["abcd0023", "/inbox/asks/abcd0023"],
    ["abcd0022", "/inbox/asks/abcd0099"],
  ]);
  expect(viewInInbox(view.container)).toEqual(["abcd0022"]);
  view.unmount();
});

const optionButtons = (card: HTMLElement) => [
  ...card.querySelectorAll<HTMLButtonElement>("[data-ask-option]"),
];
// The reply field of one card.
const field = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLTextAreaElement>(
    `[data-ask="${id}"] form [data-ask-reply-input]`,
  )!;
const selection = (el: HTMLTextAreaElement) => [
  el.selectionStart,
  el.selectionEnd,
];
// The focused element as "<card>/field" for a reply field, else "<card>/<tag>":
// a scalar, since a failed toBe on two DOM nodes serialises both.
const focused = () => {
  const el = document.activeElement;
  return `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.hasAttribute("data-ask-reply-input") ? "field" : el?.tagName}`;
};

it("draws a button per option above the reply field, and a tap fills the field for the member to edit and send", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve(undefined)));
  const view = mount(true, "a4");
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  fireEvent.click(
    view.container.querySelector<HTMLElement>(
      "[data-asks-stack=collapsed] button",
    )!,
  );
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="ffff0006"]',
  )!;
  expect(optionButtons(card).map((b) => b.textContent)).toEqual([
    "Jim",
    "Dwight",
  ]);
  // The row sits before the form.
  const row = card.querySelector("[data-ask-options]")!;
  const form = card.querySelector("form")!;
  expect(
    row.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const input = field(view.container, "ffff0006");
  expect(focused()).not.toBe("ffff0006/field");

  // A tap sends nothing: the field holds the option, focused, with the caret
  // at the end, so typing adds to it.
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
  });
  expect(posts).toEqual([]);
  expect(input.value).toBe("Dwight");
  expect(focused()).toBe("ffff0006/field");
  expect(selection(input)).toEqual([6, 6]);

  // A tap on the option the field already holds focuses it again.
  act(() => input.blur());
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
  });
  expect(focused()).toBe("ffff0006/field");
  expect(selection(input)).toEqual([6, 6]);

  // Another tap replaces what the member typed.
  fireEvent.change(input, { target: { value: "Dwight, with a speech" } });
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(input.value).toBe("Jim");
  expect(selection(input)).toEqual([3, 3]);
  expect(posts).toEqual([]);

  // The member edits it and sends the field's text.
  fireEvent.change(input, { target: { value: "Jim, briefly" } });
  await act(async () => {
    fireEvent.submit(form);
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim, briefly" } },
  ]);
  // Every option waits while the answer is in flight.
  expect(optionButtons(card).map((b) => b.disabled)).toEqual([true, true]);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(cards(view.container)).toEqual([]);
  view.unmount();
});

it("sends a one-option ask's option as the reply on a tap, and closes the card once the server took it", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve(undefined)));
  const view = mount(false, "b3");
  await waitFor(() => expect(cards(view.container)).toEqual(["uuuu0021"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="uuuu0021"]',
  )!;
  expect(optionButtons(card).map((b) => b.textContent)).toEqual(["Done"]);
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(posts).toEqual([
    { path: "/api/asks/uuuu0021/reply", body: { text: "Done" } },
  ]);
  // A second tap while the answer is in flight sends nothing more.
  expect(optionButtons(card)[0].disabled).toBe(true);
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(posts).toHaveLength(1);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(cards(view.container)).toEqual([]);
  view.unmount();
});

// The nearest translate attribute decides (HTML spec); none means translate.
const translated = (element: Element) =>
  element.closest("[translate]")?.getAttribute("translate") !== "no";

const recommendedMarks = (card: HTMLElement) =>
  [
    ...card.querySelectorAll<HTMLButtonElement>(
      "[data-ask-option-recommended]",
    ),
  ].map((b) => b.textContent);

// The recommended mark: a picture named by the catalog label, so a screen
// reader says it and the reader does not see the word.
const SVG_NS = "http://www.w3.org/2000/svg";
const namedMarks = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<Element>('[role="img"]')].filter(
    (el) => el.getAttribute("aria-label") === label,
  );

it("starts the field with the recommended option, marks that option only, and one Reply sends it", async () => {
  const view = mount(false, "a8");
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["nnnn0014", "mmmm0013"]),
  );
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="mmmm0013"]',
  )!;
  const input = field(view.container, "mmmm0013");
  expect(input.value).toBe("No");
  // The mark is on the option's own button: a picture named by the catalog's
  // label, not the word. An SVG, because iOS Safari draws a text glyph (a
  // star) through the emoji font and ignores the theme color.
  expect(recommendedMarks(card)).toEqual(["No"]);
  const label = (en as Record<string, string>)["asks.recommended"];
  expect(typeof label).toBe("string");
  const marks = namedMarks(card, label);
  expect(marks.length).toBe(1);
  expect(marks[0].namespaceURI).toBe(SVG_NS);
  expect(marks[0].textContent).toBe("");
  expect(
    marks[0]
      .closest("[data-ask-option]")
      ?.hasAttribute("data-ask-option-recommended"),
  ).toBe(true);
  expect(card.textContent).not.toContain(label);
  // The other option is an ordinary button.
  expect(optionButtons(card).map((b) => b.textContent)).toContain("Yes");
  // What the agent wrote (the question and each option) stays out of page
  // translation; the mark's name, in the reader's language, does not. The reply
  // field holds "No" as its text too, so the option queries pass it over.
  const optionText = { ignore: "script, style, textarea" };
  expect(translated(getByText(card, "Keep the verifier rule?"))).toBe(false);
  expect(translated(getByText(card, "Yes", optionText))).toBe(false);
  expect(translated(getByText(card, "No", optionText))).toBe(false);
  expect(translated(marks[0])).toBe(true);
  // Untouched, so focus selects it for typing over.
  act(() => input.focus());
  expect(selection(input)).toEqual([0, 2]);

  // A recommendation that is not one of the options marks nothing and fills
  // nothing.
  const stale = view.container.querySelector<HTMLElement>(
    '[data-ask="nnnn0014"]',
  )!;
  expect(recommendedMarks(stale)).toEqual([]);
  expect(namedMarks(stale, label)).toEqual([]);
  expect(field(view.container, "nnnn0014").value).toBe("");

  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([
    { path: "/api/asks/mmmm0013/reply", body: { text: "No" } },
  ]);
  view.unmount();
});

it("starts an ask with options and no recommendation empty, and Reply waits for an answer", async () => {
  const view = mount(false, "a4");
  await waitFor(() => expect(cards(view.container)).toEqual(["ffff0006"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="ffff0006"]',
  )!;
  expect(field(view.container, "ffff0006").value).toBe("");
  expect(recommendedMarks(card)).toEqual([]);
  const submit = card.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  expect(submit.disabled).toBe(true);
  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([]);
  // A dismiss of the untouched empty field sends no reason.
  await act(async () => {
    fireEvent.click(card.querySelector("form button[type=button]")!);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual([{ path: "/api/asks/ffff0006/dismiss", body: {} }]);
  view.unmount();
});

it("sends no dismiss reason for the recommended default, tapped or typed again, and sends another option or typed text", async () => {
  for (const [label, step, body] of [
    ["untouched", null, {}],
    ["tapped the recommendation", { tap: 1 }, {}],
    ["typed the recommendation again", { type: "No" }, {}],
    ["tapped the other option", { tap: 0 }, { text: "Yes" }],
    ["typed a reason", { type: "not now" }, { text: "not now" }],
  ] as const) {
    posts = [];
    const view = mount(false, "a8");
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const card = view.container.querySelector<HTMLElement>(
      '[data-ask="mmmm0013"]',
    )!;
    const input = field(view.container, "mmmm0013");
    if (step && "tap" in step)
      await act(async () => {
        fireEvent.click(optionButtons(card)[step.tap]);
      });
    if (step && "type" in step) {
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.change(input, { target: { value: step.type } });
    }
    await act(async () => {
      fireEvent.click(card.querySelector("form button[type=button]")!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([label, posts]).toEqual([
      label,
      [{ path: "/api/asks/mmmm0013/dismiss", body }],
    ]);
    view.unmount();
  }
});

it("follows an edit of the recommendation while the field is untouched, and keeps what the member typed", async () => {
  const view = mount(false, "a8");
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const { recommended: _mark, ...base } = ENTRIES.find(
    (e) => e.id === "mmmm0013",
  )!;
  act(() =>
    seeded({
      type: "ask_upserted",
      entry: { ...base, recommended: "Yes", updatedAt: NOW },
    }),
  );
  expect(field(view.container, "mmmm0013").value).toBe("Yes");
  fireEvent.change(field(view.container, "mmmm0013"), {
    target: { value: "Yes, but later" },
  });
  // The mark goes: the field keeps the member's text.
  act(() =>
    seeded({
      type: "ask_upserted",
      entry: { ...base, updatedAt: NOW + 1 },
    }),
  );
  expect(field(view.container, "mmmm0013").value).toBe("Yes, but later");
  view.unmount();
});

it("sends one answer when two submits land before the card draws again", async () => {
  answer = () => new Promise(() => {});
  const view = mount(false, "a4");
  await waitFor(() => expect(cards(view.container)).toEqual(["ffff0006"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="ffff0006"]',
  )!;
  fireEvent.change(field(view.container, "ffff0006"), {
    target: { value: "Jim" },
  });
  // One act: no render between the submits, so the form still reads idle.
  await act(async () => {
    fireEvent.submit(card.querySelector("form")!);
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim" } },
  ]);
  view.unmount();
});

it("keeps the field and leaves the card live after a refused reply, so the next reply posts again", async () => {
  let refuse = true;
  answer = async () => {
    if (refuse) throw new ApiError(409, "ask_busy", "ask_busy");
    return undefined;
  };
  const view = mount(false, "a4");
  await waitFor(() => expect(cards(view.container)).toEqual(["ffff0006"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="ffff0006"]',
  )!;
  const form = card.querySelector("form")!;
  const input = field(view.container, "ffff0006");
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  await act(async () => {
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 0));
  });
  // Refused: the card stays with the reason and the text, and is live.
  expect(cards(view.container)).toEqual(["ffff0006"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain("ask_busy");
  expect(input.value).toBe("Jim");
  expect(input.disabled).toBe(false);
  expect(optionButtons(card).map((b) => b.disabled)).toEqual([false, false]);
  expect(
    card.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
  ).toBe(false);
  refuse = false;
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
  });
  await act(async () => {
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim" } },
    { path: "/api/asks/ffff0006/reply", body: { text: "Dwight" } },
  ]);
  expect(cards(view.container)).toEqual([]);
  view.unmount();
});

it("keeps a typed reply, per ask, when the member leaves the chat and comes back", async () => {
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const prefilled = field(view.container, "bbbb0002").value;
  fireEvent.change(field(view.container, "aaaa0001"), {
    target: { value: "half a thought" },
  });
  // Another agent's chat: this agent's cards unmount.
  view.rerender(tree(false, "a2"));
  expect(cards(view.container)).toEqual(["cccc0003"]);
  view.rerender(tree(false, "a1"));
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(field(view.container, "aaaa0001").value).toBe("half a thought");
  expect(field(view.container, "bbbb0002").value).toBe(prefilled);
  view.unmount();
});

it("selects the untouched default on the tap that focuses it, and a tap on the focused field places the caret", async () => {
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const input = field(view.container, "aaaa0001");
  const length = input.value.length;
  expect(length).toBeGreaterThan(2);
  // A tap as a browser fires it: pointerdown, focus, then click after the
  // mouseup that puts the caret where the tap landed.
  const tap = (caret: number) => {
    fireEvent.pointerDown(input);
    act(() => input.focus());
    input.setSelectionRange(caret, caret);
    fireEvent.click(input);
  };
  expect(document.activeElement === input).toBe(false);
  tap(1);
  expect(selection(input)).toEqual([0, length]);
  // A second tap, on the focused field, keeps the caret it placed.
  expect(document.activeElement === input).toBe(true);
  tap(2);
  expect(selection(input)).toEqual([2, 2]);
  // After the member leaves the field, the tap that comes back selects again.
  act(() => input.blur());
  expect(document.activeElement === input).toBe(false);
  tap(1);
  expect(selection(input)).toEqual([0, length]);
  // Focus without a pointer (the keyboard) selects too.
  act(() => input.blur());
  input.setSelectionRange(length, length);
  act(() => input.focus());
  expect(selection(input)).toEqual([0, length]);

  // Once edited, focus and taps leave the caret alone.
  fireEvent.change(input, { target: { value: "done, mostly" } });
  act(() => input.blur());
  tap(4);
  expect(selection(input)).toEqual([4, 4]);
  view.unmount();
});

// The primary pointer for the cards mounted inside `run`: coarse is a touch
// screen.
async function withPointer(coarse: boolean, run: () => Promise<void>) {
  const original = window.matchMedia;
  window.matchMedia = (query: string) =>
    query === "(pointer: coarse)"
      ? ({ matches: coarse, media: query } as MediaQueryList)
      : original.call(window, query);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(coarse);
    await run();
  } finally {
    window.matchMedia = original;
  }
}
// fireEvent returns false when a handler prevented the default.
const pressEnter = async (
  el: HTMLElement,
  init: Record<string, unknown> = {},
) => {
  let free = true;
  await act(async () => {
    free = fireEvent.keyDown(el, { key: "Enter", ...init });
    await new Promise((r) => setTimeout(r, 0));
  });
  return free;
};

it("sends the reply on Enter with a mouse, and not on a modified Enter, an IME's Enter or a blank field", async () => {
  await withPointer(false, async () => {
    const view = mount(false);
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const input = field(view.container, "aaaa0001");
    fireEvent.change(input, { target: { value: "ship it" } });
    // Shift+Enter is a new line, and an IME takes its own Enter: the browser
    // keeps both.
    for (const init of [{ shiftKey: true }, { isComposing: true }])
      expect([init, await pressEnter(input, init)]).toEqual([init, true]);
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }])
      await pressEnter(input, init);
    expect(posts).toEqual([]);
    // A blank field sends nothing, and Enter adds no line to it.
    fireEvent.change(input, { target: { value: "  " } });
    expect(await pressEnter(input)).toBe(false);
    expect(posts).toEqual([]);

    fireEvent.change(input, { target: { value: "ship it" } });
    expect(await pressEnter(input)).toBe(false);
    expect(posts).toEqual([
      { path: "/api/asks/aaaa0001/reply", body: { text: "ship it" } },
    ]);
    view.unmount();
  });
});

it("keeps Enter as a new line on a touch screen, where Reply sends", async () => {
  await withPointer(true, async () => {
    // A desktop-wide viewport: the pointer decides, not the width.
    const view = mount(false);
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const card = view.container.querySelector<HTMLElement>(
      '[data-ask="aaaa0001"]',
    )!;
    const input = field(view.container, "aaaa0001");
    fireEvent.change(input, { target: { value: "ship it" } });
    expect(await pressEnter(input)).toBe(true);
    expect(posts).toEqual([]);
    await act(async () => {
      fireEvent.submit(card.querySelector("form")!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts).toEqual([
      { path: "/api/asks/aaaa0001/reply", body: { text: "ship it" } },
    ]);
    view.unmount();
  });
});

it("puts Reply, Dismiss and file-as-task in one row under the field on a phone, and in the form's row on a desktop", async () => {
  for (const isMobile of [true, false]) {
    const view = mount(isMobile);
    await waitFor(() =>
      expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
    );
    if (isMobile)
      fireEvent.click(
        view.container.querySelector<HTMLElement>(
          "[data-asks-stack=collapsed] button",
        )!,
      );
    const card = view.container.querySelector<HTMLElement>(
      '[data-ask="aaaa0001"]',
    )!;
    const form = card.querySelector("form")!;
    const input = field(view.container, "aaaa0001");
    const buttons = [
      card.querySelector<HTMLElement>("button[type=submit]")!,
      card.querySelector<HTMLElement>(
        "form button[type=button]:not([data-ask-file-task])",
      )!,
      card.querySelector<HTMLElement>("[data-ask-file-task]")!,
    ];
    const row = buttons[0].parentElement!;
    expect({
      isMobile,
      inForm: buttons.map((b) => form.contains(b)),
      afterField: buttons.map(
        (b) =>
          (input.compareDocumentPosition(b) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
      ),
      column: form.style.flexDirection === "column",
    }).toEqual({
      isMobile,
      inForm: [true, true, true],
      afterField: [true, true, true],
      column: isMobile,
    });
    // On a phone the buttons are one row of their own, the field above it.
    if (isMobile)
      expect({
        oneRow: buttons.map((b) => b.parentElement === row),
        rowHoldsField: row.contains(input),
        rowIsColumn: row.style.flexDirection === "column",
      }).toEqual({
        oneRow: [true, true, true],
        rowHoldsField: false,
        rowIsColumn: false,
      });
    view.unmount();
  }
});

it("grows the reply field with its text up to the composers' cap, from the first draw and after an option tap", async () => {
  const proto = window.HTMLTextAreaElement.prototype;
  let content = 30;
  // The field's text height, and a 1px border above and below.
  const metrics = {
    scrollHeight: () => content,
    offsetHeight: () => 42,
    clientHeight: () => 40,
  };
  for (const [name, get] of Object.entries(metrics))
    Object.defineProperty(proto, name, { get, configurable: true });
  try {
    for (const isMobile of [false, true]) {
      content = 30;
      const view = mount(isMobile, "a4");
      await waitFor(() =>
        expect(view.container.querySelector("[data-asks-stack]")).not.toBe(
          null,
        ),
      );
      if (isMobile)
        fireEvent.click(
          view.container.querySelector<HTMLElement>(
            "[data-asks-stack=collapsed] button",
          )!,
        );
      const input = field(view.container, "ffff0006");
      expect([isMobile, input.tagName]).toEqual([isMobile, "TEXTAREA"]);
      expect([isMobile, input.style.height]).toEqual([isMobile, "32px"]);
      content = 90;
      fireEvent.change(input, { target: { value: "a\nb\nc\nd" } });
      expect([isMobile, input.style.height]).toEqual([isMobile, "92px"]);
      content = 1000;
      fireEvent.change(input, { target: { value: "long ".repeat(400) } });
      expect([isMobile, input.style.height]).toEqual([
        isMobile,
        `${composerMaxHeight(isMobile)}px`,
      ]);
      // An option tap fills the field without a keystroke; it fits too.
      content = 50;
      act(() => {
        fireEvent.click(
          view.container.querySelector<HTMLElement>(
            '[data-ask="ffff0006"] [data-ask-option]',
          )!,
        );
      });
      expect([isMobile, input.value, input.style.height]).toEqual([
        isMobile,
        "Jim",
        "52px",
      ]);
      view.unmount();
    }
  } finally {
    for (const name of Object.keys(metrics))
      delete (proto as unknown as Record<string, unknown>)[name];
  }
});

it("moves between the reply fields with Tab and Shift+Tab, and lets the browser go on at either end", async () => {
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const first = field(view.container, "bbbb0002");
  const second = field(view.container, "aaaa0001");
  // fireEvent returns false when a handler prevented the default.
  const press = (el: HTMLElement, init: Record<string, unknown> = {}) => {
    let free = true;
    act(() => {
      free = fireEvent.keyDown(el, { key: "Tab", ...init });
    });
    return free;
  };
  act(() => first.focus());
  expect(press(first)).toBe(false);
  expect(focused()).toBe("aaaa0001/field");
  // The field it lands on is untouched, so the default is selected.
  expect(selection(second)).toEqual([0, second.value.length]);
  // The last field: the browser's own order goes on to the buttons.
  expect(press(second)).toBe(true);
  expect(focused()).toBe("aaaa0001/field");
  expect(press(second, { shiftKey: true })).toBe(false);
  expect(focused()).toBe("bbbb0002/field");
  expect(press(first, { shiftKey: true })).toBe(true);
  expect(focused()).toBe("bbbb0002/field");
  // A modifier or an open IME composition is not this move.
  for (const init of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ]) {
    expect([init, press(first, init)]).toEqual([init, true]);
    expect(focused()).toBe("bbbb0002/field");
  }
  view.unmount();
});

it("skips a secret request's fields when it moves with Tab", async () => {
  const view = mount(false, "a5");
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["iiii0009", "hhhh0008", "gggg0007"]),
  );
  const first = field(view.container, "iiii0009");
  act(() => first.focus());
  act(() => {
    fireEvent.keyDown(first, { key: "Tab" });
  });
  expect(focused()).toBe("gggg0007/field");
  view.unmount();
});

it("sends a typed note with a dismiss or a file-task, and nothing for the default or a blank field, and closes the card", async () => {
  const buttons = {
    dismiss: '[data-ask="aaaa0001"] form button[type=button]',
    "file-task": '[data-ask="aaaa0001"] [data-ask-file-task]',
  };
  // Both verbs read one note rule, so the blank fields run on dismiss only.
  // An untouched dismiss is in "sends no dismiss reason for the recommended
  // default".
  const cases = [
    ["dismiss", "  not this week ", { text: "  not this week " }],
    ["dismiss", "", {}],
    ["dismiss", "   ", {}],
    // The member deleted the default and typed it again: no note.
    ["dismiss", "DEFAULT", {}],
    ["file-task", "  not this week ", { text: "  not this week " }],
    ["file-task", null, {}],
  ] as const;
  for (const [verb, typed, body] of cases) {
    const selector = buttons[verb];
    posts = [];
    const view = mount(false);
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const input = field(view.container, "aaaa0001");
    const prefilled = input.value;
    if (typed !== null) {
      fireEvent.change(input, { target: { value: "" } });
      if (typed !== "")
        fireEvent.change(input, {
          target: { value: typed === "DEFAULT" ? prefilled : typed },
        });
    }
    const button = view.container.querySelector<HTMLButtonElement>(selector)!;
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
  await act(async () => {
    fireEvent.click(
      card.querySelector<HTMLButtonElement>("[data-ask-file-task]")!,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/aaaa0001/file-task"]);
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain(
    "agent_stopped",
  );
  view.unmount();
});

// Only the Inbox holds an answer on a one-line Undo line and scrolls it into
// view (ui/components/AsksView.dom.test.tsx): the chat's stack sends at once
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
    for (const selector of [
      "form button[type=submit]",
      "form button[type=button]",
      "[data-ask-file-task]",
    ]) {
      posts = [];
      const view = mount(false);
      await waitFor(() => expect(cards(view.container).length).toBe(2));
      await act(async () => {
        fireEvent.click(
          view.container.querySelector<HTMLButtonElement>(
            `[data-ask="aaaa0001"] ${selector}`,
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

// A simplify request (task 30915188): the member asks the agent to rewrite
// the ask, which stays open.
const inCard = (root: HTMLElement, id: string, selector: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${id}"] ${selector}`);

// While the agent rewrites the ask (task fc2021b7), nothing on the card can
// answer it: a banner with Undo stands in for the reply area.
const ANSWER_CONTROLS = [
  "form",
  "textarea",
  "[data-ask-reply-input]",
  "[data-ask-option]",
  "[data-ask-simplify]",
  "[data-ask-file-task]",
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
  // What the member typed is not a note: it stays in the field.
  fireEvent.change(field(view.container, "qqqq0017"), {
    target: { value: "too long" },
  });
  await act(async () => {
    fireEvent.click(inCard(view.container, "qqqq0017", "[data-ask-simplify]")!);
    await tick();
  });
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/qqqq0017/simplify"]);
  expect("text" in posts[0].body).toBe(false);
  expect(cards(view.container)).toEqual(["ssss0019", "rrrr0018", "qqqq0017"]);
  expect(field(view.container, "qqqq0017").value).toBe("too long");

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
    "/api/asks/qqqq0017/simplify",
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
  expect(field(view.container, "qqqq0017").value).toBe("too long");
  expect(
    view.container.querySelectorAll('[data-ask="qqqq0017"] [data-ask-option]'),
  ).toHaveLength(2);
  expect(
    inCard(view.container, "qqqq0017", "[data-ask-simplify]")?.hasAttribute(
      "disabled",
    ),
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
    inCard(view.container, "ssss0019", "[data-ask-simplify]")?.hasAttribute(
      "disabled",
    ),
  ).toBe(false);
  view.unmount();

  const secrets = mount(false, "a5");
  await waitFor(() => expect(cards(secrets.container).length).toBe(3));
  expect(inCard(secrets.container, "gggg0007", "[data-ask-simplify]")).not.toBe(
    null,
  );
  expect(inCard(secrets.container, "hhhh0008", "[data-ask-simplify]")).toBe(
    null,
  );
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
  const click = async () =>
    act(async () => {
      fireEvent.click(
        inCard(view.container, "qqqq0017", "[data-ask-simplify]")!,
      );
      await new Promise((r) => setTimeout(r, 0));
    });
  await click();
  expect(posts.map((p) => p.path)).toEqual(["/api/asks/qqqq0017/simplify"]);
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
      view.container.querySelector<HTMLElement>("[data-asks-stack] > button")!,
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
