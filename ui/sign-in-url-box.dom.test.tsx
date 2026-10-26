// The box that shows a freshly minted sign-in URL (access-shared's
// MintedUrlBox) words itself for who opens the link. A link the member mints
// for their own device (Sign-in links, and External access after a bind
// change) is not an invite: it must not say "invite" or tell them to send it
// to an invitee. A link an owner mints for another member (Invites) keeps the
// invite wording.
//
// Each case first proves the box is on screen by its URL, so an absent label
// means the wording changed, not that nothing rendered. Copy is matched by
// catalog value, never by literal text.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";
import type { MessageKey, ParamsFor } from "../shared/i18n/translate.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { MyDevicesPane } = await import("./components/MyDevicesPane.tsx");
const { InvitesPane } = await import("./components/InvitesPane.tsx");
const { ExternalAccessPane } =
  await import("./components/ExternalAccessPane.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { translatorFor } = await import("../shared/i18n/translate.ts");
const { createElement } = await import("react");

type View = ReturnType<typeof render>;

const URL_SELF = "https://office.example.com/invite/self-token";
const URL_OTHER = "https://office.example.com/invite/other-token";
const URL_RESTART = "https://office.example.com/invite/restart-token";

const INVITE = {
  tokenPrefix: "ab12cd34",
  username: "Tester",
  role: "owner" as const,
  createdBy: "u1",
  createdAt: 0,
  expiresAt: 3_600_000,
};

setApiShim(async (method, path) => {
  if (method === "POST" && path === "/api/invites/self")
    return { url: URL_SELF, invite: INVITE };
  if (method === "POST" && path === "/api/invites")
    return { url: URL_OTHER, invite: INVITE };
  if (method === "GET" && path === "/api/office/access")
    return {
      externalAccess: false,
      publicOrigin: null,
      boundLoopback: true,
      hosted: false,
    };
  if (method === "PUT" && path === "/api/office/access")
    return { signInUrl: URL_RESTART, restartRequired: true };
  throw new Error(`no shim for ${method} ${path}`);
});
afterAll(() => setApiShim(null));

// English: the defect Nil saw. Catalog parity across languages is
// shared/i18n/catalog.test.ts's job.
function en<K extends MessageKey>(key: K, ...params: ParamsFor<K>): string {
  return translatorFor("en").t(key, ...params);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const mount = (pane: () => ReturnType<typeof createElement>) =>
  render(
    onLanguage(null, pane(), {
      invitesLoaded: true,
      activeSessionsLoaded: true,
    }),
  );

/** The button whose text is exactly `label`. */
function button(view: View, label: string): HTMLButtonElement {
  const found = view
    .getAllByText(label)
    .map((el) => el.closest("button"))
    .find((el): el is HTMLButtonElement => el !== null);
  if (!found) throw new Error(`no button reads ${label}`);
  return found;
}

const count = (view: View, text: string) => view.queryAllByText(text).length;

/** A box for the caller's own device: sign-in wording, no invite wording. */
function expectSelfWording(view: View, url: string): void {
  expect(count(view, url), "minted URL on screen").toBe(1);
  expect(count(view, en("settings.access.inviteUrl")), "invite label").toBe(0);
  expect(count(view, en("settings.access.sendUrl")), "invitee hint").toBe(0);
  expect(count(view, en("settings.access.signInUrl")), "sign-in label").toBe(1);
  expect(count(view, en("settings.access.openUrlSelf")), "self hint").toBe(1);
}

describe("the minted sign-in URL box", () => {
  it("on Sign-in links, reads as the member's own sign-in URL", async () => {
    const view = mount(() => createElement(MyDevicesPane));
    expect(count(view, URL_SELF), "no URL before Generate").toBe(0);
    fireEvent.click(button(view, en("settings.devices.generate")));
    await settle();
    expectSelfWording(view, URL_SELF);
    view.unmount();
  });

  it("on External access after a restart-bound save, reads as the owner's own sign-in URL", async () => {
    const view = mount(() => createElement(ExternalAccessPane));
    await settle();
    const enable = view
      .getByText(en("settings.externalAccess.enable"))
      .closest("label")
      ?.querySelector("input");
    if (!enable) throw new Error("no enable checkbox");
    fireEvent.click(enable);
    expect(enable.checked, "external access enabled").toBe(true);
    const origin = view.getByPlaceholderText("https://office.example.com");
    fireEvent.change(origin, {
      target: { value: "https://office.example.com" },
    });
    expect(count(view, URL_RESTART), "no URL before Save").toBe(0);
    fireEvent.click(button(view, en("common.save")));
    await settle();
    expectSelfWording(view, URL_RESTART);
    view.unmount();
  });

  it("on Invites, keeps the invite wording for a link sent to another member", async () => {
    const view = mount(() => createElement(InvitesPane));
    const select = view.container.querySelector("select");
    if (!select) throw new Error("no member select");
    fireEvent.change(select, { target: { value: "u1" } });
    expect(select.value, "member picked").toBe("u1");
    fireEvent.click(button(view, en("settings.invites.createLink")));
    await settle();
    expect(count(view, URL_OTHER), "minted URL on screen").toBe(1);
    expect(count(view, en("settings.access.inviteUrl")), "invite label").toBe(
      1,
    );
    expect(count(view, en("settings.access.sendUrl")), "invitee hint").toBe(1);
    expect(count(view, en("settings.access.signInUrl")), "sign-in label").toBe(
      0,
    );
    expect(count(view, en("settings.access.openUrlSelf")), "self hint").toBe(0);
    view.unmount();
  });
});
