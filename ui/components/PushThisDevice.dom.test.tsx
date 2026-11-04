// "Turn on for this device" under the Push level of the room view legend
// (PushThisDevice in ui/components/PushDevicesBlock.tsx, task b8a7836d).
//
// Pins: the control is empty until the devices load, and stays empty when
// the load fails or this browser is already on; an off browser gets one
// button, which asks permission inside the tap before it subscribes and
// saves the device, then says it is on; a browser without push, an iPhone
// outside the Home Screen and an office without a key say why; a blocked
// browser says so once and offers no button; a refused permission saves
// nothing, and a dismissed prompt is not called blocked; a second tap while
// the first runs sends nothing.

import {
  describe,
  expect,
  it,
  afterAll,
  afterEach,
  beforeEach,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act } = await import("@testing-library/react");
const { PushThisDevice } = await import("./PushDevicesBlock.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { pushDeviceId, base64UrlDecode } =
  await import("../../shared/web-push.ts");
const { en } = await import("../../shared/i18n/en.ts");

const PATH = "/api/users/morgan/push-devices";
// Any 65-byte P-256 point serves as the office key here.
const KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-browser";
const THIS_ID = await pushDeviceId(ENDPOINT);

const sub = {
  endpoint: ENDPOINT,
  options: { applicationServerKey: base64UrlDecode(KEY)!.buffer },
  toJSON: () => ({ keys: { p256dh: "P", auth: "A" } }),
  unsubscribe: async () => true,
};

// The browser: its permission now, the answer the next prompt gets, the
// subscription it holds, and what happened in what order.
const browser = {
  permission: "default" as NotificationPermission,
  answer: "granted" as NotificationPermission,
  sub: null as typeof sub | null,
  events: [] as string[],
};

function installPushApis() {
  const pushManager = {
    getSubscription: async () => browser.sub,
    subscribe: async () => {
      browser.events.push("subscribe");
      browser.sub = sub;
      return sub;
    },
  };
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", {
    value: function PushManager() {},
    configurable: true,
  });
  Object.defineProperty(window, "Notification", {
    value: {
      get permission() {
        return browser.permission;
      },
      requestPermission: async () => {
        browser.events.push("permission");
        browser.permission = browser.answer;
        return browser.answer;
      },
    },
    configurable: true,
  });
}

function removePushApis() {
  for (const [obj, key] of [
    [navigator, "serviceWorker"],
    [window, "PushManager"],
    [window, "Notification"],
    [window, "isSecureContext"],
  ] as const) {
    delete (obj as unknown as Record<string, unknown>)[key];
  }
}

// The server: the key it answers with, its devices, and per-test hooks to
// fail or hold a request.
let publicKey = KEY;
let devices: { id: string; label: string; createdAt: number }[] = [];
let failGet = false;
let failPost = false;
let held: Promise<void> | null = null;
const posts: unknown[] = [];
setApiShim(async (method, path, body) => {
  if (method === "GET" && path === PATH) {
    if (held) await held;
    if (failGet) throw new ApiError(500, "web_push_failed", "down");
    return { publicKey, devices };
  }
  if (method === "POST" && path === PATH) {
    browser.events.push("POST");
    posts.push(body);
    if (held) await held;
    if (failPost) throw new ApiError(500, "web_push_failed", "down");
    devices = [...devices, { id: THIS_ID, label: "Mac", createdAt: 1 }];
    return devices.at(-1);
  }
  throw new Error(`unexpected ${method} ${path}`);
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  removePushApis();
  publicKey = KEY;
  devices = [];
  failGet = false;
  failPost = false;
  held = null;
  posts.length = 0;
  browser.permission = "default";
  browser.answer = "granted";
  browser.sub = null;
  browser.events = [];
});
afterEach(() => {
  removePushApis();
  // Only the iPhone case shadows the user agent.
  delete (navigator as unknown as Record<string, unknown>).userAgent;
});

const mount = async () => {
  const view = render(<PushThisDevice username="morgan" />);
  await act(async () => {});
  return view;
};
type View = Awaited<ReturnType<typeof mount>>;
const button = (view: View) =>
  view.queryByTestId("push-turn-on") as HTMLButtonElement | null;
const tap = (view: View) =>
  act(async () => {
    fireEvent.click(button(view)!);
  });
