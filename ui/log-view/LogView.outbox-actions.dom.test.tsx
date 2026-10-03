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

it("Discard drops the attempt without sending it", async () => {
  fx.answer = async () => {
    throw new TypeError("Failed to fetch");
  };
  const view = mount();
  await type(view.container, "throwaway");
  await send(view.container);
  await waitFor(() => expect(rows(view.container, "failed").length).toBe(1));

  await act(async () => {
    fireEvent.click(rowButton(rows(view.container, "failed")[0], "Discard"));
  });
  expect(rows(view.container).length).toBe(0);
  expect(fx.posts.length).toBe(1);
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
