// A room header's show-room button in the sidebar (task 82997335), from a
// page with unsaved edits and from the phone drawer: it leaves as every row
// that leaves a view does (App's `then`), so the page asks first and the
// drawer closes. The rest of the button is in
// ui/App.chat-sidebar-show-room.dom.test.tsx; the setup in
// ui/test-support/chat-sidebar-fixture.tsx.

import { afterEach, expect, it, spyOn } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { en } = await import("../shared/i18n/en.ts");
const {
  LOAD_ENTRY,
  activeRoom,
  boot,
  bootPhone,
  chatOpen,
  click,
  openFirstDesk,
  press,
  setUpChatSidebarTests,
} = await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

let backSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  backSpy?.mockRestore();
  backSpy = null;
});

const showButton = (view: View, roomId: string, scope = "") =>
  view.baseElement.querySelector<HTMLButtonElement>(
    `${scope} nav[data-chat-sidebar] button[data-sidebar-show-room="${roomId}"]`.trim(),
  );
const tasksOpen = (view: View) =>
  view.container.querySelector("[data-tasks-page]") !== null;

it("from Tasks over a chat with an unsaved new task: asks first, and shows the room only on discard, not the chat under the page", async () => {
  const view = await boot();
  await openFirstDesk(view);
  await press("t");
  const quickAdd = view.getByPlaceholderText(en["tasks.quickAdd"]);
  await act(async () => {
    fireEvent.change(quickAdd, { target: { value: "unsaved title" } });
    fireEvent.keyDown(quickAdd, { key: "Enter", bubbles: true });
  });
  expect(view.getByDisplayValue("unsaved title")).toBeDefined();
  const prompt = () =>
    [...view.container.querySelectorAll("span")].find(
      (span) => span.textContent === en["common.discardPrompt"],
    )?.parentElement ?? null;

  await click(showButton(view, "r2"));
  expect({
    prompt: prompt() !== null,
    tasks: tasksOpen(view),
  }).toEqual({ prompt: true, tasks: true });

  await click(prompt()!.querySelector("button"));
  expect({
    chat: chatOpen(view),
    tasks: tasksOpen(view),
    room: activeRoom(view),
    entry: window.history.state,
  }).toEqual({ chat: false, tasks: false, room: "r2", entry: LOAD_ENTRY });
});

it("on a phone, the button in the drawer closes the drawer and shows the room", async () => {
  // happy-dom fires popstate inside history.back(); a browser fires it
  // later. Defer it as a browser does.
  const realBack = window.history.back.bind(window.history);
  backSpy = spyOn(window.history, "back").mockImplementation(() => {
    setTimeout(realBack, 0);
  });
  const view = await bootPhone();
  await click(view.baseElement.querySelector("button[data-show-sidebar]"));
  const drawer = () => view.baseElement.querySelector("[data-phone-sidebar]");
  expect(drawer()).not.toBeNull();
  await click(showButton(view, "r2", "[data-phone-sidebar]"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect({
    drawer: drawer() !== null,
    room: activeRoom(view),
    entry: window.history.state,
  }).toEqual({ drawer: false, room: "r2", entry: LOAD_ENTRY });
});