const status = (view: View) => view.queryByTestId("push-status");
const reason = (view: View) =>
  view.queryByTestId("push-unsupported")?.getAttribute("data-reason") ?? null;
// How many times the blocked explanation shows, in any element.
const blockedLines = (view: View) =>
  (view.container.textContent ?? "").split(en["push.settings.blocked"]).length -
  1;

describe("turn on for this device", () => {
  it("turns an off browser on: permission first, then the subscription, then the saved device, and says it is on", async () => {
    installPushApis();
    const view = await mount();
    expect(button(view)).not.toBeNull();
    expect(status(view)).toBeNull();

    await tap(view);
    expect(browser.events).toEqual(["permission", "subscribe", "POST"]);
    const body = posts[0] as {
      endpoint: string;
      keys: unknown;
      label: string;
    };
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.keys).toEqual({ p256dh: "P", auth: "A" });
    expect(body.label.length).toBeGreaterThan(0);
    // The button gives way to a line that says it worked.
    expect(button(view)).toBeNull();
    expect(status(view)?.getAttribute("data-ok")).toBe("true");
    view.unmount();
  });

  it("shows nothing for a browser that is already on", async () => {
    installPushApis();
    browser.permission = "granted";
    browser.sub = sub;
    devices = [{ id: THIS_ID, label: "Mac", createdAt: 1 }];
    const view = await mount();
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("button")).toBeNull();
    view.unmount();
  });

  it("shows nothing until the devices load, and nothing when the load fails", async () => {
    installPushApis();
    let release = () => {};
    held = new Promise((r) => (release = r));
    const view = await mount();
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("button")).toBeNull();
    failGet = true;
    await act(async () => release());
    expect(view.container.textContent).toBe("");
    expect(view.container.querySelector("button")).toBeNull();
    view.unmount();
  });

  it("says why there is no button: a browser without push, an office without a key, an iPhone outside the Home Screen", async () => {
    const plain = await mount();
    expect(button(plain)).toBeNull();
    expect(reason(plain)).toBe("unsupported");
    plain.unmount();

    installPushApis();
    publicKey = "";
    const noKey = await mount();
    expect(button(noKey)).toBeNull();
    expect(reason(noKey)).toBe("unsupported");
    noKey.unmount();

    publicKey = KEY;
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
    const iphone = await mount();
    expect(button(iphone)).toBeNull();
    expect(reason(iphone)).toBe("ios-install");
    iphone.unmount();
  });

  it("a browser that blocks notifications says so once and offers no button", async () => {
    installPushApis();
    browser.permission = "denied";
    const view = await mount();
    expect(button(view)).toBeNull();
    expect(blockedLines(view)).toBe(1);
    view.unmount();
  });

  it("a refused permission saves nothing: blocked says so once, a dismissed prompt keeps the button and says nothing", async () => {
    installPushApis();
    browser.answer = "denied";
    const refused = await mount();
    await tap(refused);
    expect(browser.events).toEqual(["permission"]);
    expect(posts).toEqual([]);
    expect(button(refused)).toBeNull();
    expect(blockedLines(refused)).toBe(1);
    refused.unmount();

    browser.permission = "default";
    browser.answer = "default";
    browser.events = [];
    const dismissed = await mount();
    await tap(dismissed);
    expect(browser.events).toEqual(["permission"]);
    expect(posts).toEqual([]);
    // The member only closed the prompt: nothing is blocked, so no line
    // says so, and the button stays for another try.
    expect(button(dismissed)).not.toBeNull();
    expect(status(dismissed)).toBeNull();
    expect(blockedLines(dismissed)).toBe(0);
    dismissed.unmount();
  });

  it("a failed save says so and keeps the button", async () => {
    installPushApis();
    failPost = true;
    const view = await mount();
    await tap(view);
    expect(posts).toHaveLength(1);
    expect(status(view)?.getAttribute("data-ok")).toBe("false");
    expect(button(view)).not.toBeNull();
    view.unmount();
  });

  it("a second tap while the first runs sends nothing", async () => {
    installPushApis();
    const view = await mount();
    let release = () => {};
    held = new Promise((r) => (release = r));
    await tap(view);
    expect(posts).toHaveLength(1);
    expect(button(view)?.disabled).toBe(true);
    await tap(view);
    held = null;
    await act(async () => release());
    expect(browser.events).toEqual(["permission", "subscribe", "POST"]);
    expect(posts).toHaveLength(1);
    view.unmount();
  });
});
