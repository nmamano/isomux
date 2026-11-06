// A paged ask on the member's card (task 74e8fc07): while it rings, the card
// marks the alarm and offers Ack, which posts the ack and keeps the card; an
// acked one names who acked and offers no Ack; a plain ask shows neither.
// Through the real App and store. The card's markers: [data-ask-page] holds
// the alarm state, [data-ask-ack] is the Ack button.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { ask, boot, inboxButton, setAnswerPost, setAsks, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskMemberWire = import("../shared/types.ts").AskMemberWire;

setUpInboxTests();

const at = (t: number) => ({ createdAt: t, updatedAt: t });
const ringing = (id: string, t: number): AskMemberWire => ({
  ...ask(id, "a1"),
  ...at(t),
  members: ["member"],
  priority: "P1",
  page: { state: "ringing" },
});
const acked = (id: string, t: number, by: string | null): AskMemberWire => ({
  ...ringing(id, t),
  page: { state: "acked", ackedBy: by, ackedAt: t + 1 },
});

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const ackButton = (view: View, id: string) =>
  card(view, id)?.querySelector<HTMLButtonElement>("button[data-ask-ack]") ??
  null;
const alarm = (view: View, id: string) =>
  card(view, id)?.querySelector<HTMLElement>("[data-ask-page]") ?? null;

async function openInbox() {
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  return view;
}

it("a ringing paged ask shows its alarm and Ack; an acked one names who acked and has no Ack; a plain ask shows neither", async () => {
  setAsks([
    ringing("q1", 3_000),
    acked("q2", 2_000, "pat"),
    { ...ask("q3", "a1"), ...at(1_000), members: ["member"] },
  ]);
  const view = await openInbox();
  expect(alarm(view, "q1")?.dataset.askPage).toBe("ringing");
  expect(ackButton(view, "q1")).not.toBeNull();
  expect(alarm(view, "q2")?.dataset.askPage).toBe("acked");
  expect(alarm(view, "q2")?.textContent).toContain("pat");
  expect(ackButton(view, "q2")).toBeNull();
  expect(card(view, "q3")).not.toBeNull();
  expect(alarm(view, "q3")).toBeNull();
  expect(ackButton(view, "q3")).toBeNull();
});

it("Ack posts the ack and keeps the card; the acked ask that comes back names who acked", async () => {
  setAsks([ringing("q1", 3_000)]);
  const posts: string[] = [];
  setAnswerPost(async (path) => {
    posts.push(path);
    return acked("q1", 3_000, "member");
  });
  const view = await openInbox();
  expect(ackButton(view, "q1")).not.toBeNull();
  await act(async () => fireEvent.click(ackButton(view, "q1")!));
  await act(async () => {});
  expect(posts).toEqual(["/api/asks/q1/ack"]);
  expect(card(view, "q1")).not.toBeNull();
  await act(async () =>
    shimEmit({
      type: "ask_upserted",
      entry: acked("q1", 3_000, "member"),
    } as never),
  );
  expect(alarm(view, "q1")?.dataset.askPage).toBe("acked");
  expect(alarm(view, "q1")?.textContent).toContain("member");
  expect(ackButton(view, "q1")).toBeNull();
  // The reply field is still there: the ask is open.
  expect(
    card(view, "q1")?.querySelector('button[type="submit"]'),
  ).not.toBeNull();
});

it("an acked ask whose acker is gone still shows it as acked", async () => {
  setAsks([acked("q1", 3_000, null)]);
  const view = await openInbox();
  expect(alarm(view, "q1")?.dataset.askPage).toBe("acked");
  expect(ackButton(view, "q1")).toBeNull();
});
