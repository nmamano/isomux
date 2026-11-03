// The store keeps the elevator panel in step with this office's floors (task
// 42be5397): full_state and floors_updated write this office's snapshot from
// the live floors, so a ride carries them. The panel rules themselves are
// pinned in shared/elevator-panel.test.ts and ui/elevator-panel-store.dom.test.ts;
// this file pins only that the WebSocket messages reach them.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
setUpDomTestFile();
const { act, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { connect, setShim, shimEmit } = await import("./ws.ts");
const { readPanel } = await import("./elevator-panel-store.ts");

import type { Floor } from "../shared/floors.ts";

const noop = () => {};
setApiShim(async () => ({}));
afterAll(() => {
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});

const floor = (url: string): Floor => ({
  id: url,
  url,
  name: null,
  addedAt: 1,
});

it("writes this office's snapshot from full_state and again from floors_updated", () => {
  localStorage.clear();
  setShim(noop);
  const view = render(createElement(StoreProvider, null, null));
  const here = location.origin;
  const snapshotOfHere = () =>
    readPanel().snapshots.find((s) => s.origin === here)?.floors;
  act(() => {
    shimEmit({
      type: "full_state",
      agents: [],
      rooms: [],
      office: { name: "Panel test", prompt: null },
      recentCwds: [],
      killedAgents: [],
      interactions: [],
      floors: [floor("https://a.example.com")],
    });
  });
  expect(readPanel().visited.map((v) => v.url)).toEqual([here]);
  expect(snapshotOfHere()).toEqual(["https://a.example.com"]);
  act(() => {
    shimEmit({
      type: "floors_updated",
      floors: [floor("https://b.example.com")],
    });
  });
  expect(snapshotOfHere()).toEqual(["https://b.example.com"]);
  view.unmount();
});
