// The desktop sidebar's width and its slide (task 5dac6b9b; Nil, 2026-11-12:
// "Drag the edge to resize" and "The room glides with the sidebar"). The
// member drags the sidebar's right edge, 200-440 px; the width is kept on
// this device when the drag ends, and a double-click on the edge resets it
// to 260. Hidden, the sidebar slides out: it stays in place, inert, while
// its slot shrinks, then leaves the page. The room, the top bar and the
// room tab bar sit beside the slot, so they follow it; that, and the look of
// the slide, are checked in a browser. The setup is in
// ui/test-support/chat-sidebar-fixture.tsx; the width rules in
// ui/chat-sidebar.test.ts and ui/device-settings.test.ts.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { getChatSidebarWidth } = await import("./device-settings.ts");
const { boot, click, setUpChatSidebarTests, sidebar } =
  await import("./test-support/chat-sidebar-fixture.tsx");
type View = import("./test-support/chat-sidebar-fixture.tsx").View;

setUpChatSidebarTests();

const KEY = "isomux-chat-sidebar-width";
const slot = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-sidebar-slot]");
const slotWidth = (view: View) => slot(view)?.style.width ?? null;
const resizer = (view: View) =>
  view.container.querySelector<HTMLElement>("[data-sidebar-resizer]");
const anyNav = (view: View) =>
  view.container.querySelector<HTMLElement>("nav[data-chat-sidebar]");
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function pointer(
  el: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent(type, {
        clientX,
        clientY: 300,
        pointerId: 1,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        bubbles: true,
      }),
    );
  });
}

it("starts at 260 px, or at the width this device kept", async () => {
  const first = await boot();
  expect(sidebar(first)).not.toBeNull();
  expect(slotWidth(first)).toBe("260px");
  first.unmount();

  window.localStorage.setItem(KEY, "320");
  const second = await boot();
  expect(slotWidth(second)).toBe("320px");
});

it("a drag of the edge sets the width as it moves, within 200-440, and keeps it on this device only when it ends; a double-click resets to 260", async () => {
  const view = await boot();
  const edge = resizer(view);
  expect(edge).not.toBeNull();

  await pointer(edge!, "pointerdown", 260);
  await pointer(edge!, "pointermove", 330);
  expect(slotWidth(view)).toBe("330px");
  await pointer(edge!, "pointermove", 360);
  expect(slotWidth(view)).toBe("360px");
  // Not kept mid-drag.
  expect(window.localStorage.getItem(KEY)).toBeNull();
  await pointer(edge!, "pointerup", 360);
  expect(getChatSidebarWidth()).toBe(360);

  // Past either end, the width stops there.
  await pointer(edge!, "pointerdown", 360);
  await pointer(edge!, "pointermove", 1200);
  expect(slotWidth(view)).toBe("440px");
  await pointer(edge!, "pointermove", 20);
  expect(slotWidth(view)).toBe("200px");
  await pointer(edge!, "pointerup", 20);
  expect(getChatSidebarWidth()).toBe(200);

  await act(async () => fireEvent.doubleClick(edge!));
  expect(slotWidth(view)).toBe("260px");
  view.unmount();
  const reloaded = await boot();
  expect(slotWidth(reloaded)).toBe("260px");
});

it("hidden, the sidebar slides out: inert while its slot shrinks, then gone; shown again, the slot opens to its width", async () => {
  window.localStorage.setItem(KEY, "300");
  const view = await boot();
  await click(
    view.container.querySelector(
      "nav[data-chat-sidebar] button[data-sidebar-collapse]",
    ),
  );
  // Still on the page for the slide, but closing and inert.
  const closing = anyNav(view);
  expect(closing).not.toBeNull();
  expect({
    closing: closing!.hasAttribute("data-sidebar-closing"),
    inert: closing!.hasAttribute("inert"),
    slot: slotWidth(view),
  }).toEqual({ closing: true, inert: true, slot: "0px" });
  expect(sidebar(view)).toBeNull();

  await wait(300);
  expect(anyNav(view)).toBeNull();

  await click(view.container.querySelector("button[data-show-sidebar]"));
  expect(sidebar(view)).not.toBeNull();
  await wait(50);
  expect(slotWidth(view)).toBe("300px");
  expect(anyNav(view)!.hasAttribute("inert")).toBe(false);
});

it("with reduced motion, the sidebar leaves at once", async () => {
  const saved = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const list = saved.call(window, query);
    Object.defineProperty(list, "matches", {
      value: query.includes("prefers-reduced-motion: reduce"),
    });
    return list;
  }) as typeof window.matchMedia;
  try {
    const view = await boot();
    await click(
      view.container.querySelector(
        "nav[data-chat-sidebar] button[data-sidebar-collapse]",
      ),
    );
    expect(anyNav(view)).toBeNull();
  } finally {
    window.matchMedia = saved;
  }
});
