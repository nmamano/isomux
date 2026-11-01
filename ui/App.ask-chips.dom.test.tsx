// Ask ids in text (task 84aadfab), through the real App and store: an id in
// an Inbox prompt that names an ask is a chip, read from the store first and
// else once from GET /api/asks/<id>; the chip and the /inbox/asks/<id> address
// pin that ask above the Asks list. How Markdown and the chat's user bubbles
// chip an id is in ui/log-view/Markdown.ask-links.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { ApiError } = await import("./api.ts");
const {
  ask,
  askReads,
  boot,
  officeLink,
  selectedTab,
  setAskRead,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskEntry = import("../shared/types.ts").AskEntry;

setUpInboxTests();

// An open ask of this member's, and one whose prompt names it.
const target: AskEntry = {
  ...ask("a6b624d3", "a1"),
  prompt: "Deploy the new build now?",
};
const pointer = (ids: string): AskEntry => ({
  ...ask("b7c8d9e0", "a1"),
  prompt: `Answer ${ids} first?`,
});

// A closed ask as GET /api/asks/<id> sends it (AskClosedWire).
const closedAsk = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agentId: "a1",
  memberUserId: "u1",
  member: "member",
  prompt: "Ship the release today?",
  options: ["Yes", "Later"],
  recommended: "Yes",
  createdAt: 1_000,
  updatedAt: 1_000,
  closed: {
    at: 2_000,
    outcome: "replied",
    by: "member",
    answer: "Yes, after the tests",
  },
  events: [],
  ...extra,
});

const notFound = () => new ApiError(404, "not_found", "No such ask.");

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => {});
}

const chipIn = (view: View, askId: string, id: string) =>
  view.container.querySelector<HTMLButtonElement>(
    `[data-ask="${askId}"] button.task-id-chip[data-ask-chip="${id}"]`,
  );
const pinned = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-asks-pinned]");
const cardsOf = (view: View, id: string) =>
  view.container.querySelectorAll(`[data-ask="${id}"]`).length;

it("chips an ask of the store's without a read, and pins that one card above the list until closed", async () => {
  setAsks([target, pointer(target.id)]);
  const view = await boot("/inbox/asks");
  await settle();
  const chip = chipIn(view, "b7c8d9e0", target.id);
  expect(chip).not.toBeNull();
  // An ask chip, not a task chip: the id alone as text, the prompt's start
  // as the suffix, no task id for the task handler.
  expect(chip!.textContent).toBe(target.id);
  expect(chip!.hasAttribute("data-task-id")).toBe(false);
  expect(chip!.getAttribute("title")).toBe(target.prompt);
  expect(chip!.getAttribute("data-task-label")).toContain("Deploy the new");
  expect(askReads).toEqual([]);

  await act(async () => fireEvent.click(chip!));
  expect(pinned(view)?.getAttribute("data-asks-pinned")).toBe(target.id);
  expect(
    pinned(view)?.querySelector(`[data-ask="${target.id}"]`),
  ).not.toBeNull();
  // One card for the ask: the pinned one, not a second in the list.
  expect(cardsOf(view, target.id)).toBe(1);
  expect(
    view.container.querySelector(`[data-asks-list] [data-ask="${target.id}"]`),
  ).toBeNull();
  expect(
    view.container.querySelector('[data-asks-list] [data-ask="b7c8d9e0"]'),
  ).not.toBeNull();

  const close = pinned(view)?.querySelector<HTMLButtonElement>(
    "[data-asks-pinned-close]",
  );
  expect(close).not.toBeNull();
  await act(async () => fireEvent.click(close!));
  expect(pinned(view)).toBeNull();
  expect(cardsOf(view, target.id)).toBe(1);
  expect(
    view.container.querySelector(`[data-asks-list] [data-ask="${target.id}"]`),
  ).not.toBeNull();
});

