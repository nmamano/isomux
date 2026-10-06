// Pager settings stay in Settings > You > Pager (task fe0c21fd); the pager view
// links there. A notice says so when the member's settings read answers with
// no Discord destination, and only then: a load or a failed read never claims
// Discord is absent. The empty list links there too.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act } = await import("@testing-library/react");
const { initialState } = await import("../store.tsx");
const { mount, page, setupPagerViewTests, shim } =
  await import("../test-support/pager-view-fixture.tsx");
setupPagerViewTests();

const signedIn = {
  sessionContext: {
    ...initialState.sessionContext,
    userId: "u1",
    username: "Tester",
    role: "member",
  },
} as Partial<typeof initialState>;

type View = Awaited<ReturnType<typeof mount>>["view"];
const notice = (view: View) =>
  view.container.querySelector("[data-pager-discord-unset]");
const links = (view: View) => [
  ...view.container.querySelectorAll<HTMLElement>("[data-pager-settings-link]"),
];

describe("the link to the pager settings", () => {
  it("shows the notice when the read says Discord is not set up, and its link opens the settings", async () => {
    shim.pagerSettings = { webhookUrlMasked: null };
    const { view, settingsOpened } = await mount([page("p1")], signedIn);
    expect(shim.calls).toContain("GET /api/users/Tester/pager-settings");
    expect(notice(view)).not.toBeNull();
    expect(links(view)).toHaveLength(1);
    await act(async () => links(view)[0].click());
    expect(settingsOpened).toHaveLength(1);
  });

  it("shows no notice when Discord is set up, while the read is out, or when it fails", async () => {
    shim.pagerSettings = { webhookUrlMasked: "https://discord.com/…/abcd" };
    const set = await mount([page("p1")], signedIn);
    expect(notice(set.view)).toBeNull();
    set.view.unmount();

    shim.pagerSettings = "hold";
    const loading = await mount([page("p1")], signedIn);
    expect(notice(loading.view)).toBeNull();
    loading.view.unmount();

    shim.pagerSettings = "fail";
    const failed = await mount([page("p1")], signedIn);
    expect(notice(failed.view)).toBeNull();
  });

  it("the empty list links to the settings once, whether or not Discord is set up", async () => {
    shim.pagerSettings = { webhookUrlMasked: "https://discord.com/…/abcd" };
    const set = await mount([], signedIn);
    expect(notice(set.view)).toBeNull();
    expect(links(set.view)).toHaveLength(1);
    await act(async () => links(set.view)[0].click());
    expect(set.settingsOpened).toHaveLength(1);
    set.view.unmount();

    // Not set up: the notice carries the one link.
    shim.pagerSettings = { webhookUrlMasked: null };
    const unset = await mount([], signedIn);
    expect(notice(unset.view)).not.toBeNull();
    expect(links(unset.view)).toHaveLength(1);
  });
});
