// The demo's Settings rows and Access card keep their layout while the
// demo's answers load (task a25b1c0a, the UI rule in AGENTS.md). The demo
// answers as a Hosted office would (no Enterprise box) and with external
// access off, but it is served from a public https origin that is not
// isomux.app, where a first visit guesses the other way. At boot the demo
// seeds both held layouts from its own answers (seedDemoHeldLayouts).
//
// Seam: the Enterprise row hook and the Access pane over demoApi, at the
// shipped demo's address.

import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, cleanup, render } = await import("@testing-library/react");
const { createElement, Fragment } = await import("react");
const { setApiShim } = await import("../api.ts");
const { demoApi, seedDemoHeldLayouts } = await import("../demo-server.ts");
const { useEnterpriseAvailable } =
  await import("./EnterpriseContractSection.tsx");
const { ExternalAccessPane } = await import("./ExternalAccessPane.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { getEnterpriseLayout, getExternalAccessLayout } =
  await import("../device-settings.ts");

const setURL = (url: string) =>
  (
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL(url);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setURL("http://localhost/");
});
afterAll(() => setApiShim(null));

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

it("the demo's first visit draws the Enterprise row and the Access card as the demo answers them", async () => {
  setURL("https://isomux.com/demo/");
  window.localStorage.clear();
  const enterprise = (await demoApi("GET", "/api/office/enterprise")) as {
    available: boolean;
  };
  const access = (await demoApi("GET", "/api/office/access")) as {
    hosted: boolean;
    externalAccess: boolean;
  };
  // What makes this case bite: with nothing stored, this origin's guess is
  // not what the demo answers.
  expect({
    available: getEnterpriseLayout().available,
    access: getExternalAccessLayout(),
  }).not.toEqual({
    available: enterprise.available,
    access: { hosted: access.hosted, enabled: access.externalAccess },
  });

  seedDemoHeldLayouts();
  const seeded = {
    enterprise: getEnterpriseLayout(),
    access: getExternalAccessLayout(),
  };
  const answered: string[] = [];
  setApiShim(async (method, path, body) => {
    const answer = await demoApi(method, path, body);
    answered.push(`${method} ${path}`);
    return answer;
  });
  // Every value the Settings sidebar's Enterprise row took, held and loaded.
  const rows: boolean[] = [];
  function EnterpriseRow() {
    rows.push(useEnterpriseAvailable(true));
    return null;
  }
  render(
    onLanguage(
      null,
      createElement(
        Fragment,
        null,
        createElement(EnterpriseRow),
        createElement(ExternalAccessPane),
      ),
    ),
  );
  await settle();

  expect({
    rows: [...new Set(rows)],
    // What the loaded row and card store is what the seed held.
    seeded,
  }).toEqual({
    rows: [enterprise.available],
    seeded: {
      enterprise: getEnterpriseLayout(),
      access: getExternalAccessLayout(),
    },
  });
  // Both reads answered, so the stored layouts above are the loaded ones.
  expect(answered).toContain("GET /api/office/enterprise");
  expect(answered).toContain("GET /api/office/access");
});
