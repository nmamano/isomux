// Notifications on this device (ui/components/PushDevicesBlock.tsx).
//
// Pins: a browser without push shows why instead of a button; this browser's
// subscription is recognized among the member's devices by its id; turning
// on asks permission, subscribes with the office key and saves the
// subscription with a label; turning off removes the device and
// unsubscribes; a refused permission saves nothing; other devices list with
// a remove action.

import { describe, expect, it, afterAll, beforeEach } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act } = await import("@testing-library/react");
const { PushDevicesBlock } = await import("./PushDevicesBlock.tsx");
const { setApiShim } = await import("../api.ts");
const { pushDeviceId, base64UrlDecode } =
  await import("../../shared/web-push.ts");

const PATH = "/api/users/boss/push-devices";
// Any 65-byte P-256 point serves as the office key here.
const KEY =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-browser";
const THIS_ID = await pushDeviceId(ENDPOINT);

interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  toJSON(): { keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

const browser = {
  sub: null as FakeSub | null,
  permission: "granted" as NotificationPermission,
  unsubscribed: 0,
  subscribedWith: null as Uint8Array | null,
  events: [] as string[],
};

// A subscription bound to `key` (the office key by default).
function makeSub(key: ArrayBuffer = base64UrlDecode(KEY)!.buffer): FakeSub {
  return {
    endpoint: ENDPOINT,
    options: { applicationServerKey: key },
    toJSON: () => ({ keys: { p256dh: "P", auth: "A" } }),
    unsubscribe: async () => {
      browser.events.push("unsubscribe");
      browser.unsubscribed++;
      browser.sub = null;
      return true;
    },
  };
}

function installPushApis() {
  const pushManager = {
    getSubscription: async () => browser.sub,
    subscribe: async (opts: { applicationServerKey: Uint8Array }) => {
      browser.events.push("subscribe");
      browser.subscribedWith = opts.applicationServerKey;
      browser.sub = makeSub();
      return browser.sub;
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
      requestPermission: async () => browser.permission,
    },
    configurable: true,
  });
}

function removePushApis() {
  for (const [obj, key] of [
    [navigator, "serviceWorker"],
    [window, "PushManager"],
    [window, "Notification"],
  ] as const) {
    delete (obj as unknown as Record<string, unknown>)[key];
  }
}

let devices: { id: string; label: string; createdAt: number }[] = [];
const writes: unknown[] = [];
setApiShim(async (method, path, body) => {
  if (method === "GET" && path === PATH) return { publicKey: KEY, devices };
  writes.push([method, path, body]);
  if (method === "POST" && path === PATH) {
    devices = [...devices, { id: THIS_ID, label: "Mac", createdAt: 1 }];
    return devices.at(-1);
  }
  if (method === "DELETE") {
    const id = path.split("/").pop();
    devices = devices.filter((d) => d.id !== id);
    return undefined;
  }
  return { delivered: true };
});
afterAll(() => setApiShim(null));

beforeEach(() => {
  removePushApis();
  devices = [];
  writes.length = 0;
  browser.sub = null;
  browser.permission = "granted";
  browser.unsubscribed = 0;
  browser.subscribedWith = null;
  browser.events = [];
});

const mount = async () => {
  const view = render(<PushDevicesBlock username="boss" />);
  await act(async () => {});
  return view;
};

describe("push devices block", () => {
  it("shows why a browser without push cannot turn it on", async () => {
    const view = await mount();
    expect(view.queryByTestId("push-toggle")).toBeNull();
    expect(
      view.getByTestId("push-unsupported").getAttribute("data-reason"),
    ).toBe("unsupported");
    view.unmount();
  });

  it("turns this device on with the office key, then off again", async () => {
    installPushApis();
    const view = await mount();
    const toggle = () => view.getByTestId("push-toggle");
    expect(toggle().getAttribute("data-on")).toBe("false");

    await act(async () => fireEvent.click(toggle()));
    expect(browser.subscribedWith).toEqual(base64UrlDecode(KEY));
    expect(writes).toHaveLength(1);
    const [method, path, body] = writes[0] as [
      string,
      string,
      { endpoint: string; keys: unknown; label: string },
    ];
    expect([method, path]).toEqual(["POST", PATH]);
    expect(body.endpoint).toBe(ENDPOINT);
    expect(body.keys).toEqual({ p256dh: "P", auth: "A" });
    expect(body.label.length).toBeGreaterThan(0);
    expect(toggle().getAttribute("data-on")).toBe("true");
    expect(view.getByTestId("push-test")).not.toBeNull();

    await act(async () => fireEvent.click(toggle()));
    expect(writes.at(-1)).toEqual(["DELETE", `${PATH}/${THIS_ID}`, undefined]);
    expect(browser.unsubscribed).toBe(1);
    expect(toggle().getAttribute("data-on")).toBe("false");
    view.unmount();
  });

  it("saves nothing when the member refuses permission", async () => {
    installPushApis();
    browser.permission = "denied";
    const view = await mount();
    await act(async () => fireEvent.click(view.getByTestId("push-toggle")));
    expect(writes).toEqual([]);
    expect(browser.subscribedWith).toBeNull();
    expect(view.getByTestId("push-status").getAttribute("data-ok")).toBe(
      "false",
    );
    view.unmount();
  });

  it("treats a subscription made with another key as Off, and replaces it on Turn on", async () => {
    installPushApis();
    // The office made new keys: the browser holds a subscription to the old
    // one, and the server still lists the endpoint.
    browser.sub = makeSub(new Uint8Array(65).fill(4).buffer);
    devices = [{ id: THIS_ID, label: "Mac", createdAt: 1 }];
    const view = await mount();
    const toggle = () => view.getByTestId("push-toggle");
    expect(toggle().getAttribute("data-on")).toBe("false");
    await act(async () => fireEvent.click(toggle()));
    expect(browser.events).toEqual(["unsubscribe", "subscribe"]);
    expect(browser.subscribedWith).toEqual(base64UrlDecode(KEY));
    view.unmount();
  });

  it("recognizes this browser among the devices and lists the others", async () => {
    installPushApis();
    browser.sub = makeSub();
    devices = [
      { id: THIS_ID, label: "Mac", createdAt: 1 },
      { id: "0123456789abcdef", label: "iPhone", createdAt: 2 },
    ];
    const view = await mount();
    expect(view.getByTestId("push-toggle").getAttribute("data-on")).toBe(
      "true",
    );
    const others = view.getAllByTestId("push-device");
    expect(others).toHaveLength(1);
    expect(others[0].textContent).toContain("iPhone");
    await act(async () => fireEvent.click(others[0].querySelector("button")!));
    expect(writes).toEqual([["DELETE", `${PATH}/0123456789abcdef`, undefined]]);
    // This browser stays subscribed.
    expect(browser.unsubscribed).toBe(0);
    expect(view.queryAllByTestId("push-device")).toHaveLength(0);
    view.unmount();
  });
});
