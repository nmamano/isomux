// Install the office as an app (tasks 5d536d33, 55310a37). In a phone or
// tablet browser that can install the office, the office view shows a notice
// until the member closes it or installs from it: on Chrome its Install
// button calls the held beforeinstallprompt event, on iPhone it shows the
// Share > Add to Home Screen steps. The phone menu keeps an "Install as app"
// item after the notice is gone. Where it shows:
// office-install-devices.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { fireEvent, act } = await import("@testing-library/react");
const { heldInstallPrompt } = await import("../app-install.ts");
const {
  asChrome,
  installEvent,
  IPHONE_SAFARI,
  mount,
  onDevice,
  setUpOfficeInstallFile,
} = await import("../test-support/office-install-fixture.tsx");
setUpOfficeInstallFile();

it("shows the iPhone steps until the member closes them, and the menu reopens them", () => {
  onDevice(IPHONE_SAFARI);
  let page = mount();
  const notice = page.notice();
  expect(notice).not.toBeNull();
  expect(notice!.dataset.officeInstallNotice).toBe("steps");
  expect(notice!.textContent.trim()).not.toBe("");
  // The Share icon is drawn, not a glyph: iOS draws glyphs as emoji.
  expect(notice!.querySelector("svg")).not.toBeNull();
  // Steps only: Safari has no install dialog to call.
  expect(notice!.querySelectorAll("button")).toHaveLength(1);
  // Nil, 2026-10-23: going into a chat and back is no dismiss.
  page = mount();
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
  page = mount();
  expect(page.notice()).toBeNull();
  // The menu still offers it, and opens the steps although closed.
  const item = page.menuItem();
  expect(item).not.toBeNull();
  fireEvent.click(item!);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
  // The menu opens them again after a dismiss.
  fireEvent.click(page.menuItem()!);
  expect(page.notice()?.dataset.officeInstallNotice).toBe("steps");
  fireEvent.click(page.dismiss()!);
  expect(page.notice()).toBeNull();
});

it("waits for Chrome's event on Android, installs with it, and then offers nothing", async () => {
  asChrome();
  const page = mount();
  // No event yet: Chrome may not offer one at all.
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  const notice = page.notice();
  expect(notice?.dataset.officeInstallNotice).toBe("prompt");
  const install = [...notice!.querySelectorAll("button")].find(
    (b) => !b.hasAttribute("data-office-install-dismiss"),
  );
  expect(install).toBeDefined();
  expect(page.dismiss()).not.toBeNull();
  await act(async () => {
    fireEvent.click(install!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  // A used event cannot prompt again.
  expect(heldInstallPrompt()).toBeNull();
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});

// The member acted on the notice, whatever they chose in Chrome's dialog.
// Chrome can offer a new event on a later visit: the phone menu installs with
// it. Closing the notice puts it away the same way (the iPhone test).
it("does not show the notice again after its Install button, and the menu installs with a new event", async () => {
  asChrome();
  let page = mount();
  await act(async () => {
    window.dispatchEvent(installEvent("dismissed").event);
  });
  const install = [...page.notice()!.querySelectorAll("button")].find(
    (b) => !b.hasAttribute("data-office-install-dismiss"),
  );
  await act(async () => {
    fireEvent.click(install!);
  });
  page = mount();
  const { event, prompt } = installEvent();
  await act(async () => {
    window.dispatchEvent(event);
  });
  // The condition: the new event is held, and the menu offers it.
  expect(heldInstallPrompt() === event).toBe(true);
  expect(page.notice()).toBeNull();
  const item = page.menuItem();
  expect(item).not.toBeNull();
  await act(async () => {
    fireEvent.click(item!);
  });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(page.notice()).toBeNull();
  expect(page.menuItem()).toBeNull();
});
