import { afterAll, test, expect } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom";
setUpDomTestFile();
const { render, fireEvent, act } = await import("@testing-library/react");
const { BrowserPane } = await import("./BrowserPane");
const { setApiShim } = await import("../api");
const { onLanguage } = await import("../test-support/language-fixture");
const { translatorFor } = await import("../../shared/i18n/translate");
afterAll(() => setApiShim(null));

test("Chrome pairing adds named browsers; each one unpairs through its own self route", async () => {
  // The name field starts with the browser the member is on.
  const originalAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const originalPlatform = Object.getOwnPropertyDescriptor(
    navigator,
    "platform",
  );
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "Win32",
  });
  const prefill = translatorFor("en").t("browser.defaultName", {
    browser: "Chrome",
    os: "Windows",
  });
  type Status =
    import("../../shared/browser-extension-protocol").MemberBrowserStatus;
  let status: Status = {
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.1.0",
    browsers: [],
  };
  const writes: unknown[] = [];
  setApiShim(async (method, path, body) => {
    if (method === "GET") return status;
    writes.push([method, path, body]);
    if (method === "DELETE") {
      const browsers = status.browsers.filter(
        (b) => path !== `/api/me/browser/browsers/${b.id}`,
      );
      status = {
        ...status,
        browsers,
        paired: browsers.length > 0,
        online: browsers.some((b) => b.online),
      };
    }
    if (method === "POST")
      return { code: "fixture-code", expiresAt: Date.now() + 300000 };
  });
  const view = render(<BrowserPane />);
  await act(async () => {});
  expect(view.queryAllByTestId("browser-row")).toHaveLength(0);
  expect(writes).toHaveLength(0);
  expect((view.getByTestId("browser-name") as HTMLInputElement).value).toBe(
    prefill,
  );
  await act(async () =>
    fireEvent.change(view.getByTestId("browser-name"), {
      target: { value: "Work laptop" },
    }),
  );
  await act(async () => fireEvent.click(view.getByTestId("browser-pair")));
  expect(writes).toEqual([
    ["POST", "/api/me/browser/pair", { name: "Work laptop" }],
  ]);
  expect((view.getByTestId("browser-name") as HTMLInputElement).value).toBe(
    prefill,
  );
  expect((view.getByTestId("browser-code") as HTMLInputElement).value).toBe(
    "fixture-code",
  );
  expect((view.getByTestId("browser-code") as HTMLInputElement).type).toBe(
    "password",
  );
  view.unmount();
  status = {
    ...status,
    paired: true,
    online: true,
    browsers: [
      {
        id: "laptop",
        name: "Work laptop",
        pairedAt: 0,
        online: true,
        outdated: false,
        reloadable: false,
        agentTabs: null,
      },
      {
        id: "desk",
        name: "Desk",
        pairedAt: null,
        online: false,
        outdated: false,
        reloadable: false,
        agentTabs: null,
      },
    ],
  };
  const paired = render(<BrowserPane />);
  await act(async () => {});
  expect(paired.getByTestId("browser-state").dataset.online).toBe("true");
  const rows = paired.getAllByTestId("browser-row");
  expect(rows.map((r) => r.dataset.online)).toEqual(["true", "false"]);
  expect(rows[0].textContent).toContain("Work laptop");
  expect(rows[1].textContent).toContain("Desk");
  // A paired member still creates codes the same way; no replace flag.
  await act(async () => fireEvent.click(paired.getByTestId("browser-pair")));
  expect(writes.at(-1)).toEqual([
    "POST",
    "/api/me/browser/pair",
    { name: prefill },
  ]);
  await act(async () =>
    fireEvent.click(paired.getAllByTestId("browser-revoke")[0]),
  );
  expect(writes.at(-1)).toEqual([
    "DELETE",
    "/api/me/browser/browsers/laptop",
    undefined,
  ]);
  expect(
    paired.getAllByTestId("browser-row").map((r) => r.dataset.online),
  ).toEqual(["false"]);
  expect(paired.getByTestId("browser-state").dataset.paired).toBe("true");
  paired.unmount();
  // The pane reads the member's language.
  for (const language of ["en", "es"] as const) {
    const translated = render(onLanguage(language, <BrowserPane />));
    await act(async () => {});
    expect(translated.getByTestId("browser-pair").textContent).toBe(
      translatorFor(language).t("browser.generate"),
    );
    translated.unmount();
  }
  for (const [key, original] of [
    ["userAgent", originalAgent],
    ["platform", originalPlatform],
  ] as const) {
    if (original) Object.defineProperty(navigator, key, original);
    else delete (navigator as unknown as Record<string, unknown>)[key];
  }
});

