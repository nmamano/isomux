// Restoring a page from history lands on the page and nothing more. Settings
// sections are not routes (ruling 3 of internal-docs/url-routing-loop.md), so
// the entry names the page alone and a Forward into settings must not resurrect
// whichever row was open on the last visit.
//
// Its own file because it renders the settings page twice and the 5 s cap is
// per file; Back and Forward themselves are in ui/App.history.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

async function go(move: "back" | "forward"): Promise<void> {
  await act(async () => {
    window.history[move]();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("restoring the settings page", () => {
  it("forgets which settings row was open when the page is restored", async () => {
    const view = render(createElement(App));

    // The theme button is one of the doors that opens Settings ON a row.
    await act(async () => {
      view.getByTitle("Change theme").click();
    });
    expect(window.location.pathname).toBe("/settings");
    expect(view.queryByText(/Select a setting from the list/)).toBeNull();

    await go("back");
    await go("forward");

    // Sections are not routes (ruling 3), so the entry names the page and
    // nothing else. Restoring it lands on the generic page rather than
    // resurrecting the row from the visit before.
    expect(window.location.pathname).toBe("/settings");
    expect(view.queryByText(/Select a setting from the list/)).not.toBeNull();
  });

});