it("reads an id the store lacks once, and a closed ask opens read-only with its answer", async () => {
  setAskRead(async (id) => closedAsk(id));
  setAsks([pointer("c0ffee12 or c0ffee12")]);
  const view = await boot("/inbox/asks");
  await settle();
  expect(askReads).toEqual(["c0ffee12"]);
  const chips = view.container.querySelectorAll<HTMLButtonElement>(
    '[data-ask="b7c8d9e0"] button[data-ask-chip="c0ffee12"]',
  );
  expect(chips.length).toBe(2);

  await act(async () => fireEvent.click(chips[0]));
  await settle();
  const card = pinned(view)?.querySelector<HTMLElement>(
    '[data-ask-readonly="c0ffee12"]',
  );
  expect(card).not.toBeNull();
  expect(card!.textContent).toContain("Ship the release today?");
  expect(card!.textContent).toContain("Scout");
  expect(card!.textContent).toContain("Yes, after the tests");
  expect(
    card!.querySelector("[data-ask-outcome]")?.getAttribute("data-ask-outcome"),
  ).toBe("replied");
  // Read-only: no answer field, no card that can send one.
  expect(card!.querySelector("textarea")).toBeNull();
  expect(cardsOf(view, "c0ffee12")).toBe(0);
});

it("leaves an id the server refuses as plain text", async () => {
  setAsks([pointer("dead1234")]);
  const view = await boot("/inbox/asks");
  await settle();
  expect(askReads).toEqual(["dead1234"]);
  const card = view.container.querySelector('[data-ask="b7c8d9e0"]');
  expect(card?.querySelector("[data-ask-chip]")).toBeNull();
  expect(card?.querySelector("button.task-id-chip")).toBeNull();
  expect(card?.textContent).toContain("Answer dead1234 first?");
});

// C8: a read that found nothing does not hide an ask that opens later.
it("chips an id the server refused once the ask reaches the store", async () => {
  setAsks([pointer("feed1234")]);
  const view = await boot("/inbox/asks");
  await settle();
  expect(askReads).toEqual(["feed1234"]);
  expect(chipIn(view, "b7c8d9e0", "feed1234")).toBeNull();
  await act(async () =>
    shimEmit({
      type: "ask_upserted",
      entry: { ...ask("feed1234", "a1"), prompt: "Rotate the key?" },
    } as never),
  );
  await settle();
  expect(chipIn(view, "b7c8d9e0", "feed1234")).not.toBeNull();
  expect(askReads).toEqual(["feed1234"]);
});

it("reads at most four ids at once, each once, and starts the next as one settles", async () => {
  const ids = [
    "1111aaaa",
    "2222aaaa",
    "3333aaaa",
    "4444aaaa",
    "5555aaaa",
    "6666aaaa",
  ];
  const waiting: Array<{ id: string; fail: () => void }> = [];
  setAskRead(
    (id) =>
      new Promise((_, reject) =>
        waiting.push({ id, fail: () => reject(notFound()) }),
      ),
  );
  setAsks([pointer(`${ids.join(" ")} ${ids[0]}`)]);
  await boot("/inbox/asks");
  await settle();
  expect(askReads.length).toBe(4);
  expect(new Set(askReads).size).toBe(4);
  await act(async () => waiting[0].fail());
  await settle();
  expect(askReads.length).toBe(5);
  for (const w of waiting.slice(1)) await act(async () => w.fail());
  await settle();
  expect([...askReads].sort()).toEqual([...ids].sort());
});

it("opens /inbox/asks/<id> on the Asks tab with the closed ask pinned, and shows /inbox/asks", async () => {
  setAskRead(async (id) => closedAsk(id));
  const view = await boot("/inbox/asks/c0ffee12");
  await settle();
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  expect(
    pinned(view)?.querySelector('[data-ask-readonly="c0ffee12"]'),
  ).not.toBeNull();
});

it("opens /inbox/asks/<id> of an open ask of the member's as its one card, pinned", async () => {
  setAsks([target, pointer("nothing")]);
  const view = await boot(`/inbox/asks/${target.id}`);
  await settle();
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(
    pinned(view)?.querySelector(`[data-ask="${target.id}"]`),
  ).not.toBeNull();
  expect(cardsOf(view, target.id)).toBe(1);
  expect(pinned(view)?.querySelector("[data-ask-readonly]")).toBeNull();
});

