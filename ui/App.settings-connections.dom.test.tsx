// The two Connections sections point at each other, and the pointers move the
// page. Office-wide and Individual are the same pane with opposite scopes, and
// the override rule (individual beats office-wide) only means something if a
// reader can get from one to the other - which is why the sign-in card's
// sentence and the foot of each pane carry a link instead of naming a section
// the reader then has to find.
//
// Its own file because it mounts the settings detail pane twice and the 5 s cap
// is per file. The sidebar's own rows are covered by the screenshots and by
// ui/store.test.ts; what is worth a test here is that CLICKING moves the page.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

// The detail pane mounts useMemoryEditor, which GETs /api/memory and reads
// `text` off the response; the pane itself reads `accounts`.
setApiShim(async (_method, path) =>
  path.startsWith("/api/memory")
    ? { text: "", version: "0", size: 0, cap: 4000 }
    : path.startsWith("/api/me/provider-accounts")
      ? { accounts: [] }
      : {},
);
afterAll(() => setApiShim(null));

const SIGNED_IN = {
  ...initialState,
  hasReceivedInitialState: true,
  sessionContext: { username: "Ricky", userId: "u1", role: "owner" },
  users: new Map([
    [
      "ricky",
      {
        id: "u1",
        name: "Ricky",
        allowedRooms: [],
        notifRooms: [],
        hidden: [],
        order: [],
        envFile: null,
        memberPrompt: null,
        language: null,
        avatarColor: "#4A90D9",
        avatarVariant: 0,
        role: "owner",
      },
    ],
  ]),
} as unknown as typeof initialState;

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});

/** Which pane the detail area is showing: the h4 each one titles itself with. */
const paneHeading = (view: View, name: string) =>
  view.queryByRole("heading", { name, level: 4 });

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
}

describe("the connections cross-links", () => {
  it("carries the reader from each section to the other", async () => {
    const view = render(
      createElement(
        StateCtx.Provider,
        { value: SIGNED_IN },
        createElement(App, {}),
      ),
    );

    await click(view.getByRole("button", { name: "Office-wide connections" }));
    expect(paneHeading(view, "Office-wide connections")).not.toBeNull();
    expect(paneHeading(view, "Individual connections")).toBeNull();

    // The link inside a sign-in card's sentence, not the sidebar row of the
    // same name: the sidebar would move the page whether the card links or
    // not, so clicking it would prove nothing.
    const inCard = view
      .getAllByRole("button", { name: "Individual connections" })
      .find((el) =>
        el.parentElement?.textContent?.startsWith("This subscription is used"),
      );
    expect(inCard).toBeDefined();
    await click(inCard!);

    expect(paneHeading(view, "Individual connections")).not.toBeNull();
    expect(paneHeading(view, "Office-wide connections")).toBeNull();

    // And back, by the pointer at the foot of the pane.
    await click(
      view.getByRole("button", { name: "Office → Office-wide connections" }),
    );

    expect(paneHeading(view, "Office-wide connections")).not.toBeNull();
    expect(paneHeading(view, "Individual connections")).toBeNull();
  });
});
