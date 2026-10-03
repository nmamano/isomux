// Task 51de8814: when the browser cannot save the pending attempt (quota,
// privacy mode), nothing is sent and the composer keeps the message and its
// attachments, because it is then the only copy.
import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { restoreOutbox } = await import("./outbox.ts");
const {
  outboxFixture: fx,
  setupOutboxTests,
  mount,
  composer,
  rows,
  type,
  send,
} = await import("../test-support/outbox-fixture.tsx");
setupOutboxTests();

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

it("keeps the text and attachments in the composer and sends nothing when the attempt cannot be saved", async () => {
  // The member is known, so attempts are saved under their keys.
  restoreOutbox("Boss", new Set(["a1"]));
  // The prototype method, read without binding: Storage writes go through it.
  const realSetItem = Object.getOwnPropertyDescriptor(
    Storage.prototype,
    "setItem",
  )!.value as (this: Storage, key: string, value: string) => void;
  const setItem = spyOn(Storage.prototype, "setItem").mockImplementation(
    function (this: Storage, key: string, value: string) {
      if (key.startsWith("isomux-outbox:"))
        throw new DOMException("full", "QuotaExceededError");
      realSetItem.call(this, key, value);
    },
  );
  restores.push(() => setItem.mockRestore());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        attachments: [
          {
            filename: "f1.png",
            originalName: "shot.png",
            mediaType: "image/png",
            size: 3,
          },
        ],
      }),
    )) as unknown as typeof fetch;
  restores.push(() => (globalThis.fetch = realFetch));

  const view = mount();
  const input = view.container.querySelector<HTMLInputElement>(
    'input[type="file"]',
  )!;
  const file = new File(["abc"], "shot.png", { type: "image/png" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(view.container.textContent).toContain("shot.png"));

  await type(view.container, "careful prompt");
  await send(view.container);

  expect(fx.posts.length).toBe(0);
  expect(composer(view.container).value).toBe("careful prompt");
  expect(view.container.textContent).toContain("shot.png");
  expect(rows(view.container).length).toBe(0);
  expect(
    view.container.querySelector("[data-outbox-save-failed]"),
  ).not.toBe(null);
  view.unmount();
});
