// The room turn is wired to the wall doors only (task fee198a0): a door to
// the next room starts it, a switch from elsewhere (a tab) never does, and
// leaving the office mid-turn removes it. The door between the lobby and the
// first room turns too, both ways (task 8f71e886).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const fixture = await import("./room-door-fixture.tsx");
const { mount, room, act, fireEvent } = fixture;
const { en } = await import("../../shared/i18n/en.ts");
fixture.setupRoomDoorTests({ decorations: false });

/** Lets the turn's first frame run, so its snapshots are in place. */
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
// Snapshots are the inert, aria-hidden copies laid over the live scene; an
// inert element inside one is part of that copy, not one more.
const snapshots = (root: HTMLElement) =>
  [...root.querySelectorAll('[inert][aria-hidden="true"]')].filter(
    (el) => !el.parentElement?.closest("[inert]"),
  ).length;
const door = (root: HTMLElement, label: string) => {
  const node = root.querySelector(`svg g[aria-label="${label}"]`);
  expect(node).not.toBeNull();
  return node!;
};

it("a wall door turns the room, and a tab switch does not", async () => {
  const view = mount([room("first"), room("second"), room("third")]);
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "first" }),
  );
  expect(snapshots(view.container)).toBe(0);
  await act(async () => fireEvent.click(door(view.container, "second")));
  await act(nextFrame);
  expect(fixture.snapshot.currentRoomId).toBe("second");
  expect(snapshots(view.container)).toBe(2);
  // A tab click is a plain switch: it ends the running turn, starts none.
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "third" }),
  );
  await act(nextFrame);
  expect(fixture.snapshot.currentRoomId).toBe("third");
  expect(snapshots(view.container)).toBe(0);
  view.unmount();
});

it("the lobby door turns into the first room, and its door turns back", async () => {
  const view = mount([room("first"), room("second")]);
  await act(async () =>
    fixture.dispatch({ type: "set_lobby_open", open: true }),
  );
  expect(snapshots(view.container)).toBe(0);
  await act(async () => fireEvent.click(door(view.container, "first")));
  await act(nextFrame);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  expect(fixture.snapshot.currentRoomId).toBe("first");
  expect(snapshots(view.container)).toBe(2);

  await act(async () =>
    fireEvent.click(door(view.container, en["common.lobby"])),
  );
  await act(nextFrame);
  expect(fixture.snapshot.lobbyOpen).toBe(true);
  expect(snapshots(view.container)).toBe(2);
  // Leaving the lobby by a tab mid-turn is a plain switch.
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "second" }),
  );
  await act(nextFrame);
  expect(fixture.snapshot.lobbyOpen).toBe(false);
  expect(snapshots(view.container)).toBe(0);
  view.unmount();
});

it("leaving the office mid-turn removes the turn", async () => {
  const view = mount([room("first"), room("second")]);
  await act(async () =>
    fixture.dispatch({ type: "set_current_room", roomId: "first" }),
  );
  const parent = view.container;
  await act(async () => fireEvent.click(door(view.container, "second")));
  await act(nextFrame);
  expect(snapshots(parent)).toBe(2);
  const live = [...parent.querySelectorAll<HTMLElement>("[style]")].filter(
    (el) => el.style.opacity === "0",
  );
  expect(live.length).toBeGreaterThan(0);
  view.unmount();
  expect(document.querySelectorAll('[inert][aria-hidden="true"]').length).toBe(
    0,
  );
  for (const el of live) expect(el.style.opacity).toBe("");
});
