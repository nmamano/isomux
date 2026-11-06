// An ask with no agent on the member's card (task 74e8fc07, slice 2): a page
// the office raised about the member's own WhatsApp link. The card shows the
// office feature where an agent's name goes, and offers only Ack (while it
// rings) and Dismiss: nobody can read a reply. Through the real App and
// store. Markers: [data-ask-page], button[data-ask-ack],
// button[data-ask-dismiss]. In the list, the office page is a run of its own
// under its source's name ([data-asks-source]) among the agents' runs
// ([data-asks-group]), in the sort's order (task dcb409d4); the orders
// themselves are in ui/components/AsksView.test.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ask,
  boot,
  inboxButton,
  setAnswerPost,
  setAsks,
  setUpInboxTests,
  tabCount,
} = await import("./test-support/inbox-fixture.tsx");
const { setAsksSort } = await import("./device-settings.ts");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskMemberWire = import("../shared/types.ts").AskMemberWire;

setUpInboxTests();

const officeAsk = (id: string, t: number): AskMemberWire => ({
  ...ask(id, ""),
  prompt: "WhatsApp stopped\n\nThe bridge exited.",
  createdAt: t,
  updatedAt: t,
  members: ["member"],
  priority: "P1",
  office: { feature: "whatsapp", name: "WhatsApp" },
  page: { state: "ringing" },
});

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);

// The list's run headers and cards in page order: an agent's run as its id,
// a run with no agent as src:<name>.
const listOrder = (view: View) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      "[data-asks-list] [data-asks-group], [data-asks-list] [data-asks-source], [data-asks-list] [data-ask]",
    ),
  ].map((el) =>
    el.dataset.asksGroup !== undefined
      ? el.dataset.asksGroup
      : el.dataset.asksSource !== undefined
        ? `src:${el.dataset.asksSource}`
        : el.dataset.ask!,
  );

async function openInbox() {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  return view;
}

it("shows an office page with its feature's name, Ack and Dismiss, and nothing that answers an agent", async () => {
  setAsks([officeAsk("q1", 3_000)]);
  const view = await openInbox();
  const el = card(view, "q1");
  expect(el).not.toBeNull();
  expect(el!.textContent).toContain("WhatsApp");
  expect(el!.querySelector("button[data-ask-ack]")).not.toBeNull();
  expect(el!.querySelector("button[data-ask-dismiss]")).not.toBeNull();
  const answers = [
    "[data-ask-reply-input]",
    'button[type="submit"]',
    "[data-ask-options]",
    "[data-ask-file-task]",
    "[data-ask-simplify]",
    "[data-ask-about]",
  ].filter((sel) => el!.querySelector(sel) !== null);
  expect(answers).toEqual([]);
});

it("Dismiss closes an office page", async () => {
  setAsks([officeAsk("q1", 3_000)]);
  const posts: string[] = [];
  setAnswerPost(async (path) => {
    posts.push(path);
    return {};
  });
  const view = await openInbox();
  const dismiss =
    card(view, "q1")?.querySelector<HTMLButtonElement>(
      "button[data-ask-dismiss]",
    ) ?? null;
  expect(dismiss).not.toBeNull();
  await act(async () => fireEvent.click(dismiss!));
  // The Inbox holds an answer for its Undo time; leaving the Inbox sends it.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  await act(async () => {});
  expect(posts).toEqual(["/api/asks/q1/dismiss"]);
});

it("an agent's ask still shows Dismiss with its marker, and its reply field", async () => {
  setAsks([{ ...ask("q2", "a1"), members: ["member"] }]);
  const view = await openInbox();
  const el = card(view, "q2");
  expect(el).not.toBeNull();
  expect(el!.querySelector("button[data-ask-dismiss]")).not.toBeNull();
  expect(el!.querySelector('button[type="submit"]')).not.toBeNull();
});

it("the Asks tab counts an office page with the agents' asks", async () => {
  setAsks([
    officeAsk("q1", 3_000),
    { ...ask("q2", "a1"), members: ["member"] },
  ]);
  const view = await openInbox();
  expect(card(view, "q1")).not.toBeNull();
  expect(tabCount(view, "asks")).toBe("2");
});

// Nil at sign-off (task dcb409d4): pages sort by priority. Under the priority
// sort the office page (P1) renders below a P0 ask of an agent, in the one
// list: today it renders above every agent's run.
it("under the priority sort an office page renders below an agent's P0 ask", async () => {
  setAsksSort("priority");
  setAsks([
    officeAsk("q1", 3_000),
    { ...ask("q2", "a1"), members: ["member"], priority: "P0" },
  ]);
  const view = await openInbox();
  expect(listOrder(view)).toEqual(["a1", "q2", "src:WhatsApp", "q1"]);
});

// A held answer takes its card out of the list at once, and its run's name
// with it when no other card of that run shows (task 02274529): an office
// page's source name too, and the next name then has no space above it.
it("Dismiss on an office page takes its source name out of the list while the answer is held", async () => {
  setAsks([
    officeAsk("q1", 3_000),
    { ...ask("q2", "a1"), members: ["member"] },
  ]);
  const view = await openInbox();
  expect(listOrder(view)).toEqual(["src:WhatsApp", "q1", "a1", "q2"]);
  const nameOf = () =>
    view.container.querySelector<HTMLElement>(
      '[data-asks-list] [data-asks-group="a1"]',
    )!;
  expect(nameOf().style.margin.startsWith("0px ")).toBe(false);
  const dismiss =
    card(view, "q1")?.querySelector<HTMLButtonElement>(
      "button[data-ask-dismiss]",
    ) ?? null;
  expect(dismiss).not.toBeNull();
  await act(async () => fireEvent.click(dismiss!));
  // Held: the card is the Undo toast's, outside the list.
  expect(card(view, "q1")?.getAttribute("data-ask-pending")).toBe("dismiss");
  expect(listOrder(view)).toEqual(["a1", "q2"]);
  expect(nameOf().style.margin.startsWith("0px ")).toBe(true);
});