test("the extensions step copies the Chrome address it names", async () => {
  setApiShim(async () => ({
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    browsers: [],
    version: "0.1.0",
  }));
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  try {
    const view = render(<BrowserPane />);
    await act(async () => {});
    const button = view.getByTestId("browser-extensions-copy");
    const step = button.closest("li")!;
    const address = step.querySelector("code")!.textContent;
    expect(address.startsWith("chrome://")).toBe(true);
    const before = button.textContent;
    await act(async () => fireEvent.click(button));
    expect(copied).toEqual([address]);
    expect(button.textContent).not.toBe(before);
    view.unmount();
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

// Task 825bb286: Reload in chrome://extensions keeps the old files, so the
// pane names each out-of-date browser and links the new package.
test("an out-of-date browser gets an update notice with the download; up-to-date browsers get none", async () => {
  type Status =
    import("../../shared/browser-extension-protocol").MemberBrowserStatus;
  let status: Status = {
    paired: true,
    online: true,
    member: { id: "self", name: "Fixture member" },
    version: "0.4.5",
    browsers: [
      {
        id: "laptop",
        name: "Work laptop",
        pairedAt: 0,
        online: true,
        package: "0.4.5",
        outdated: false,
        reloadable: false,
        agentTabs: null,
      },
      {
        id: "desk",
        name: "Desk",
        pairedAt: 0,
        online: true,
        package: null,
        outdated: true,
        reloadable: false,
        agentTabs: null,
      },
    ],
  };
  setApiShim(async () => status);
  const view = render(<BrowserPane />);
  await act(async () => {});
  const notice = view.getByTestId("browser-update");
  expect(notice.textContent).toContain("Desk");
  expect(notice.textContent).not.toContain("Work laptop");
  const link = notice.querySelector<HTMLAnchorElement>(
    'a[href="/api/me/browser/extension.zip"]',
  );
  expect(link).not.toBeNull();
  expect(link!.hasAttribute("download")).toBe(true);
  expect(link!.textContent).toContain("0.4.5");
  view.unmount();
  status = {
    ...status,
    browsers: status.browsers.map((b) => ({
      ...b,
      package: "0.4.5",
      outdated: false,
      agentTabs: null,
    })),
  };
  const current = render(<BrowserPane />);
  await act(async () => {});
  // Precondition: the pane rendered the browsers.
  expect(current.getAllByTestId("browser-row")).toHaveLength(2);
  expect(current.queryByTestId("browser-update")).toBeNull();
  current.unmount();
});

// Task f8d05b49: on the iPhone Home Screen office a download link opened the
// iOS file preview, which has no way back. Both extension downloads (the
// update notice and the setup step) stay in the office there: they fetch the
// package and open the share sheet under its file name.
test("on the iPhone Home Screen office, each extension download opens the share sheet", async () => {
  const { asDevice, IPHONE_HOME_SCREEN, stubShareSheet } =
    await import("../test-support/ios-home-screen");
  const { resetHomeScreenDownloadCache } =
    await import("../home-screen-download");
  resetHomeScreenDownloadCache();
  setApiShim(async () => ({
    paired: true,
    online: true,
    member: { id: "self", name: "Fixture member" },
    version: "0.4.5",
    browsers: [
      {
        id: "desk",
        name: "Desk",
        pairedAt: 0,
        online: true,
        package: null,
        outdated: true,
        reloadable: false,
        agentTabs: null,
      },
    ],
  }));
  const undoDevice = asDevice(IPHONE_HOME_SCREEN);
  const sheet = stubShareSheet("zip bytes", "application/zip");
  const view = render(<BrowserPane />);
  const prevented: boolean[] = [];
  // Read after the link's own handler, then stop happy-dom from following it.
  const record = (e: Event) => {
    prevented.push(e.defaultPrevented);
    e.preventDefault();
  };
  view.container.addEventListener("click", record);
  try {
    await act(async () => {});
    const links = [
      ...view.container.querySelectorAll<HTMLAnchorElement>(
        'a[href="/api/me/browser/extension.zip"]',
      ),
    ];
    // Precondition: the update notice and the setup step both rendered.
    expect(links).toHaveLength(2);
    expect(
      links.map((l) => !!l.closest('[data-testid="browser-update"]')),
    ).toEqual([true, false]);
    for (const link of links) {
      fireEvent.click(link);
      await act(async () => {
        for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(prevented).toEqual([true, true]);
    // The second link shares the package the first one fetched.
    expect(sheet.fetches).toEqual(["/api/me/browser/extension.zip"]);
    expect(sheet.shares.map((s) => s.files?.map((f) => f.name))).toEqual([
      ["isomux-browser.zip"],
      ["isomux-browser.zip"],
    ]);
  } finally {
    view.container.removeEventListener("click", record);
    view.unmount();
    sheet.undo();
    undoDevice();
  }
});

// Task 2f43d351: a browser whose extension has newer files in place gets a
// Reload in the update notice, which asks the office to reload it.
test("each reloadable browser gets a Reload that posts its own reload route", async () => {
  type Status =
    import("../../shared/browser-extension-protocol").MemberBrowserStatus;
  const browser = (id: string, name: string, reloadable: boolean) => ({
    id,
    name,
    pairedAt: 0,
    online: true,
    package: "0.6.0",
    outdated: true,
    reloadable,
    agentTabs: null,
  });
  let status: Status = {
    paired: true,
    online: true,
    member: { id: "self", name: "Fixture member" },
    version: "0.7.0",
    browsers: [
      browser("laptop", "Work laptop", true),
      browser("desk", "Desk", false),
    ],
  };
  const writes: unknown[] = [];
  setApiShim(async (method, path) => {
    if (method === "GET") return status;
    writes.push([method, path]);
  });
  const view = render(<BrowserPane />);
  await act(async () => {});
  const notice = view.getByTestId("browser-update");
  // Precondition: both browsers are named as out of date.
  expect(notice.textContent).toContain("Desk");
  // Desk still needs the new files: the download stays.
  expect(
    notice.querySelector('a[href="/api/me/browser/extension.zip"]'),
  ).not.toBeNull();
  const buttons = view.queryAllByTestId("browser-reload");
  expect(buttons).toHaveLength(1);
  expect(notice.contains(buttons[0])).toBe(true);
  expect(writes).toEqual([]);
  await act(async () => fireEvent.click(buttons[0]));
  expect(writes).toEqual([["POST", "/api/me/browser/browsers/laptop/reload"]]);
  view.unmount();
  // With two, each button names its browser.
  status = {
    ...status,
    browsers: [
      browser("laptop", "Work laptop", true),
      browser("desk", "Desk", true),
    ],
  };
  const both = render(<BrowserPane />);
  await act(async () => {});
  const two = both.getAllByTestId("browser-reload");
  // Every out-of-date browser has its files in place: no download.
  expect(
    both
      .getByTestId("browser-update")
      .querySelector('a[href="/api/me/browser/extension.zip"]'),
  ).toBeNull();
  expect(
    two.map((b) => [
      b.textContent.includes("Work laptop"),
      b.textContent.includes("Desk"),
    ]),
  ).toEqual([
    [true, false],
    [false, true],
  ]);
  await act(async () => fireEvent.click(two[1]));
  expect(writes.at(-1)).toEqual([
    "POST",
    "/api/me/browser/browsers/desk/reload",
  ]);
  both.unmount();
  // None reloadable: no Reload.
  status = {
    ...status,
    browsers: [browser("laptop", "Work laptop", false)],
  };
  const none = render(<BrowserPane />);
  await act(async () => {});
  expect(none.getByTestId("browser-update")).toBeTruthy();
  expect(none.queryAllByTestId("browser-reload")).toHaveLength(0);
  none.unmount();
});

// Task 328ef745: Chrome updates a store install by itself, so the pane gives
// an out-of-date store browser no download and no Reload, and its note does
// not read as the unpacked one.
test("an out-of-date store browser gets no download and no Reload; an unpacked one beside it keeps the download", async () => {
  type Status =
    import("../../shared/browser-extension-protocol").MemberBrowserStatus;
  // A browser with its newer files in place is reloadable, and the pane then
  // drops the download for it; so the download is checked without them.
  const browser = (
    id: string,
    name: string,
    store: boolean,
    reloadable = false,
  ) => ({
    id,
    name,
    pairedAt: 0,
    online: true,
    package: "0.6.0",
    outdated: true,
    reloadable,
    store,
    agentTabs: null,
  });
  const base: Status = {
    paired: true,
    online: true,
    member: { id: "self", name: "Fixture member" },
    version: "0.7.0",
    browsers: [],
  };
  const notice = async (browsers: Status["browsers"]) => {
    setApiShim(async () => ({ ...base, browsers }));
    const view = render(<BrowserPane />);
    await act(async () => {});
    const el = view.getByTestId("browser-update");
    const result = {
      text: el.textContent,
      zip: !!el.querySelector('a[href="/api/me/browser/extension.zip"]'),
      reloads: view
        .queryAllByTestId("browser-reload")
        .map((b) => b.textContent.includes("Desk")),
    };
    view.unmount();
    return result;
  };
  const kiosk = await notice([browser("kiosk", "Kiosk", true)]);
  expect(kiosk.text).toContain("Kiosk");
  expect(kiosk.zip).toBe(false);
  // Keyed on store only: even a reloadable store browser gets no Reload.
  expect(
    (await notice([browser("kiosk", "Kiosk", true, true)])).reloads,
  ).toEqual([]);
  const desk = await notice([browser("desk", "Desk", false)]);
  // Precondition: the unpacked one gets the download, and its Reload when
  // its files are in place.
  expect(desk.zip).toBe(true);
  expect(
    (await notice([browser("desk", "Desk", false, true)])).reloads,
  ).toEqual([true]);
  expect(kiosk.text.replaceAll("Kiosk", "<browser>")).not.toBe(
    desk.text.replaceAll("Desk", "<browser>"),
  );
  const both = await notice([
    browser("kiosk", "Kiosk", true),
    browser("desk", "Desk", false),
  ]);
  expect(both.text).toContain("Kiosk");
  expect(both.text).toContain("Desk");
  expect(both.zip).toBe(true);
  // Both reloadable: only Desk's Reload.
  expect(
    (
      await notice([
        browser("kiosk", "Kiosk", true, true),
        browser("desk", "Desk", false, true),
      ])
    ).reloads,
  ).toEqual([true]);
});

// Task 328ef745: with a store listing, the setup starts with the store
// install; the ZIP download stays, after it, as the developer install.
test("with a store listing the setup links it before the ZIP download; without one it has no store link", async () => {
  const listing =
    "https://chromewebstore.google.com/detail/isomux-browser/abcdefghijklmnopabcdefghijklmnop";
  const status = {
    paired: false,
    online: false,
    member: { id: "self", name: "Fixture member" },
    version: "0.7.0",
    browsers: [],
  };
  for (const storeUrl of [listing, undefined]) {
    setApiShim(async () => ({ ...status, ...(storeUrl ? { storeUrl } : {}) }));
    const view = render(<BrowserPane />);
    await act(async () => {});
    const store = view.container.querySelectorAll(`a[href="${listing}"]`);
    const zip = view.container.querySelector(
      'a[href="/api/me/browser/extension.zip"]',
    );
    expect([storeUrl, store.length]).toEqual([storeUrl, storeUrl ? 1 : 0]);
    expect(zip).not.toBeNull();
    if (storeUrl) {
      expect(
        store[0].compareDocumentPosition(zip!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect((store[0] as HTMLAnchorElement).target).toBe("_blank");
    }
    view.unmount();
  }
});
