// The phone drawer and the browser's Back (task 3cced5be; Reviewer 1's build
// conditions, 2026-11-13). The open drawer is one more layer: over the
// office it pushes one entry, which Back, the backdrop, the hide button and
// the Office row take away again; a row REPLACES it with its target, so Back
// from that target is the office. Over a chat it pushes nothing: Back closes
// the drawer only. When the window stops being a phone, the drawer goes the
// same way. The rest of the drawer is in ui/App.phone-sidebar.dom.test.tsx;
// the setup in ui/test-support/chat-sidebar-fixture.tsx.

import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const {
  LOAD_ENTRY,
  bootPhone,
  chatOpen,
  click,
  goBack,
  press,
  resizeWindow,
  scout,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const drawer = (view: View) =>
  view.baseElement.querySelector("[data-phone-sidebar]");
const inDrawer = (view: View, selector: string) =>
  view.baseElement.querySelector<HTMLElement>(
    `[data-phone-sidebar] nav[data-chat-sidebar] ${selector}`,
  );
const backdrop = (view: View) =>
  view.baseElement.querySelector("[data-phone-sidebar-backdrop]");
function showButton(view: View, scope = ""): HTMLButtonElement | null {
  const all = view.baseElement.querySelectorAll<HTMLButtonElement>(
    `${scope} button[data-show-sidebar]`.trim(),
  );
  expect(all.length).toBe(1);
  return all[0];
}
async function scoutRow(view: View): Promise<HTMLElement | null> {
  const header = inDrawer(view, 'button[data-sidebar-room="r1"]');
  if (header?.getAttribute("aria-expanded") !== "true") await click(header);
  return inDrawer(view, `button[data-sidebar-agent="${scout.id}"]`);
}
/** Let a deferred history.back() (below) land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const onLoadEntry = () =>
  JSON.stringify(window.history.state) === JSON.stringify(LOAD_ENTRY);

let backSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  backSpy?.mockRestore();
  backSpy = null;
});

it("over the office: opening pushes an entry; a row replaces it, so Back from the chat lands on the office's own entry with the drawer closed", async () => {
  const view = await bootPhone();
  expect(onLoadEntry()).toBe(true);
  await click(showButton(view));
  expect(onLoadEntry()).toBe(false);

  await click(await scoutRow(view));
  expect(chatOpen(view)).toBe(true);
  await goBack();
  expect({
    chat: chatOpen(view),
    drawer: drawer(view) !== null,
    loadEntry: onLoadEntry(),
  }).toEqual({ chat: false, drawer: false, loadEntry: true });
});

it("over a chat: Back closes the drawer only and the chat stays; the next Back is the office", async () => {
  const view = await bootPhone();
  await click(showButton(view));
  await click(await scoutRow(view));
  await click(showButton(view, ".log-view-shell"));
  expect(drawer(view)).not.toBeNull();

  await goBack();
  expect({ chat: chatOpen(view), drawer: drawer(view) !== null }).toEqual({
    chat: true,
    drawer: false,
  });
  await goBack();
  expect({ chat: chatOpen(view), loadEntry: onLoadEntry() }).toEqual({
    chat: false,
    loadEntry: true,
  });
});

it("over the office, the backdrop, the hide button and the Office row each close the drawer at once and go back exactly once", async () => {
  const view = await bootPhone();
  // happy-dom fires popstate inside history.back(); a browser fires it
  // later. Defer it as a browser does, so a close that waits for the
  // popstate leaves the drawer up between the tap and the popstate.
  const realBack = window.history.back.bind(window.history);
  backSpy = spyOn(window.history, "back").mockImplementation(() => {
    setTimeout(realBack, 0);
  });
  const closers: [string, () => Element | null][] = [
    ["backdrop", () => backdrop(view)],
    ["hide", () => inDrawer(view, "button[data-sidebar-collapse]")],
    ["office row", () => inDrawer(view, 'button[data-sidebar-nav="office"]')],
  ];
  const seen: Record<string, unknown> = {};
  for (const [name, find] of closers) {
    backSpy.mockClear();
    await click(showButton(view));
    expect(onLoadEntry()).toBe(false);
    const target = find();
    expect(target).not.toBeNull();
    // Two taps before the Back lands: the drawer is gone after the first,
    // so the second finds nothing to go back with.
    await act(async () => {
      fireEvent.click(target!);
    });
    const goneAtOnce = drawer(view) === null;
    const again = find();
    if (again) await act(async () => fireEvent.click(again));
    await settle();
    seen[name] = {
      goneAtOnce,
      backs: backSpy.mock.calls.length,
      drawer: drawer(view) !== null,
      loadEntry: onLoadEntry(),
    };
  }
  const want = { goneAtOnce: true, backs: 1, drawer: false, loadEntry: true };
  expect(seen).toEqual({ backdrop: want, hide: want, "office row": want });
});

it("over a chat on a cold page link's entry, the drawer pushes nothing and its backdrop goes back nowhere (ruling 8)", async () => {
  // A cold /tasks link with Scout's chat under the page; Escape closes the
  // page onto the chat, on the same adopted entry.
  const view = await bootPhone(undefined, "/tasks");
  await press("1");
  await press("Escape");
  expect(chatOpen(view)).toBe(true);
  const pushSpy = spyOn(window.history, "pushState");
  backSpy = spyOn(window.history, "back");
  try {
    await click(showButton(view, ".log-view-shell"));
    expect(drawer(view)).not.toBeNull();
    await click(backdrop(view));
    await settle();
    expect({
      pushes: pushSpy.mock.calls.length,
      backs: backSpy.mock.calls.length,
      drawer: drawer(view) !== null,
      chat: chatOpen(view),
    }).toEqual({ pushes: 0, backs: 0, drawer: false, chat: true });
  } finally {
    pushSpy.mockRestore();
  }
});

it("a window that stops being a phone takes the drawer and its entry away", async () => {
  const view = await bootPhone();
  await click(showButton(view));
  expect(onLoadEntry()).toBe(false);
  await resizeWindow(1440);
  await settle();
  expect({ drawer: drawer(view) !== null, loadEntry: onLoadEntry() }).toEqual({
    drawer: false,
    loadEntry: true,
  });
});
