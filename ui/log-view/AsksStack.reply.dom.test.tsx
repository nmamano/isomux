// The stack of open asks above the chat input (internal-docs/asks-design.md):
// an ask's options and its reply field. A tap on an option fills the field,
// the recommended option starts in it, Reply and Enter send one answer, the
// field grows with its text, and Tab moves between the fields. Split from
// ui/log-view/AsksStack.dom.test.tsx, which holds the cards, their answers and
// links, because the 5 s cap is per file;
// ui/log-view/AsksStack.prompt.dom.test.tsx holds the prompt's markup, the
// simplify banner and the stack's height and scroll.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, getByText, waitFor } =
  await import("@testing-library/react");
const { setApiShim, ApiError } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { en } = await import("../../shared/i18n/en.ts");
const { composerMaxHeight } = await import("../composer-height.ts");
const { ENTRIES, NOW, cards, mount, seeded, tree } =
  await import("../test-support/asks-stack-fixture.tsx");
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

// The options marked as the one a tap sends: the option the field holds.
const sendsMarks = (card: HTMLElement) =>
  optionButtons(card)
    .filter((b) => b.hasAttribute("data-ask-option-sends"))
    .map((b) => b.textContent);

it("draws a button per option above the reply field: a tap fills the field, and a tap on the option the field holds sends it", async () => {
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
  // No mark: the field starts empty, so no option sends yet.
  expect(input.value).toBe("");
  expect(sendsMarks(card)).toEqual([]);
  expect(focused()).not.toBe("ffff0006/field");

  // A tap sends nothing: the field holds the option, focused (a mouse), with
  // the caret at the end, and that option is now the one that sends.
  await act(async () => {
    fireEvent.click(optionButtons(card)[1]);
  });
  expect(posts).toEqual([]);
  expect(input.value).toBe("Dwight");
  expect(focused()).toBe("ffff0006/field");
  expect(selection(input)).toEqual([6, 6]);
  expect(sendsMarks(card)).toEqual(["Dwight"]);

  // A tap on another option replaces the field, and the mark moves with it.
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(posts).toEqual([]);
  expect(input.value).toBe("Jim");
  expect(sendsMarks(card)).toEqual(["Jim"]);

  // An edit that no longer matches takes the mark away, and a tap fills again.
  fireEvent.change(input, { target: { value: "Jim, briefly" } });
  expect(sendsMarks(card)).toEqual([]);
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(posts).toEqual([]);
  expect(input.value).toBe("Jim");

  // Space around the text still matches; the tap sends the option as the
  // agent wrote it.
  fireEvent.change(input, { target: { value: "  Jim\n" } });
  expect(sendsMarks(card)).toEqual(["Jim"]);
  await act(async () => {
    fireEvent.click(optionButtons(card)[0]);
  });
  expect(posts).toEqual([
    { path: "/api/asks/ffff0006/reply", body: { text: "Jim" } },
  ]);
  // Every option waits while the answer is in flight; another tap sends
  // nothing more.
  expect(optionButtons(card).map((b) => b.disabled)).toEqual([true, true]);
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

it("sends a one-option ask's option as the reply on a tap, and closes the card once the server took it", async () => {
  let release: () => void = () => {};
  answer = () => new Promise((resolve) => (release = () => resolve(undefined)));
  const view = mount(false, "b3");
  await waitFor(() => expect(cards(view.container)).toEqual(["uuuu0021"]));
  const card = view.container.querySelector<HTMLElement>(
    '[data-ask="uuuu0021"]',
  )!;
  expect(optionButtons(card).map((b) => b.textContent)).toEqual(["Done"]);
  // With no mark, the field starts with the only option, so it sends.
  expect(field(view.container, "uuuu0021").value).toBe("Done");
  expect(sendsMarks(card)).toEqual(["Done"]);
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
  // A dismiss of the untouched empty field sends no reason: the tag, then
  // the send button that names it (task 1466ea8b).
  for (const selector of [
    '[data-ask-tag="dismiss"]',
    '[data-ask-send="dismiss"]',
  ])
    await act(async () => {
      fireEvent.click(card.querySelector<HTMLButtonElement>(selector)!);
      await new Promise((r) => setTimeout(r, 0));
    });
  expect(posts).toEqual([{ path: "/api/asks/ffff0006/dismiss", body: {} }]);
  view.unmount();
});

// Task 1466ea8b: the Dismiss tag replaces the untouched default, so the
// recommendation the card starts with goes as no reason; once the member
// filled or typed the field, it goes as it is, the recommendation too.
it("sends no dismiss reason for the untouched recommended default, and the field as it is once the member filled or typed it", async () => {
  // A tap on the option the field holds sends it, so the recommendation
  // comes back into the field by a tap after another option.
  for (const [label, step, body] of [
    ["untouched", null, {}],
    ["filled the recommendation again", { taps: [0, 1] }, { text: "No" }],
    ["typed the recommendation again", { type: "No" }, { text: "No" }],
    ["tapped the other option", { taps: [0] }, { text: "Yes" }],
    ["typed a reason", { type: "not now" }, { text: "not now" }],
  ] as const) {
    posts = [];
    const view = mount(false, "a8");
    await waitFor(() => expect(cards(view.container).length).toBe(2));
    const card = view.container.querySelector<HTMLElement>(
      '[data-ask="mmmm0013"]',
    )!;
    const input = field(view.container, "mmmm0013");
    if (step && "taps" in step)
      for (const tap of step.taps)
        await act(async () => {
          fireEvent.click(optionButtons(card)[tap]);
        });
    // Every tap filled: nothing was sent before the dismiss.
    expect([label, posts]).toEqual([label, []]);
    if (step && "type" in step) {
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.change(input, { target: { value: step.type } });
    }
    for (const selector of [
      '[data-ask-tag="dismiss"]',
      '[data-ask-send="dismiss"]',
    ])
      await act(async () => {
        fireEvent.click(card.querySelector<HTMLButtonElement>(selector)!);
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

// Since task 1466ea8b the row holds the send button and Discuss in chat; the
// other answers are tags above the field.
it("puts the send button and Discuss in chat in one row under the field, on a phone and on a desktop", async () => {
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
      card.querySelector<HTMLElement>("[data-ask-about]")!,
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
      oneRow: buttons.map((b) => b.parentElement === row),
      rowHoldsField: row.contains(input),
      rowIsColumn: row.style.flexDirection === "column",
    }).toEqual({
      isMobile,
      inForm: [true, true],
      afterField: [true, true],
      // The field takes the form's width, the buttons a row of their own.
      column: true,
      oneRow: [true, true],
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
