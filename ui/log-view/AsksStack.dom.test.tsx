// The stack of open asks above the chat input
// (internal-docs/asks-design.md): one agent's entries for this member,
// oldest first, open on a desktop and collapsed on a phone, and an answer that
// posts to the member route and closes the card only when the server took it.
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
const { OfficeLinkOpener } = await import("../office-link.tsx");
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
];

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

function Seed({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  useEffect(() => {
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
  const field = card.querySelector("input")!;
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
    "button[type=button]:last-of-type",
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

it("draws no link without an opener", async () => {
  const view = mount(false, "a3");
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(linkButtons(view.container)).toEqual([]);
  view.unmount();
});

const optionButtons = (card: HTMLElement) => [
  ...card.querySelectorAll<HTMLButtonElement>("[data-ask-option]"),
];

it("draws a button per option above the reply field, and a tap replies with that option", async () => {
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
  // The row sits before the form, and the field stays for another answer.
  const row = card.querySelector("[data-ask-options]")!;
  const form = card.querySelector("form")!;
  expect(
    row.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(form.querySelector("input")).not.toBe(null);
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Dwight" } },
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

it("sends one answer when two taps land before the card draws again", async () => {
  answer = () => new Promise(() => {});
  const view = mount(false, "a4");
  await waitFor(() => expect(cards(view.container)).toEqual(["ffff0006"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="ffff0006"]',
  )!;
  const [jim, dwight] = optionButtons(card);
  // One act: no render between the taps, so the buttons are still enabled.
  await act(async () => {
    fireEvent.click(jim);
    fireEvent.click(jim);
    fireEvent.click(dwight);
    fireEvent.submit(card.querySelector("form")!);
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim" } },
  ]);
  view.unmount();
});

it("draws no option row for an ask without options", async () => {
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  expect(view.container.querySelector("[data-ask-options]")).toBe(null);
  view.unmount();
});

it("leaves the options live after a refused tap, so the next tap posts again", async () => {
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
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
    await new Promise((r) => setTimeout(r, 0));
  });
  // Refused: the card stays with the reason, and its buttons are enabled.
  expect(cards(view.container)).toEqual(["ffff0006"]);
  expect(card.querySelector("[role=alert]")?.textContent).toContain("ask_busy");
  expect(optionButtons(card).map((b) => b.disabled)).toEqual([false, false]);
  refuse = false;
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim" } },
    { path: "/api/asks/ffff0006/reply", body: { text: "Dwight" } },
  ]);
  expect(cards(view.container)).toEqual([]);
  view.unmount();
});

// The reply field of one card.
const field = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLInputElement>(`[data-ask="${id}"] form input`)!;
const selection = (el: HTMLInputElement) => [
  el.selectionStart,
  el.selectionEnd,
];
// The focused element as "<card>/<tag>": a scalar, since a failed toBe on two
// DOM nodes serialises both.
const focused = () => {
  const el = document.activeElement;
  return `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.tagName}`;
};

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

it("selects the untouched default on focus and on click, and leaves the caret alone once edited", async () => {
  const view = mount(false);
  await waitFor(() => expect(cards(view.container).length).toBe(2));
  const input = field(view.container, "aaaa0001");
  const length = input.value.length;
  expect(length).toBeGreaterThan(0);
  input.setSelectionRange(length, length);
  act(() => input.focus());
  expect(selection(input)).toEqual([0, length]);
  // A browser's mouseup after the focus collapses the selection; the click
  // selects again.
  input.setSelectionRange(1, 1);
  fireEvent.click(input);
  expect(selection(input)).toEqual([0, length]);

  fireEvent.change(input, { target: { value: "done, mostly" } });
  act(() => input.blur());
  input.setSelectionRange(4, 4);
  act(() => input.focus());
  fireEvent.click(input);
  expect(selection(input)).toEqual([4, 4]);
  view.unmount();
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
  expect(focused()).toBe("bbbb0002/INPUT");
  // The field it lands on is untouched, so the default is selected.
  expect(selection(second)).toEqual([0, second.value.length]);
  // The last field: the browser's own order goes on to the buttons.
  expect(press(second)).toBe(true);
  expect(focused()).toBe("bbbb0002/INPUT");
  expect(press(second, { shiftKey: true })).toBe(false);
  expect(focused()).toBe("aaaa0001/INPUT");
  expect(press(first, { shiftKey: true })).toBe(true);
  expect(focused()).toBe("aaaa0001/INPUT");
  // A modifier or an open IME composition is not this move.
  for (const init of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ]) {
    expect([init, press(first, init)]).toEqual([init, true]);
    expect(focused()).toBe("aaaa0001/INPUT");
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
  expect(focused()).toBe("iiii0009/INPUT");
  view.unmount();
});

it("sends a typed reason with a dismiss, and nothing for the default or a blank field", async () => {
  for (const [typed, body] of [
    [null, {}],
    ["  not this week ", { text: "  not this week " }],
    ["", {}],
    ["   ", {}],
    // The member deleted the default and typed it again: no reason.
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
    const dismiss = view.container.querySelector<HTMLButtonElement>(
      '[data-ask="aaaa0001"] form button[type=button]',
    )!;
    await act(async () => {
      fireEvent.click(dismiss);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([typed, posts]).toEqual([
      typed,
      [{ path: "/api/asks/aaaa0001/dismiss", body }],
    ]);
    view.unmount();
  }
});
