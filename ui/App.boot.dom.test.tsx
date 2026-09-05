// A load on a path that is no route at all. The office is "/", so the address
// bar is normalised in place rather than left showing the office at /garbage.
//
// The saved spot is in ui/App.saved-spot.dom.test.tsx, a deployment with
// routing switched off in ui/App.no-routing.dom.test.tsx, and arriving ON a
// page path in ui/App.deeplink.dom.test.tsx.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The settings and cronjobs pages fetch when they mount; without the shim
// happy-dom opens real sockets to localhost.
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** Load the app as if the browser had just arrived on `path`. */
function mountAt(path: string): View {
  window.history.replaceState(null, "", path);
  return render(createElement(App, {}));
}

// The office is the only view that renders the nav bar.
const officeShowing = (view: View) => view.queryByTitle("Tasks") !== null;

describe("a path that is not a route", () => {
  it("shows the office and normalises the address bar to /", () => {
    const view = mountAt("/garbage");

    expect(officeShowing(view)).toBe(true);
    expect(window.location.pathname).toBe("/");
  });
});
