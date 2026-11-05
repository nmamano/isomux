// The view the first frame draws, before any server message (task 4843a124):
// the store opens on the lobby when the load is an elevator ride, or when
// this browser's last saved view is the lobby or there is none. The restore
// after full_state then lands on the same view (ui/App.ride-lobby.dom.test.tsx
// follows one load frame by frame), so nothing switches when the state arrives.

import { beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider, FeaturesProvider, useAppState } =
  await import("./store.tsx");
const { saveView } = await import("./view-persistence.ts");
const { setShim } = await import("./ws.ts");
const { DEMO_FEATURES, PRODUCTION_FEATURES } =
  await import("../shared/features.ts");

beforeEach(() => {
  window.localStorage.clear();
  // No server: the store's connect() fires no message.
  setShim(
    () => {},
    () => {},
  );
});

function firstLobbyOpen(ride: boolean, features = PRODUCTION_FEATURES) {
  const frames: boolean[] = [];
  function Probe() {
    frames.push(useAppState().lobbyOpen);
    return null;
  }
  render(
    createElement(FeaturesProvider, {
      features,
      children: createElement(StoreProvider, {
        ride,
        children: createElement(Probe),
      }),
    }),
  );
  return frames[0];
}

const savedRoom = (lobby: boolean) =>
  saveView("member", { roomId: "r2", agentId: null, panel: null, lobby });

for (const [name, setUp, ride, features, open] of [
  [
    "a ride over a saved room",
    () => savedRoom(false),
    true,
    PRODUCTION_FEATURES,
    true,
  ],
  ["a ride in an office with no LLM", () => {}, true, DEMO_FEATURES, true],
  [
    "a normal load with no saved view",
    () => {},
    false,
    PRODUCTION_FEATURES,
    true,
  ],
  [
    "a normal load with the lobby saved",
    () => savedRoom(true),
    false,
    PRODUCTION_FEATURES,
    true,
  ],
  [
    "a normal load with a room saved",
    () => savedRoom(false),
    false,
    PRODUCTION_FEATURES,
    false,
  ],
  // No LLM (the demo) runs no restore, so a guessed lobby would never close.
  ["a normal load with no LLM", () => {}, false, DEMO_FEATURES, false],
] as const) {
  it(`opens ${open ? "the lobby" : "a room"} on ${name}`, () => {
    setUp();
    expect(firstLobbyOpen(ride, features)).toBe(open);
  });
}
