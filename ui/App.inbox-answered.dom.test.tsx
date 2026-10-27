// An ask the member answers on the Inbox counts as answered at once wherever
// this member sees it (task ab332fb2): the Asks tab count, the office bar's
// Inbox badge, the agent's desk dot and the agent's ask stack above the chat.
// Undo brings it back everywhere, and so does a send that fails, with the
// error on the card. Through the real App and store; the Undo line itself and
// its timer are in ui/components/AsksView.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ApiError } = await import("./api.ts");
const { boot, inboxButton, setAnswerPost, setUpInboxTests, tabCount } =
  await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

// The answer POSTs, each held open until the test settles it.
function holdPosts() {
  const posts: string[] = [];
  const settles: { ok: () => void; fail: (code: string) => void }[] = [];
  setAnswerPost(
    (path) =>
      new Promise((resolve, reject) => {
        posts.push(path);
        settles.push({
          ok: () => resolve({}),
          fail: (code) => reject(new ApiError(409, code, code)),
        });
      }),
  );
  return { posts, settles };
}

const badge = (view: View) =>
  inboxButton(view)?.querySelector(".nav-action-badge")?.textContent ?? null;
// The office opens on the lobby; the room's tab (an SVG group, named by its
// title) shows Scout's desk.
async function openRoom(view: View) {
  const title = [...view.container.querySelectorAll("title")].find(
    (el) => el.textContent === "First room",
  )!;
  await act(async () => fireEvent.click(title.parentElement!));
  await act(async () => {});
}
const deskDot = (view: View) =>
  view.container.querySelector("[data-ask-dot]")?.textContent ?? null;
const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const stackIds = (view: View) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      "[data-asks-stack] [data-ask]",
    ),
  ].map((el) => el.dataset.ask);
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

it("leaves the tab count at once, comes back on Undo, and leaves the badge and desk dot while in flight until the send fails", async () => {
  const { posts, settles } = holdPosts();
  const view = await boot();
  await openRoom(view);
  // Scout's two asks; the hidden-room ask counts nowhere.
  expect(badge(view)).toBe("2");
  expect(deskDot(view)).toBe("2");
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(tabCount(view, "asks")).toBe("2");

  await reply(view, "q1");
  expect(card(view, "q1")?.querySelector("[data-ask-undo]")).not.toBeNull();
  expect(tabCount(view, "asks")).toBe("1");
  await act(async () =>
    fireEvent.click(card(view, "q1")!.querySelector("[data-ask-undo]")!),
  );
  expect(tabCount(view, "asks")).toBe("2");

  // Answered again, then the Inbox closes: the answer is sent at once and
  // stays out of every count while the POST is in flight.
  await reply(view, "q1");
  expect(tabCount(view, "asks")).toBe("1");
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(posts).toEqual(["/api/asks/q1/reply"]);
  expect(badge(view)).toBe("1");
  expect(deskDot(view)).toBe("1");

  await settle(() => settles[0].fail("ask_busy"));
  expect(badge(view)).toBe("2");
  expect(deskDot(view)).toBe("2");
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(tabCount(view, "asks")).toBe("2");
  expect(
    card(view, "q1")?.querySelector("[role=alert]")?.textContent,
  ).toContain("ask_busy");
});

it("keeps an answered ask off the agent's chat stack while it is sent, brings it back with the error on a failure, and a retry there clears the error", async () => {
  const { posts, settles } = holdPosts();
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  await reply(view, "q1");
  // The agent's name opens its chat; leaving the Inbox sends the answer.
  await act(async () =>
    fireEvent.click(view.container.querySelector('[data-asks-agent="a1"]')!),
  );
  expect(posts).toEqual(["/api/asks/q1/reply"]);
  expect(stackIds(view)).toEqual(["q2"]);

  await settle(() => settles[0].fail("ask_busy"));
  expect(stackIds(view)).toEqual(["q1", "q2"]);
  expect(
    card(view, "q1")?.querySelector("[role=alert]")?.textContent,
  ).toContain("ask_busy");

  // The chat stack still sends at once and keeps its card until the server
  // accepts; the old error goes as the new answer starts.
  await reply(view, "q1");
  expect(posts).toEqual(["/api/asks/q1/reply", "/api/asks/q1/reply"]);
  expect(stackIds(view)).toEqual(["q1", "q2"]);
  expect(card(view, "q1")!.querySelector("[role=alert]")).toBeNull();
  await settle(() => settles[1].ok());
  expect(stackIds(view)).toEqual(["q2"]);
});
