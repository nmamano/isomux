// Notifications on this device (ui/components/PushDevicesBlock.tsx).
//
// Pins: a browser without push shows why instead of a button; this browser's
// subscription is recognized among the member's devices by its id; turning
// on asks permission, subscribes with the office key and saves the
// subscription with a label; turning off removes the device and
// unsubscribes; a refused permission saves nothing; other devices list with
// a remove action; a pack at pager read leaves the list without a control.

import {
  describe,
  expect,
  it,
  afterAll,
  afterEach,
  beforeEach,
} from "bun:test";
import type { ReactElement } from "react";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, act } = await import("@testing-library/react");
const { PushDevicesBlock, PushThisDevice } =
  await import("./PushDevicesBlock.tsx");
const { StateCtx } = await import("../store.tsx");
const { selfUserRecord, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");
const { pushDeviceId, base64UrlDecode } =
  await import("../../shared/web-push.ts");

const PATH = "/api/users/morgan/push-devices";
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
    [window, "isSecureContext"],
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
afterEach(removePushApis);

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
  const view = render(<PushDevicesBlock username="morgan" />);
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
    // The other devices sit in a collapsed row.
    expect(view.queryAllByTestId("push-device")).toHaveLength(0);
    const row = view.getByTestId("push-others");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(row));
    expect(row.getAttribute("aria-expanded")).toBe("true");
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

// A member whose permission pack gives pager at read only (task 119d0b47):
// every device change is pager write, so the block lists the devices with no
// switch, Test or Remove, and the room view's Turn on is gone.
describe("a pack that gives pager at read only", () => {
  const atLevel = (level: "read" | "write") => {
    const record = {
      ...selfUserRecord("en"),
      role: "member" as const,
      pack: { areas: { pager: level }, agentCeiling: "office" },
    };
    const base = stateWithSelfUser("en");
    return {
      ...base,
      users: new Map([[record.name.toLowerCase(), record]]),
      sessionContext: { ...base.sessionContext!, role: "member" as const },
    } as typeof base;
  };
  const mountAt = async (level: "read" | "write", element: ReactElement) => {
    const view = render(
      <StateCtx.Provider value={atLevel(level)}>{element}</StateCtx.Provider>,
    );
    await act(async () => {});
    return view;
  };
  const CONTROLS = ["push-toggle", "push-test", "push-remove"];
  const shown = (view: ReturnType<typeof render>, ids: string[]) =>
    ids.filter((id) => view.queryByTestId(id) !== null);

  it("lists this browser's and the other devices without a control", async () => {
    installPushApis();
    browser.sub = makeSub();
    devices = [
      { id: THIS_ID, label: "Mac", createdAt: 1 },
      { id: "0123456789abcdef", label: "iPhone", createdAt: 2 },
    ];
    for (const level of ["write", "read"] as const) {
      const view = await mountAt(level, <PushDevicesBlock username="morgan" />);
      await act(async () => fireEvent.click(view.getByTestId("push-others")));
      expect(view.getAllByTestId("push-device")).toHaveLength(1);
      expect(shown(view, CONTROLS)).toEqual(level === "write" ? CONTROLS : []);
      view.unmount();
    }
    expect(writes).toEqual([]);
  });

  it("gives the room view no Turn on", async () => {
    installPushApis();
    for (const level of ["write", "read"] as const) {
      const view = await mountAt(level, <PushThisDevice username="morgan" />);
      // The devices loaded in both runs: the GET answered.
      expect(view.queryByTestId("push-unsupported")).toBeNull();
      expect(shown(view, ["push-turn-on"])).toEqual(
        level === "write" ? ["push-turn-on"] : [],
      );
      view.unmount();
    }
  });
});
