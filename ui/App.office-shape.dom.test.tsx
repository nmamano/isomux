// The office while it loads (task ea29a8e2): until the first full_state, the
// tab bar and the room scene draw dim placeholders in the shape this device
// last drew - a tab per stored tab width, the online chip and the tucked chip
// at their widths, and per stored desk a desk placeholder with its name tag
// box - and full_state replaces them all. Hooks and setup:
// ui/test-support/office-shape-fixture.tsx. The parse is in
// ui/office-shape.test.ts; the real layout (the widths matching) is the
// loading check's (scripts/loading-check.sh --warm).

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { setUpChatSidebarTests } =
  await import("./test-support/chat-sidebar-fixture.tsx");
const {
  SHAPE,
  SHAPE_KEY,
  all,
  drawn,
  expected,
  frame,
  fullState,
  mount,
  one,
  presence,
  selfFrame,
  sessionContext,
  store,
  tabIds,
} = await import("./test-support/office-shape-fixture.tsx");
const { OFFICE_SHAPE_DEFAULT } = await import("./office-shape.ts");

setUpChatSidebarTests();

const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

it("before full_state draws the stored shape: a tab per width, both chips, a desk placeholder per desk; full_state replaces them all", async () => {
  store(SHAPE);
  const view = await mount();
  await frame(sessionContext);

  expect(drawn(view)).toEqual(expected(SHAPE));
  // Placeholders only: hidden from assistive tech, nothing to click, no real
  // tab, no desk.
  for (const el of all(
    view,
    "[data-room-tab-placeholder], [data-online-placeholder], [data-tucked-placeholder]",
  )) {
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelectorAll("button, a, input, [tabindex]").length).toBe(0);
  }
  expect(all(view, "[data-room-tab-button]").length).toBe(0);
  expect(all(view, "[data-desk-tag]").length).toBe(0);
  // The tab placeholders sit after the Lobby tab and before the online chip.
  const lobby = one(view, "[data-lobby-tab]")!;
  const chip = one(view, "[data-online-placeholder]")!;
  for (const el of all(view, "[data-room-tab-placeholder]")) {
    expect(follows(lobby, el)).toBe(true);
    expect(follows(el, chip)).toBe(true);
  }

  // The member's own record does not end the wait; full_state does: the real
  // bar and desks, no placeholder left.
  await frame(selfFrame(["r3"]));
  expect(drawn(view)).toEqual(expected(SHAPE));
  await frame(fullState);
  expect(all(view, "[data-room-tab-placeholder]").length).toBe(0);
  expect(all(view, "[data-online-placeholder]").length).toBe(0);
  expect(all(view, "[data-tucked-placeholder]").length).toBe(0);
  expect(all(view, "[data-desk-placeholder]").length).toBe(0);
  expect(tabIds(view)).toEqual(["r1", "r2"]);
  expect(one(view, "[data-tucked-chip]")).not.toBeNull();
  expect(
    all(view, "[data-desk-tag]")
      .map((el) => el.getAttribute("data-desk-tag"))
      .sort(),
  ).toEqual(["0", "1"]);
  await frame(presence);
  expect(one(view, "[data-online-chip]")).not.toBeNull();
});

it("with a broken stored value draws the default shape, without an error", async () => {
  for (const raw of [
    "{not json",
    JSON.stringify({ ...SHAPE, desks: [{ desk: 0, w: -1, h: 1 }] }),
  ]) {
    window.localStorage.setItem(SHAPE_KEY, raw);
    const view = await mount();
    await frame(sessionContext);
    expect(drawn(view), raw.slice(0, 20)).toEqual(
      expected(OFFICE_SHAPE_DEFAULT),
    );
    view.unmount();
  }
});
