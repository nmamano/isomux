// The office notice in another app's browser (task 149f9eac): "Get a sign-in
// link" opens Settings > New device through the real App, and that door shows
// the link to copy with no QR code (Nil, 2026-11-23: the member opens it in
// their browser on the same phone). The sidebar's New device row keeps the
// QR: ui/new-device-pane.dom.test.tsx.
import { afterAll, afterEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent, render } = await import("@testing-library/react");
const { App } = await import("./App.tsx");
const { setApiShim } = await import("./api.ts");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { asDevice } = await import("./test-support/ios-home-screen.ts");
const { IOS_UA, iphoneWith } = await import("./test-support/ios-browsers.ts");
const { en } = await import("../shared/i18n/en.ts");

const LINK = "https://office.example/i/one-time";
let mints = 0;
setApiShim(async (method, path) => {
  if (method === "POST" && path === "/api/invites/self") {
    mints++;
    return { url: LINK, invite: {} };
  }
  if (path.startsWith("/api/memory"))
    return { text: "", version: "0", size: 0, cap: 4000 };
  if (path === "/api/removed-members") return { members: [] };
  return {};
});
afterAll(() => setApiShim(null));
let undoDevice = () => {};
afterEach(() => {
  undoDevice();
  undoDevice = () => {};
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("opens New device from the office notice with the link to copy and no QR code", async () => {
  undoDevice = asDevice(iphoneWith(IOS_UA.facebook));
  window.history.replaceState(null, "", "/");
  const view = render(
    onLanguage("en", <App />, {
      hasReceivedInitialState: true,
      connected: true,
      isMobile: true,
      lobbyOpen: false,
      invitesLoaded: true,
      activeSessionsLoaded: true,
    }),
  );
  const notice = view.baseElement.querySelector<HTMLElement>(
    "[data-office-install-notice]",
  );
  // The condition: another app's browser, signed in, so the notice offers a
  // sign-in link.
  expect(notice?.dataset.officeInstallNotice).toBe("browser");
  const signIn = notice!.querySelector<HTMLButtonElement>(
    '[data-browser-install="sign-in"]',
  );
  expect(signIn).not.toBeNull();
  await act(async () => {
    fireEvent.click(signIn!);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(window.location.pathname).toBe("/settings");
  expect(mints).toBe(1);
  const text = view.baseElement.textContent ?? "";
  // The link is there to copy.
  expect(text).toContain(LINK);
  expect(
    view.baseElement.querySelectorAll("[data-device-qr]").length,
    "no QR code",
  ).toBe(0);
  expect(text).toContain(en["settings.devices.browserHint"]);
  expect(text).not.toContain(en["settings.devices.newDeviceHint"]);
  view.unmount();
});
