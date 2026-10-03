// Task 51de8814: a message the member sends never disappears before the server
// acknowledges it. The composer hands it to the outbox as a pending attempt;
// a failed attempt stays above the composer, separate from any newer draft.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { ApiError } = await import("../api.ts");
const {
  outboxFixture: fx,
  setupOutboxTests,
  mount,
  composer,
  rows,
  rowButton,
  type,
  send,
} = await import("../test-support/outbox-fixture.tsx");
setupOutboxTests();

it("shows a pending row while the request is open, and drops it on the ack", async () => {
  let release: () => void = () => {};
  fx.answer = () => new Promise((resolve) => (release = () => resolve({})));
  const view = mount();
  await type(view.container, "careful prompt");
  await send(view.container);

  expect(composer(view.container).value).toBe("");
  expect(rows(view.container, "pending").length).toBe(1);
  expect(rows(view.container, "pending")[0].textContent).toContain(
    "careful prompt",
  );
  expect(fx.posts[0].clientMessageId).toBeTruthy();

  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(rows(view.container).length).toBe(0));
  view.unmount();
});

it("keeps a network failure as a not-sent row, and Resend reuses the attempt id", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await type(view.container, "careful prompt");
  await send(view.container);

  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));
  const failed = rows(view.container, "failed")[0];
  expect(failed.textContent).toContain("careful prompt");

  fx.answer = async () => ({});
  await act(async () => {
    fireEvent.click(rowButton(failed, "Resend"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(rows(view.container).length).toBe(0));
  expect(fx.posts.length).toBe(2);
  expect(fx.posts[1].clientMessageId).toBe(fx.posts[0].clientMessageId);
  expect(fx.posts[1].text).toBe("careful prompt");
  view.unmount();
});

it("keeps a server refusal with its reason", async () => {
  fx.answer = async () => {
    throw new ApiError(429, "queue_full", "queue_full");
  };
  const view = mount();
  await type(view.container, "overflow");
  await send(view.container);

  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));
  expect(rows(view.container, "failed")[0].textContent).toContain("queue_full");
  view.unmount();
});

it("keeps a failed attempt separate from a newer draft, with its own id and text", async () => {
  fx.answer = async (post) => {
    if (post.text === "first") throw new TypeError("Failed to fetch");
    return {};
  };
  const view = mount();
  await type(view.container, "first");
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));

  await type(view.container, "second");
  await send(view.container);
  await waitFor(() => expect(fx.posts.length).toBe(2));
  expect(fx.posts[1].clientMessageId).not.toBe(fx.posts[0].clientMessageId);

  // The newer message went through; the failed one is untouched.
  const failed = rows(view.container);
  expect(failed.length).toBe(1);
  expect(failed[0].textContent).toContain("first");
  expect(failed[0].textContent).not.toContain("second");
  view.unmount();
});
