// Task 51de8814: the actions on a not-sent row, and slash-menu commands, which
// go through the same outbox.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
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

it("Edit moves the text back into the composer after the newer draft and drops the attempt", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await type(view.container, "lost prompt");
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));

  await type(view.container, "newer");
  await act(async () => {
    fireEvent.click(rowButton(rows(view.container, "failed")[0], "Edit"));
  });
  await waitFor(() =>
    expect(composer(view.container).value).toBe("newer\n\nlost prompt"),
  );
  expect(rows(view.container).length).toBe(0);
  view.unmount();
});

// Discard cannot be undone (AGENTS.md "UI rules", task d38f611f): the first
// click arms it, and only the second drops the attempt. One row is armed at a
// time.
it("Discard asks first: one click arms that row only, the second drops the attempt without sending it", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await type(view.container, "throwaway");
  await send(view.container);
  await type(view.container, "keeper");
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(2));
  const discardOf = (row: HTMLElement) =>
    row.querySelector<HTMLButtonElement>('[data-outbox-action="discard"]')!;
  const armed = () =>
    [
      ...view.container.querySelectorAll<HTMLElement>(
        "[data-outbox-attempt] [data-confirm-armed]",
      ),
    ].map((el) => el.dataset.outboxAction);

  const [first] = rows(view.container, "failed");
  const idle = discardOf(first).textContent;
  await act(async () => {
    fireEvent.click(discardOf(first));
  });
  expect(rows(view.container, "failed").length).toBe(2);
  expect(armed()).toEqual(["discard"]);
  expect(first.querySelector("[data-confirm-armed]")).not.toBeNull();
  expect(discardOf(first).textContent).not.toBe(idle);

  await act(async () => {
    fireEvent.click(discardOf(first));
  });
  expect(rows(view.container, "failed").length).toBe(1);
  expect(rows(view.container, "failed")[0].textContent).toContain("keeper");
  expect(armed()).toEqual([]);
  expect(fx.posts.length).toBe(2);
  view.unmount();
});

it("a command picked from a slash draft keeps the draft while the socket is down", async () => {
  const view = mount(false);
  await type(view.container, "/cle");
  const entry = view.getByText("/clear");
  await act(async () => {
    fireEvent.mouseDown(entry);
    fireEvent.click(entry);
  });
  expect(composer(view.container).value).toBe("/cle");
  expect(fx.posts.length).toBe(0);
  view.unmount();
});

it("a command picked from a slash draft goes through the outbox", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await type(view.container, "/cle");
  const entry = view.getByText("/clear");
  await act(async () => {
    fireEvent.mouseDown(entry);
    fireEvent.click(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(fx.posts.map((p) => p.text)).toEqual(["/clear"]);
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));
  view.unmount();
});
