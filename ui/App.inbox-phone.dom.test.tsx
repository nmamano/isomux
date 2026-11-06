// The open ask count on a phone (task 760818d5), through the real App and
// store. A phone shows no title tooltip, so the Inbox row of the overflow
// menu shows the open asks as a neutral count beside the red badge of the
// new ones, and stays counted after the Asks view showed them. The Inbox
// header shows every open ask. The row itself is in
// ui/components/NavActions.dom.test.tsx; the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, within } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const {
  addRanger,
  ask,
  askCards,
  boot,
  chatFromInbox,
  inboxOpen,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// Boots at a phone's width and runs `body`, then restores the window.
async function onPhone(body: (view: View) => Promise<void>) {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  let view: View | undefined;
  try {
    view = await boot();
    // The store reads the width again on a resize, after its 150 ms debounce.
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await body(view);
  } finally {
    view?.unmount();
    if (width) Object.defineProperty(window, "innerWidth", width);
    window.dispatchEvent(new Event("resize"));
  }
}

// Opens the overflow menu: its Inbox row, and the row's two numbers.
async function inboxRow(view: View) {
  const triggers = view.getAllByText("⋯");
  expect(triggers.length).toBe(1);
  await act(async () => fireEvent.click(triggers[0]));
  const row = within(document.body)
    .getByText(en["nav.inbox"])
    .closest("button")!;
  return {
    row,
    counts: {
      open: row.querySelector(".nav-action-count")?.textContent ?? null,
      new: row.querySelector(".nav-action-badge")?.textContent ?? null,
    },
  };
}

// The open ask count in the Inbox header; null when it shows none.
function headerCount(view: View): number | null {
  const el = view.container.querySelector(
    "[data-inbox] [data-inbox-ask-count]",
  );
  if (!el) return null;
  const m = /\d+/.exec(el.textContent ?? "");
  expect(m).not.toBeNull();
  return Number(m![0]);
}

function card(view: View, id: string) {
  return view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
}

it("keeps the open ask count on the phone menu's Inbox row after the Asks view showed them, and the header drops an answered ask", async () => {
  await onPhone(async (view) => {
    // Scout's two asks; the hidden-room ask counts nowhere.
    const first = await inboxRow(view);
    expect(first.counts).toEqual({ open: "2", new: "2" });

    await act(async () => fireEvent.click(first.row));
    expect(inboxOpen(view)).toBe(true);
    expect(askCards(view)).toBe(2);
    expect(headerCount(view)).toBe(2);

    // Answered on the Inbox: out of the count at once.
    await act(async () =>
      fireEvent.click(
        card(view, "q1")!.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )!,
      ),
    );
    expect(headerCount(view)).toBe(1);

    await act(async () =>
      fireEvent.click(view.getByRole("button", { name: "←" })),
    );
    expect(inboxOpen(view)).toBe(false);
    // Shown on the Asks view: nothing new, and one ask still waits.
    expect((await inboxRow(view)).counts).toEqual({ open: "1", new: null });
  });
});

it("counts on a phone chat's Inbox row the asks of the other agents only, while the header counts every open ask", async () => {
  addRanger();
  setAsks([ask("q1", "a1"), ask("q2", "a1"), ask("q4", "a2")]);
  await onPhone(async (view) => {
    const fromOffice = await inboxRow(view);
    await act(async () => fireEvent.click(fromOffice.row));
    expect(headerCount(view)).toBe(3);
    await chatFromInbox(view, "a1");
    expect(document.title).toContain("Scout");

    // Scout's asks show in its chat; Ranger's one waits elsewhere.
    const inChat = await inboxRow(view);
    expect(inChat.counts).toEqual({ open: "1", new: null });
    await act(async () => fireEvent.click(inChat.row));
    expect(inboxOpen(view)).toBe(true);
    expect(headerCount(view)).toBe(3);
  });
});
