// A shared ask on the member's side (task 9461c464): the card names who else
// it is for, or the room; and when another member answered first, the
// member's own answer is not sent and a notice names who answered
// ([data-ask-closed-by]), on the Inbox's Undo line and in the chat's stack.
// Through the real App and store.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ApiError } = await import("./api.ts");
const { shimEmit } = await import("./ws.ts");
const {
  ask,
  boot,
  chatFromInbox,
  inboxButton,
  setAnswerPost,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;
type AskMemberWire = import("../shared/types.ts").AskMemberWire;

setUpInboxTests();

// q1 is for the member, Pat and Kim; q2 for everyone in First room; q3 for
// the member alone. Newest first: q1, q2, q3.
const at = (t: number) => ({ createdAt: t, updatedAt: t });
const SHARED: AskMemberWire[] = [
  { ...ask("q1", "a1"), ...at(3_000), members: ["member", "pat", "kim"] },
  { ...ask("q2", "a1"), ...at(2_000), room: true, members: ["member", "pat"] },
  { ...ask("q3", "a1"), ...at(1_000), members: ["member"] },
];

// The answer POSTs, each held open until the test settles it.
function holdPosts() {
  const posts: string[] = [];
  const settles: { ok: () => void; fail: (err: Error) => void }[] = [];
  setAnswerPost(
    (path) =>
      new Promise((resolve, reject) => {
        posts.push(path);
        settles.push({ ok: () => resolve({}), fail: reject });
      }),
  );
  return { posts, settles };
}
const closedBy = (by: string) =>
  new ApiError(409, "ask_closed", "closed", { code: "ask_closed", by });

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const stackIds = (view: View) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      "[data-asks-stack] [data-ask]",
    ),
  ].map((el) => el.dataset.ask);
const notices = (view: View) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-ask-closed-by]")].map(
    (el) => el.dataset.askClosedBy,
  );
async function reply(view: View, id: string) {
  await act(async () =>
    fireEvent.click(
      card(view, id)!.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!,
    ),
  );
}
async function settle(run: () => void) {
  await act(async () => run());
  await act(async () => {});
}
const removed = (id: string, by: string) =>
  settle(() => shimEmit({ type: "ask_removed", id, by } as never));

it("names the other members of a list ask and the room of a room ask on the card; an ask for the member alone names no one", async () => {
  setAsks(SHARED);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  const line = (id: string) =>
    card(view, id)?.querySelector("[data-ask-members]")?.textContent ?? null;
  expect(line("q1")).toContain("pat");
  expect(line("q1")).toContain("kim");
  expect(line("q2")).toContain("First room");
  expect(line("q3")).toBeNull();
});

it("an Inbox answer in its Undo time to an ask another member answered first: the Undo line names them and nothing is sent", async () => {
  setAsks(SHARED);
  const { posts } = holdPosts();
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await reply(view, "q1");
  expect(card(view, "q1")?.querySelector("[data-ask-undo]")).not.toBeNull();
  await removed("q1", "pat");
  expect(notices(view)).toEqual(["pat"]);
  // Leaving the Inbox sends every held answer; this one is gone.
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(posts).toEqual([]);
});

it("a chat-stack answer refused as ask_closed: the card goes and the stack names who answered first", async () => {
  setAsks(SHARED);
  const { posts, settles } = holdPosts();
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, "a1");
  expect(stackIds(view)).toEqual(["q1", "q2", "q3"]);
  await reply(view, "q1");
  expect(posts).toEqual(["/api/asks/q1/reply"]);
  await settle(() => settles[0].fail(closedBy("pat")));
  expect(stackIds(view)).toEqual(["q2", "q3"]);
  expect(notices(view)).toEqual(["pat"]);
});

it("a removal naming who answered, while the member's chat-stack answer is in flight, shows one notice, also when the refusal follows", async () => {
  setAsks(SHARED);
  const { settles } = holdPosts();
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, "a1");
  await reply(view, "q2");
  await removed("q2", "kim");
  expect(stackIds(view)).toEqual(["q1", "q3"]);
  expect(notices(view)).toEqual(["kim"]);
  await settle(() => settles[0].fail(closedBy("kim")));
  expect(notices(view)).toEqual(["kim"]);
});

it("a removal naming who answered, while the member is not answering, takes the card with no notice", async () => {
  setAsks(SHARED);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await chatFromInbox(view, "a1");
  await removed("q1", "pat");
  expect(stackIds(view)).toEqual(["q2", "q3"]);
  expect(notices(view)).toEqual([]);
});
