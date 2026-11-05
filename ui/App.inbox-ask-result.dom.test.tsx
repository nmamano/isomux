// A credential an action ask's Apply made (task e3d1bc63, part 4), through the
// real App and store: the ask closes as the token is made, often before the
// Apply answers, and the Inbox's Asks tab shows the token where the ask was
// until the member closes it. The token lives in memory only. The setup is
// in ui/test-support/inbox-fixture.tsx; the chat's ask stack is in
// ui/log-view/ask-action.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { boot, inboxButton, setAnswerPost, setAsks, setUpInboxTests } =
  await import("./test-support/inbox-fixture.tsx");
type AskEntry = import("../shared/types.ts").AskEntry;

setUpInboxTests();

const TOKEN = "isx_RAWTOKEN_INBOX";
const tokenAsk: AskEntry = {
  id: "tok00001",
  agentId: "a1",
  memberUserId: "u1",
  prompt: "Make a token for the deploy script?",
  createdAt: 1_000,
  updatedAt: 1_000,
  step: { kind: "api-token", name: "deploy", expiresInDays: 30 },
} as AskEntry;

// Every value the browser keeps across a reload.
const kept = () =>
  JSON.stringify([
    Object.entries(window.localStorage),
    Object.entries(window.sessionStorage),
  ]);

it("shows the token on the Asks tab after the ask closed, until Close, and keeps it nowhere a reload reads", async () => {
  setAsks([tokenAsk]);
  let release: () => void = () => {};
  const posts: string[] = [];
  setAnswerPost((path) => {
    posts.push(path);
    return new Promise(
      (resolve) =>
        (release = () =>
          resolve({ token: TOKEN, apiToken: { id: "t1", name: "deploy" } })),
    );
  });
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  const apply = () =>
    view.container.querySelector<HTMLButtonElement>(
      '[data-ask="tok00001"] [data-ask-action-apply]',
    );
  await waitFor(() => expect(apply()).not.toBe(null));
  await act(async () => fireEvent.click(apply()!));
  expect(posts).toEqual(["/api/asks/tok00001/action"]);
  await act(async () => {
    shimEmit({ type: "ask_removed", id: "tok00001" } as never);
  });
  expect(view.container.querySelector('[data-ask="tok00001"]')).toBe(null);
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
  const result = () =>
    view.container.querySelector<HTMLElement>('[data-ask-result="tok00001"]');
  expect(result()?.textContent).toContain(TOKEN);
  expect(kept().includes(TOKEN)).toBe(false);
  await act(async () =>
    fireEvent.click(
      result()!.querySelector<HTMLButtonElement>("[data-ask-result-close]")!,
    ),
  );
  expect(result()).toBe(null);
  view.unmount();
});
