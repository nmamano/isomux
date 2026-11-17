// The demo's Integrations tabs keep their layout while the demo's answers
// load (task da868bd9, the UI rule in AGENTS.md). The demo is what a visitor
// and scripts/loading-check.sh see on a first visit: at boot the demo seeds
// each held layout from its own data (seedDemoHeldLayouts), so a held card
// draws the shape the answers then bring, and the layout each card writes
// once loaded is the one the seed wrote.
//
// happy-dom lays nothing out: blockShape compares each card's block tree held
// with its tree once every answer arrived, with the Reserved wrappers taken
// out (a wrapper adds no box of its own).
//
// Seam: the page over demoApi on a live store (the cards read their accounts
// and messaging state from it), behind a gate that holds every answer.

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { blockShape } from "../test-support/held-shape.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement, useReducer } = await import("react");
const { setApiShim } = await import("../api.ts");
const { demoApi, seedDemoHeldLayouts } = await import("../demo-server.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { IntegrationsView } = await import("./IntegrationsView.tsx");
const { OWNER } = await import("../test-support/integrations-page-fixture.ts");
const {
  getDiscordLayout,
  getMemberUsageLayout,
  getPagerLayout,
  getProviderLayout,
} = await import("../device-settings.ts");

type Tab = import("../../shared/office-links.ts").IntegrationsTab;

// The demo's member is Ricky, an owner.
function Page({ tab }: { tab: Tab }) {
  const [state, dispatch] = useReducer(reducer, OWNER);
  return createElement(
    DispatchCtx.Provider,
    { value: dispatch },
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(IntegrationsView, { onClose: () => {}, request: { tab } }),
    ),
  );
}

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
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

// Each card's block shape, with each Reserved wrapper replaced by its
// children.
function shapes(root: Element): Record<string, string> {
  const copy = root.cloneNode(true) as Element;
  for (const wrapper of [...copy.querySelectorAll("[data-reserved]")].reverse())
    wrapper.replaceWith(...wrapper.childNodes);
  const out: Record<string, string> = {};
  for (const card of copy.querySelectorAll("[data-integrations-card]"))
    out[card.getAttribute("data-integrations-card")!] = blockShape(card);
  return out;
}

const layouts = () => ({
  discord: getDiscordLayout(),
  memberUsage: getMemberUsageLayout(),
  pager: getPagerLayout(),
  provider: getProviderLayout(),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => setApiShim(null));

describe("the demo's Integrations tabs while their answers load", () => {
  for (const tab of ["providers", "messaging", "pager"] as const) {
    it(`${tab}: each card holds the layout of the demo's answers, and its held content paints`, async () => {
      window.localStorage.clear();
      seedDemoHeldLayouts();
      const seeded = layouts();
      const gate = holdDemo();
      const view = render(createElement(Page, { tab }));
      await settle();
      // Every read is out and none answered.
      expect(gate.asked()).toBeGreaterThan(0);
      expect(gate.answered()).toBe(0);
      const main = view.container;
      const held = shapes(main);
      // A held line paints, dimmed: a hidden one is an empty box that the
      // answer fills (AGENTS.md UI rules).
      const hidden = [
        ...main.querySelectorAll<HTMLElement>("[data-reserved]"),
      ].filter((node) => node.style.visibility === "hidden").length;
      await act(async () => gate.release());
      await settle();
      expect(gate.answered()).toBe(gate.asked());
      expect({
        hidden,
        held,
        stillHeld: main.querySelectorAll("[data-reserved]").length,
        // What the loaded cards remember is what the seed said.
        layouts: seeded,
      }).toEqual({
        hidden: 0,
        held: shapes(main),
        stillHeld: 0,
        layouts: layouts(),
      });
    });
  }
});
