// The Asks page when a load of the asks fails (task e2a2513b): it tells the
// member the asks could not load ([data-asks-load-failed]) instead of its
// empty state ([data-asks-empty]), and Try again ([data-asks-retry]) reads
// them again. Through the real App, store and useAsksSync /
// useOthersAsksSync, with GET /api/asks and GET /api/asks/others answered
// by the test.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  ask,
  asksGets,
  boot,
  emitFullState,
  inboxButton,
  setAsksGet,
  setOthersAsksGet,
  setRole,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
const { ApiError } = await import("./api.ts");
const { setAsksMember } = await import("./device-settings.ts");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskMemberWire = import("../shared/types.ts").AskMemberWire;
type AskAgentWire = import("../shared/contract-shapes.ts").AskAgentWire;

setUpInboxTests();

const fail = async (): Promise<unknown> => {
  throw new ApiError(500, "internal", "Boom.");
};
const own: AskMemberWire[] = [{ ...ask("q1", "a1"), members: ["member"] }];
const others: AskAgentWire[] = [
  { ...ask("p1", "a1"), memberUserId: "u-pat", member: "pat" },
];

const notice = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-asks-load-failed]");
const empty = (view: View) => view.container.querySelector("[data-asks-empty]");
const card = (view: View, id: string) =>
  view.container.querySelector(`[data-ask="${id}"]`);

async function openInbox() {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  return view;
}

async function retry(view: View) {
  const button = notice(view)?.querySelector<HTMLButtonElement>(
    "button[data-asks-retry]",
  );
  expect(button).not.toBeNull();
  await act(async () => fireEvent.click(button!));
  await act(async () => {});
}

it("a failed GET /api/asks shows the notice, not the empty state, until Try again loads the asks", async () => {
  setAsksGet(fail);
  const view = await openInbox();
  expect(asksGets.own).toBe(1);
  expect(notice(view)).not.toBeNull();
  expect(notice(view)!.getAttribute("role")).toBe("alert");
  expect(empty(view)).toBeNull();
  // While the retry is in flight the page still says the load failed: no
  // "No open asks" between the click and the answer.
  let answer!: (entries: AskMemberWire[]) => void;
  setAsksGet(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  await retry(view);
  expect(asksGets.own).toBe(2);
  expect(notice(view)).not.toBeNull();
  expect(empty(view)).toBeNull();
  await act(async () => answer(own));
  await act(async () => {});
  expect(card(view, "q1")).not.toBeNull();
  expect(notice(view)).toBeNull();
});

it("a GET /api/asks that answers with no list counts as failed", async () => {
  setAsksGet(async () => ({}));
  const view = await openInbox();
  expect(asksGets.own).toBe(1);
  expect(notice(view)).not.toBeNull();
  expect(empty(view)).toBeNull();
});

it("a failed read after a reconnect keeps the asks of the earlier load under the notice", async () => {
  setAsksGet(async () => own);
  const view = await openInbox();
  expect(card(view, "q1")).not.toBeNull();
  expect(notice(view)).toBeNull();
  setAsksGet(fail);
  await act(async () => emitFullState());
  await act(async () => {});
  expect(asksGets.own).toBe(2);
  expect(notice(view)).not.toBeNull();
  expect(card(view, "q1")).not.toBeNull();
});

it("an owner on All members: a failed GET /api/asks/others shows the notice over the own asks, and Try again loads the others", async () => {
  setRole("owner");
  setAsksMember({ kind: "all" });
  setAsksGet(async () => own);
  setOthersAsksGet(fail);
  const view = await openInbox();
  expect(asksGets.others).toBe(1);
  expect(notice(view)).not.toBeNull();
  expect(card(view, "q1")).not.toBeNull();
  setOthersAsksGet(async () => others);
  await retry(view);
  // Only the side that failed is read again.
  expect(asksGets.others).toBe(2);
  expect(asksGets.own).toBe(1);
  expect(card(view, "p1")).not.toBeNull();
  expect(notice(view)).toBeNull();
});

it("an owner's own asks view shows no notice when only the others failed", async () => {
  setRole("owner");
  setAsksMember({ kind: "mine" });
  setAsksGet(async () => own);
  setOthersAsksGet(fail);
  const view = await openInbox();
  expect(asksGets.others).toBe(1);
  expect(card(view, "q1")).not.toBeNull();
  expect(notice(view)).toBeNull();
});

it("an owner's view of one member shows no notice when only the own asks failed", async () => {
  setRole("owner");
  setAsksMember({ kind: "member", name: "pat" });
  setAsksGet(fail);
  setOthersAsksGet(async () => others);
  const view = await openInbox();
  expect(asksGets.own).toBe(1);
  expect(card(view, "p1")).not.toBeNull();
  expect(notice(view)).toBeNull();
});
