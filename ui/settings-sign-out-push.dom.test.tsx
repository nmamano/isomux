// Sign-out forgets this device for the pager's pushes (Lead ruling, b1054).
//
// Pins: with notifications on in this browser, Sign out removes this device
// from the member's list and unsubscribes it, both before the session ends,
// so the lock screen stops showing the member's pages; with no
// subscription, Sign out only ends the session; a device removal that fails
// still lets the sign-out go.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { UserSettingsView } = await import("./components/UserSettingsView.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");
const { setApiShim } = await import("./api.ts");
const { createElement } = await import("react");
const { pushDeviceId } = await import("../shared/web-push.ts");
const { settingsReportsApi } =
  await import("./test-support/settings-reports-fixture.ts");

const ENDPOINT = "https://web.push.apple.com/this-phone";
const DEVICE_ID = await pushDeviceId(ENDPOINT);
const SESSION = "DELETE /api/sessions/current";
const DEVICE = `DELETE /api/users/Tester/push-devices/${DEVICE_ID}`;

const events: string[] = [];
let failDevice = false;
let hasSub = true;

setApiShim(async (method, path, body) => {
  if (method === "DELETE") {
    events.push(`${method} ${path}`);
    if (failDevice && path.includes("/push-devices/")) {
      throw new Error("unavailable");
    }
    return undefined;
  }
  return settingsReportsApi(method, path, body);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  events.length = 0;
  failDevice = false;
  hasSub = true;
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () =>
            hasSub
              ? {
                  endpoint: ENDPOINT,
                  unsubscribe: async () => {
                    events.push("unsubscribe");
                    return true;
                  },
                }
              : null,
        },
      }),
    },
  });
});

async function signOut() {
  const view = render(
    onLanguage(
      null,
      createElement(UserSettingsView, {
        onSwitchUser: () => {},
        onClose: () => {},
      }),
    ),
  );
  const button = view
    .getAllByRole("button")
    .find((el) => el.textContent?.trim() === "Sign out");
  expect(button).toBeDefined();
  await act(async () => {
    fireEvent.click(button!);
  });
  view.unmount();
}

describe("sign out and this device's pushes", () => {
  it("removes and unsubscribes this device before the session ends", async () => {
    await signOut();
    expect(events).toEqual([DEVICE, "unsubscribe", SESSION]);
  });

  it("only ends the session when this browser has no subscription", async () => {
    hasSub = false;
    await signOut();
    expect(events).toEqual([SESSION]);
  });

  it("still signs out when the device removal fails", async () => {
    failDevice = true;
    await signOut();
    expect(events).toEqual([DEVICE, "unsubscribe", SESSION]);
  });
});