it("says an /inbox/asks/<id> the server refuses cannot be shown", async () => {
  const view = await boot("/inbox/asks/0badf00d");
  await settle();
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(
    pinned(view)?.querySelector("[data-asks-pinned-missing]"),
  ).not.toBeNull();
  expect(pinned(view)?.querySelector("[data-ask-readonly]")).toBeNull();
});

it("shows a pinned open ask closed, with its answer, once it leaves the store", async () => {
  setAsks([target, pointer("nothing")]);
  const view = await boot(`/inbox/asks/${target.id}`);
  await settle();
  expect(
    pinned(view)?.querySelector(`[data-ask="${target.id}"]`),
  ).not.toBeNull();
  // Answered on another device: the server removes it from the open list.
  setAskRead(async (id) => closedAsk(id, { prompt: target.prompt }));
  await act(async () =>
    shimEmit({ type: "ask_removed", id: target.id } as never),
  );
  await settle();
  expect(askReads).toContain(target.id);
  const card = pinned(view)?.querySelector<HTMLElement>(
    `[data-ask-readonly="${target.id}"]`,
  );
  expect(card).not.toBeNull();
  expect(card!.textContent).toContain("Yes, after the tests");
  expect(cardsOf(view, target.id)).toBe(0);
});

it("never shows an answer on a closed secret request, only that it was saved", async () => {
  setAskRead(async (id) =>
    closedAsk(id, {
      prompt: "Add the Linear key?",
      options: undefined,
      recommended: undefined,
      secret: {
        requestId: "r1",
        scope: "personal",
        name: "LINEAR_KEY",
        reason: "Read the board",
        hosts: ["api.linear.app"],
        form: { kind: "authorization" },
      },
      closed: {
        at: 2_000,
        outcome: "saved",
        by: "member",
        answer: "lin_api_SECRETVALUE",
      },
    }),
  );
  const view = await boot("/inbox/asks/5ec2e7aa");
  await settle();
  const card = pinned(view)?.querySelector<HTMLElement>(
    '[data-ask-readonly="5ec2e7aa"]',
  );
  expect(card).not.toBeNull();
  expect(
    card!.querySelector("[data-ask-outcome]")?.getAttribute("data-ask-outcome"),
  ).toBe("saved");
  expect(card!.textContent).not.toContain("lin_api_SECRETVALUE");
});

it("opens an ask's link to one ask on that ask, pinned, under a label of its own", async () => {
  setAskRead(async (id) => closedAsk(id));
  setAsks([
    ask("b7c8d9e0", "a1", "/inbox/asks/c0ffee12"),
    ask("d1e2f3a4", "a1", "/inbox/asks"),
  ]);
  const view = await boot("/inbox/asks");
  await settle();
  const toAsk = officeLink(view, "b7c8d9e0");
  const toList = officeLink(view, "d1e2f3a4");
  expect(toAsk).not.toBeNull();
  expect(toList).not.toBeNull();
  // Not the Asks page's label: the button names one ask.
  expect(toAsk!.textContent).not.toBe(toList!.textContent);
  await act(async () => fireEvent.click(toAsk!));
  await settle();
  expect(
    pinned(view)?.querySelector('[data-ask-readonly="c0ffee12"]'),
  ).not.toBeNull();
});

it("shows a closed ask filed as a task with that task's chip", async () => {
  const filed = {
    id: "ce5e7fe0",
    title: "Rotate the staging key",
    priority: "P2",
    status: "open",
    createdBy: "member",
    username: "member",
    createdAt: 1,
    roomId: "r1",
  };
  setAskRead(async (id) =>
    closedAsk(id, {
      closed: { at: 2_000, outcome: "filed", by: "member", taskId: filed.id },
    }),
  );
  const view = await boot("/inbox/asks/c0ffee12");
  await act(async () => shimEmit({ type: "tasks", tasks: [filed] } as never));
  await settle();
  const card = pinned(view)?.querySelector<HTMLElement>(
    '[data-ask-readonly="c0ffee12"]',
  );
  expect(
    card?.querySelector("[data-ask-outcome]")?.getAttribute("data-ask-outcome"),
  ).toBe("filed");
  expect(
    card?.querySelector(`button.task-id-chip[data-task-id="${filed.id}"]`),
  ).not.toBeNull();
});
