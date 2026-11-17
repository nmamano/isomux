// The Office and Storage panes keep their layout while the demo's answers
// load (task 69c5f413, the UI rule in AGENTS.md). The demo office is the one
// a visitor and the loading check see, so its answers must have the shape a
// real office's have: GET /api/office/settings with every switch the real
// server sends (a pane draws no switch for a field the server omits), and a
// cleanup that ran (the held view reserves its last-run line).
//
// happy-dom lays nothing out: blockShape compares the block tree held with
// the tree once every answer arrived.
//
// Seam: the panes over demoApi, behind a gate that holds every answer.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import { blockShape } from "./test-support/held-shape.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { OfficePane } = await import("./components/OfficePane.tsx");
const { StoragePane } = await import("./components/StoragePane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { demoApi } = await import("./demo-server.ts");

// Every demo answer waits until `release` runs; later ones go at once.
function holdDemo() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  let answered = 0;
  setApiShim(async (method, path, body) => {
    asked++;
    await gate;
    const answer = await demoApi(method, path, body);
    answered++;
    return answer;
  });
  return {
    release: () => release(),
    asked: () => asked,
    answered: () => answered,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => setApiShim(null));

describe("the demo's Settings panes while their answers load", () => {
  for (const [name, pane] of [
    ["Office", OfficePane],
    ["Storage", StoragePane],
  ] as const) {
    it(`${name} draws the layout of the demo's answers`, async () => {
      window.localStorage.clear();
      const gate = holdDemo();
      const view = render(onLanguage(null, createElement(pane)));
      await settle();
      // Every read is out and none answered.
      expect(gate.asked()).toBeGreaterThan(0);
      expect(gate.answered()).toBe(0);
      const held = blockShape(view.container);
      await act(async () => gate.release());
      await settle();
      expect(gate.answered()).toBe(gate.asked());
      expect(blockShape(view.container)).toBe(held);
    });
  }
});
