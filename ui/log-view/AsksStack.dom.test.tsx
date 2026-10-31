// The stack of open asks above the chat input
// (internal-docs/asks-design.md): one agent's entries for this member,
// oldest first, open on a desktop and collapsed on a phone, and an answer that
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
) {
  return (
    <StoreProvider>
      <OfficeLinkOpener.Provider value={opener}>
        <Seed>
          <AsksStack agentId={agentId} isMobile={isMobile} />
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

it("shows this agent's asks only, oldest first, open on a desktop", async () => {
  const view = mount(false);
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]),
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
    expect(cards(view.container)).toEqual(["oooo0015", "pppp0016"]),
  );
  const card = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
  expect(card("oooo0015").textContent).toContain("triage-bot");
  expect(card("pppp0016").textContent).not.toContain("triage-bot");
  view.unmount();
});

it("starts collapsed on a phone, with the count and the oldest prompt, and opens on a tap", async () => {
  const view = mount(true);
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  const bar = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  )!;
  expect(cards(view.container)).toEqual([]);
  expect(bar.textContent).toContain("2");
  expect(bar.textContent).toContain("First question?");
  expect(bar.textContent).not.toContain("Second question?");
  fireEvent.click(bar);
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
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
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
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
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
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
  expect(cards(view.container)).toEqual(["dddd0004", "eeee0005"]);
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
  expect(cards(view.container)).toEqual(["kkkk0011", "llll0012"]);
  expect(posts).toEqual([]);
  view.unmount();
});

it("draws no link without an opener", async () => {
  const view = mount(false, "a3");
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(linkButtons(view.container)).toEqual([]);
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

// The nearest translate attribute decides (HTML spec); none means translate.
const translated = (element: Element) =>
  element.closest("[translate]")?.getAttribute("translate") !== "no";

const recommendedMarks = (card: HTMLElement) =>
  [
    ...card.querySelectorAll<HTMLButtonElement>(
      "[data-ask-option-recommended]",
    ),
  ].map((b) => b.textContent);

it("starts the field with the recommended option, marks that option only, and one Reply sends it", async () => {
  const view = mount(false, "a8");
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["mmmm0013", "nnnn0014"]),
  );
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="mmmm0013"]',
  )!;
  const input = field(view.container, "mmmm0013");
  expect(input.value).toBe("No");
  // The mark is on the option's own button, with the catalog's label.
  expect(recommendedMarks(card).length).toBe(1);
  expect(recommendedMarks(card)[0]).toContain("No");
  const label = (en as Record<string, string>)["asks.recommended"];
  expect(typeof label).toBe("string");
  expect(card.textContent).toContain(label);
  // The other option is an ordinary button.
  expect(optionButtons(card).map((b) => b.textContent)).toContain("Yes");
  // What the agent wrote (the question and each option) stays out of page
  // translation; the mark, in the reader's language, does not. The reply
  // field holds "No" as its text too, so the option queries pass it over.
  const optionText = { ignore: "script, style, textarea" };
  expect(translated(getByText(card, "Keep the verifier rule?"))).toBe(false);
  expect(translated(getByText(card, "Yes", optionText))).toBe(false);
  expect(translated(getByText(card, "No", optionText))).toBe(false);
  expect(translated(getByText(card, label))).toBe(true);
  // Untouched, so focus selects it for typing over.
  act(() => input.focus());
  expect(selection(input)).toEqual([0, 2]);

  // A recommendation that is not one of the options marks nothing and fills
  // nothing.
  const stale = view.container.querySelector<HTMLElement>(
    '[data-ask="nnnn0014"]',
  )!;
  expect(recommendedMarks(stale)).toEqual([]);
  expect(field(view.container, "nnnn0014").value).toBe("");
  expect(stale.textContent).not.toContain(label);

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
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
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
  const first = field(view.container, "aaaa0001");
  const second = field(view.container, "bbbb0002");
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
  expect(focused()).toBe("bbbb0002/field");
  // The field it lands on is untouched, so the default is selected.
  expect(selection(second)).toEqual([0, second.value.length]);
  // The last field: the browser's own order goes on to the buttons.
  expect(press(second)).toBe(true);
  expect(focused()).toBe("bbbb0002/field");
  expect(press(second, { shiftKey: true })).toBe(false);
  expect(focused()).toBe("aaaa0001/field");
  expect(press(first, { shiftKey: true })).toBe(true);
  expect(focused()).toBe("aaaa0001/field");
  // A modifier or an open IME composition is not this move.
  for (const init of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ]) {
    expect([init, press(first, init)]).toEqual([init, true]);
    expect(focused()).toBe("aaaa0001/field");
  }
  view.unmount();
});

it("skips a secret request's fields when it moves with Tab", async () => {
  const view = mount(false, "a5");
  await waitFor(() =>
    expect(cards(view.container)).toEqual(["gggg0007", "hhhh0008", "iiii0009"]),
  );
  const first = field(view.container, "gggg0007");
  act(() => first.focus());
  act(() => {
    fireEvent.keyDown(first, { key: "Tab" });
  });
  expect(focused()).toBe("iiii0009/field");
  view.unmount();
});

it("sends a typed note with a dismiss or a file-task, and nothing for the default or a blank field, and closes the card", async () => {
  const buttons = {
    dismiss: '[data-ask="aaaa0001"] form button[type=button]',
    "file-task": '[data-ask="aaaa0001"] [data-ask-file-task]',
  };
  for (const [verb, selector] of Object.entries(buttons))
    for (const [typed, body] of [
      [null, {}],
      ["  not this week ", { text: "  not this week " }],
      ["", {}],
      ["   ", {}],
      // The member deleted the default and typed it again: no note.
      ["DEFAULT", {}],
    ] as const) {
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
  expect(cards(view.container)).toEqual(["aaaa0001", "bbbb0002"]);
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
