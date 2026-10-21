// The room turn is wired to the wall doors only (task fee198a0): a door to
// the next room starts it, a switch from elsewhere (a tab) never does, and
// leaving the office mid-turn removes it.
import { afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent } = fixture;
const { setRoomTurn } = await import("../device-settings.ts");
fixture.setupRoomDoorTests({ decorations: false });
afterEach(() => setRoomTurn("off"));

/** Lets the turn's first frame run, so its snapshots are in place. */
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const snapshots = (root: HTMLElement) =>
  root.querySelectorAll('[inert][aria-hidden="true"]').length;

it("a wall door turns the room, and a tab switch does not", async () => {
  const view = mount([room("first"), room("second"), room("third")]);
  setRoomTurn("turn-600");
  const before = snapshots(view.container);
  const door = view.container.querySelector('svg g[aria-label="second"]')!;
  await act(async () => fireEvent.click(door));
  await act(nextFrame);
  expect(fixture.snapshot.currentRoomId).toBe("second");
  expect(snapshots(view.container)).toBe(before + 2);
  // A tab click is a plain switch: it ends the running turn, starts none.
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "third" }),
  );
  await act(nextFrame);
  expect(fixture.snapshot.currentRoomId).toBe("third");
  expect(snapshots(view.container)).toBe(before);
  view.unmount();
});

it("leaving the office mid-turn removes the turn", async () => {
  const view = mount([room("first"), room("second")]);
  setRoomTurn("turn-600");
  const before = snapshots(view.container);
  const parent = view.container;
  await act(async () =>
    fireEvent.click(
      view.container.querySelector('svg g[aria-label="second"]')!,
    ),
  );
  await act(nextFrame);
  expect(snapshots(parent)).toBe(before + 2);
  const live = [...parent.querySelectorAll<HTMLElement>("[style]")].filter(
    (el) => el.style.opacity === "0",
  );
  view.unmount();
  expect(document.querySelectorAll('[inert][aria-hidden="true"]').length).toBe(
    0,
  );
  for (const el of live) expect(el.style.opacity).toBe("");
});
