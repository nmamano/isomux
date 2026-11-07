import { test, expect } from "bun:test";
import { setUpDomTestFile } from "../ui/test-support/dom";
import { translatorFor } from "../shared/i18n/translate";
import { extensionCatalogs } from "../scripts/build-browser-extension";

setUpDomTestFile();
const { Script } = await import("node:vm");
const { readFile } = await import("node:fs/promises");
// Build and compile once; each popup still gets a fresh VM context and DOM.
const build = await Bun.build({
  entrypoints: ["browser-extension/connection.ts"],
  target: "browser",
  plugins: [extensionCatalogs()],
});
if (!build.success) throw new AggregateError(build.logs, "Popup build failed");
const popupSource = await build.outputs[0].text();
if (!popupSource.trim()) throw new Error("Popup build is empty");
const popupScript = new Script(`(async () => { ${popupSource} })()`);
const popupHTML = (await readFile("browser-extension/connection.html", "utf8"))
  .split("<body>")[1]
  .split("</body>")[0];

// Session storage with no pairing draft in it.
const noDraft = {
  get: async () => ({}),
  set: async () => {},
};

// Session storage backed by `map`, shared across popup opens.
const sessionOn = (map: Map<string, unknown>) => ({
  get: async (key: string) =>
    map.has(key) ? { [key]: structuredClone(map.get(key)) } : {},
  set: async (value: Record<string, unknown>) => {
    for (const [key, item] of Object.entries(value))
      map.set(key, structuredClone(item));
  },
});

// chrome.storage.local backed by `map`: get takes a key, a list of keys or
// null, as Chrome's does.
const localOn = (map: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) =>
    Object.fromEntries(
      (keys == null ? [...map.keys()] : [keys].flat())
        .filter((key) => map.has(key))
        .map((key) => [key, structuredClone(map.get(key))]),
    ),
  set: async (value: Record<string, unknown>) => {
    for (const [key, item] of Object.entries(value))
      map.set(key, structuredClone(item));
  },
  remove: async (keys: string | string[]) => {
    for (const key of [keys].flat()) map.delete(key);
  },
});

// Masking does not depend on the language; one locale is enough.
test("pairing code stays masked unless explicitly shown, including replacement and failed submit", async () => {
  document.body.innerHTML = popupHTML;
  const code = document.getElementById("code") as HTMLInputElement;
  const reveal = document.getElementById(
    "code-visibility",
  ) as HTMLButtonElement;
  const form = document.getElementById("pair-form") as HTMLFormElement;
  const replace = document.getElementById("replace") as HTMLButtonElement;
  expect(code.type).toBe("password");
  expect(reveal.type).toBe("button");
  expect(reveal.getAttribute("aria-controls")).toBe(code.id);
  expect(reveal.getAttribute("aria-describedby")).toBe("code-label");
  let state = {
    state: "unpaired",
    office: "",
    agents: [],
    assignments: [],
  };
  let finish!: (value: typeof state & { error?: string }) => void;
  const sent: Record<string, unknown>[] = [];
  const session = new Map<string, unknown>();
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    chrome: {
      storage: { session: sessionOn(session) },
      tabs: { query: async () => [{ id: 7, windowId: 1 }] },
      runtime: {
        sendMessage: (message: Record<string, unknown>) => {
          sent.push(message);
          return message.action === "pair"
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : Promise.resolve(structuredClone(state));
        },
      },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  const maskedLabel = reveal.textContent;
  expect(maskedLabel).toBeTruthy();
  expect(form.hidden).toBe(false);
  code.value = "fixture-only-pairing-code";
  reveal.click();
  expect(code.type).toBe("text");
  expect(reveal.getAttribute("aria-pressed")).toBe("true");
  expect(reveal.textContent).not.toBe(maskedLabel);
  expect(sent.filter((message) => message.action === "pair")).toHaveLength(0);
  reveal.click();
  expect(code.type).toBe("password");
  expect(reveal.getAttribute("aria-pressed")).toBe("false");
  reveal.click();
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(code.type).toBe("password");
  expect(reveal.getAttribute("aria-pressed")).toBe("false");
  expect(sent.at(-1)).toMatchObject({
    action: "pair",
    code: "fixture-only-pairing-code",
  });
  finish({ ...state, error: "fixture failure" });
  await settle();
  expect(code.type).toBe("password");
  expect(code.value).toBe("fixture-only-pairing-code");
  reveal.click();
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(code.type).toBe("password");
  state = { ...state, state: "connected", office: "https://example.com" };
  // The worker records the office's confirmation before the popup hears.
  session.set("pairedCode", "fixture-only-pairing-code");
  finish(state);
  await settle();
  expect(code.value).toBe("");
  expect(form.hidden).toBe(true);
  // Reopening replacement pairing resets even an explicitly revealed field.
  reveal.click();
  expect(code.type).toBe("text");
  replace.click();
  expect(form.hidden).toBe(false);
  expect(code.type).toBe("password");
  code.value = "replacement-fixture";
  reveal.click();
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(code.type).toBe("password");
  session.set("pairedCode", "replacement-fixture");
  finish(state);
  await settle();
  replace.click();
  expect(code.type).toBe("password");
  expect(code.value).toBe("");
  reveal.click();
  window.dispatchEvent(new Event("pagehide"));
  expect(code.type).toBe("password");
});

test("pairing fields survive closing and reopening the popup", async () => {
  const session = new Map<string, unknown>();
  let state = { state: "unpaired", office: "", agents: [], assignments: [] };
  const sent: Record<string, unknown>[] = [];
  const open = async () => {
    document.body.innerHTML = popupHTML;
    await popupScript.runInNewContext({
      document,
      window,
      navigator: { language: "en" },
      Date,
      chrome: {
        storage: { session: sessionOn(session) },
        tabs: { query: async () => [{ id: 7, windowId: 1 }] },
        runtime: {
          sendMessage: async (message: Record<string, unknown>) => {
            sent.push(message);
            return structuredClone(state);
          },
        },
      },
      setInterval: () => 1,
      clearInterval() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      office: document.getElementById("office") as HTMLInputElement,
      code: document.getElementById("code") as HTMLInputElement,
      form: document.getElementById("pair-form") as HTMLFormElement,
      replace: document.getElementById("replace") as HTMLButtonElement,
    };
  };
  const type = (field: HTMLInputElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const close = async () => {
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const first = await open();
  expect(first.office.value).toBe("");
  expect(first.code.value).toBe("");
  type(first.office, "https://office.example.com");
  await close();

  // The member closed the popup to copy the code, and pastes it on return.
  const second = await open();
  expect(second.office.value).toBe("https://office.example.com");
  type(second.code, "pasted-pairing-code");
  await close();

  const third = await open();
  expect(third.office.value).toBe("https://office.example.com");
  expect(third.code.value).toBe("pasted-pairing-code");
  // Submitting is not pairing: until the office confirms the code, both
  // fields stay to fix, here an office address typed wrong.
  third.form.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent.at(-1)).toMatchObject({
    action: "pair",
    office: "https://office.example.com",
    code: "pasted-pairing-code",
  });
  expect(third.code.value).toBe("pasted-pairing-code");
  type(third.office, "https://corrected.example.com");
  await close();
  const fourth = await open();
  expect(fourth.office.value).toBe("https://corrected.example.com");
  expect(fourth.code.value).toBe("pasted-pairing-code");
  await close();

  // The worker records the confirmed code; that draft is done on reopen.
  session.set("pairedCode", "pasted-pairing-code");
  const confirmed = await open();
  expect(confirmed.office.value).toBe("");
  expect(confirmed.code.value).toBe("");
  // A code typed after the confirmation is a new draft and stays.
  type(confirmed.code, "next-pairing-code");
  await close();
  const next = await open();
  expect(next.code.value).toBe("next-pairing-code");
  await close();

  // A replacement office typed while paired to another one is not overwritten
  // by the paired office on the next open.
  session.clear();
  state = {
    ...state,
    state: "connected",
    office: "https://paired.example.com",
  };
  const paired = await open();
  expect(paired.office.value).toBe("https://paired.example.com");
  paired.replace.click();
  type(paired.office, "https://next.example.com");
  await close();
  const reopened = await open();
  expect(reopened.form.hidden).toBe(true);
  reopened.replace.click();
  expect(reopened.office.value).toBe("https://next.example.com");
  await close();
});

test("a code typed while the popup checks the confirmation is kept", async () => {
  document.body.innerHTML = popupHTML;
  const session = new Map<string, unknown>();
  const stored = sessionOn(session);
  let release!: () => void;
  let notify!: () => void;
  const reading = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const state = { state: "unpaired", office: "", agents: [], assignments: [] };
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    chrome: {
      storage: {
        session: {
          ...stored,
          // Hold the confirmation read, which answers with the old code.
          get: async (key: string) => {
            if (key !== "pairedCode") return stored.get(key);
            notify();
            return new Promise((resolve) => {
              release = () => resolve({ pairedCode: "old-code" });
            });
          },
        },
      },
      tabs: { query: async () => [{ id: 7, windowId: 1 }] },
      runtime: { sendMessage: async () => structuredClone(state) },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const code = document.getElementById("code") as HTMLInputElement;
  const form = document.getElementById("pair-form") as HTMLFormElement;
  const type = (value: string) => {
    code.value = value;
    code.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    type("old-code");
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await reading;
    expect(code.value).toBe("old-code");
    type("new-code");
    expect(session.get("pairingDraft")).toMatchObject({ code: "new-code" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(code.value).toBe("new-code");
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

// Task 825bb286: Reload in chrome://extensions keeps the old files, so the
// popup says an update is ready and links the office's package.
test("the popup shows an update notice with the office's download exactly while one is ready", async () => {
  document.body.innerHTML = popupHTML;
  let state: Record<string, unknown> = {
    state: "connected",
    generation: "g",
    office: "https://office.example.com",
    currentTab: { id: 7, eligible: true },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [],
    update: { latest: "0.4.10" },
  };
  let poll!: () => void;
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    chrome: {
      storage: { session: noDraft },
      tabs: { query: async () => [{ id: 7, windowId: 1 }] },
      runtime: { sendMessage: async () => structuredClone(state) },
    },
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
    clearInterval() {},
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  // Precondition: the popup rendered the connected state.
  expect(document.getElementById("status")!.dataset.state).toBe("connected");
  const notice = document.getElementById("update")!;
  expect(notice.hidden).toBe(false);
  expect(notice.textContent).toContain("0.4.10");
  const link = document.getElementById("update-download") as HTMLAnchorElement;
  expect(notice.contains(link)).toBe(true);
  expect(link.href).toBe(
    "https://office.example.com/api/me/browser/extension.zip",
  );
  expect(link.target).toBe("_blank");
  state = { ...state, update: undefined };
  poll();
  await settle();
  expect(document.getElementById("update")!.hidden).toBe(true);
  window.dispatchEvent(new Event("pagehide"));
});

// Task 2f43d351: the popup reads manifest.json on disk. When the member put
// newer files in place, it offers a Reload instead of the download.
async function updatePopup(opts: {
  update?: { latest: string };
  disk: string;
  // More fields of the background's state, for example store.
  extra?: Record<string, unknown>;
}) {
  document.body.innerHTML = popupHTML;
  let disk = opts.disk;
  let reloads = 0;
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    fetch: async (url: string) => {
      if (url !== "chrome-extension://fixture-id/manifest.json")
        throw new Error("Unexpected fetch " + url);
      if (disk === "fail") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ version: disk }));
    },
    chrome: {
      storage: { session: noDraft },
      tabs: { query: async () => [{ id: 7, windowId: 1 }] },
      runtime: {
        id: "fixture-id",
        getURL: (path: string) => "chrome-extension://fixture-id/" + path,
        getManifest: () => ({ version: "0.6.0" }),
        reload: () => {
          reloads++;
        },
        sendMessage: async () => ({
          state: "connected",
          generation: "g",
          office: "https://office.example.com",
          currentTab: { id: 7, eligible: true },
          agents: [{ id: "a", name: "Agent" }],
          assignments: [],
          ...(opts.update ? { update: opts.update } : {}),
          ...opts.extra,
        }),
      },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  // Precondition: the popup rendered the connected state.
  expect(document.getElementById("status")!.dataset.state).toBe("connected");
  const notice = document.getElementById("update")!;
  const visible = (el: Element | null | undefined) =>
    !!el && el.isConnected && !el.closest("[hidden]");
  const reloadButton = () =>
    [...notice.querySelectorAll("button")].find(visible);
  return {
    notice,
    settle,
    visible,
    reloadButton,
    download: () => visible(document.getElementById("update-download")),
    setDisk: (version: string) => {
      disk = version;
    },
    reloads: () => reloads,
  };
}

test("while no newer files are in place, the popup links the office's download and offers no Reload", async () => {
  for (const disk of ["0.6.0", "0.5.9", "fail"]) {
    const p = await updatePopup({ update: { latest: "0.7.0" }, disk });
    expect({ disk, download: p.download() }).toEqual({ disk, download: true });
    expect({ disk, reload: !!p.reloadButton() }).toEqual({
      disk,
      reload: false,
    });
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("with newer files in place, the popup offers Reload instead of the download, also when the office is not newer", async () => {
  for (const update of [{ latest: "0.7.0" }, undefined]) {
    const p = await updatePopup({ update, disk: "0.7.0" });
    const button = p.reloadButton();
    expect({ update, reload: !!button }).toEqual({ update, reload: true });
    expect(p.visible(p.notice)).toBe(true);
    expect(p.download()).toBe(false);
    expect(p.reloads()).toBe(0);
    button!.click();
    await p.settle();
    expect(p.reloads()).toBe(1);
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("Reload in the popup checks the disk again and does nothing when the newer files are gone", async () => {
  const p = await updatePopup({ update: { latest: "0.7.0" }, disk: "0.7.0" });
  const button = p.reloadButton();
  // Precondition: the popup saw the newer files.
  expect(!!button).toBe(true);
  p.setDisk("0.6.0");
  button!.click();
  await p.settle();
  expect(p.reloads()).toBe(0);
  window.dispatchEvent(new Event("pagehide"));
});

// Task 328ef745: Chrome updates a store install by itself, so its update
// notice has no download and no Reload, and does not read as the unpacked one.
// The text of the visible parts of an element.
const shownText = (el: Element): string =>
  [...el.childNodes]
    .map((node) =>
      node.nodeType === 3
        ? node.textContent
        : node instanceof HTMLElement && !node.hidden
          ? shownText(node)
          : "",
    )
    .join(" ");
test("a store install's update notice has no download and no Reload, and differs from the unpacked notice", async () => {
  const update = { latest: "0.7.0" };
  const unpacked = await updatePopup({ update, disk: "0.6.0" });
  // Precondition: the unpacked notice shows the download.
  expect(unpacked.download()).toBe(true);
  const unpackedText = shownText(unpacked.notice);
  window.dispatchEvent(new Event("pagehide"));
  const store = await updatePopup({
    update,
    disk: "0.6.0",
    extra: { store: true },
  });
  expect(store.visible(store.notice)).toBe(true);
  expect(store.download()).toBe(false);
  expect(store.reloadButton()).toBeUndefined();
  expect(
    [...store.notice.querySelectorAll("a")].filter(store.visible),
  ).toHaveLength(0);
  expect(shownText(store.notice).trim().length).toBeGreaterThan(0);
  expect(shownText(store.notice)).not.toBe(unpackedText);
  window.dispatchEvent(new Event("pagehide"));
});

// Task 328ef745: an unpacked popup links the store listing (install from the
// store, pair, remove this copy); a store popup is that install already.
const LISTING =
  "https://chromewebstore.google.com/detail/isomux-browser/abcdefghijklmnopabcdefghijklmnop";
async function listingLinks(state: Record<string, unknown>) {
  document.body.innerHTML = popupHTML;
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    chrome: {
      storage: { session: noDraft },
      tabs: { query: async () => [{ id: 7, windowId: 1 }] },
      runtime: { sendMessage: async () => structuredClone(state) },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  // Precondition: the popup rendered the state.
  expect(document.getElementById("status")!.dataset.state).toBe(
    String(state.state),
  );
  const links = [...document.querySelectorAll("a")].filter(
    (a) => a.href === LISTING && !a.closest("[hidden]"),
  );
  window.dispatchEvent(new Event("pagehide"));
  return links;
}
test("the store listing link shows in an unpacked popup with a listing, paired or not, and never in a store popup", async () => {
  const connected = {
    state: "connected",
    generation: "g",
    office: "https://office.example.com",
    currentTab: { id: 7, eligible: true },
    agents: [{ id: "a", name: "Agent" }],
    assignments: [],
  };
  const unpaired = {
    state: "unpaired",
    office: "",
    agents: [],
    assignments: [],
  };
  for (const base of [connected, unpaired]) {
    const shown = await listingLinks({ ...base, storeUrl: LISTING });
    expect([base.state, shown.length]).toEqual([base.state, 1]);
    expect(shown[0].target).toBe("_blank");
    for (const extra of [{ store: true, storeUrl: LISTING }, {}])
      expect([
        base.state,
        extra,
        (await listingLinks({ ...base, ...extra })).length,
      ]).toEqual([base.state, extra, 0]);
  }
});

test("a failed offer names the dialog cause only when the tab did not answer", async () => {
  const { t } = translatorFor("en");
  for (const reason of ["unanswered", undefined]) {
    document.body.innerHTML = popupHTML;
    const state = {
      state: "connected",
      generation: "g",
      office: "https://example.com",
      currentTab: { id: 7, eligible: true },
      agents: [{ id: "a", name: "Agent" }],
      assignments: [],
    };
    const offers: unknown[] = [];
    await popupScript.runInNewContext({
      document,
      window,
      navigator: { language: "en" },
      Date,
      chrome: {
        storage: { session: noDraft },
        tabs: { query: async () => [{ id: 7, windowId: 1 }] },
        runtime: {
          sendMessage: async (message: Record<string, unknown>) => {
            if (message.action !== "offer") return structuredClone(state);
            offers.push(message);
            return { error: "fixture failure", ...(reason ? { reason } : {}) };
          },
        },
      },
      setInterval: () => 1,
      clearInterval() {},
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    const toggle = document.getElementById("allow") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await settle();
    // The enabling condition: the popup sent the offer.
    expect(offers).toHaveLength(1);
    expect(document.getElementById("error")!.textContent).toBe(
      t(reason ? "browser.tabUnanswered" : "browser.failed"),
    );
    window.dispatchEvent(new Event("pagehide"));
  }
});

// Task 7355640c: one Agents picker for both switches, "Use this tab" and
// "Open their own tabs". The popup sends the access setting at once; the
// background keeps it and answers with the new state.
type PopupState = Record<string, unknown> & { assignments: unknown[] };
const connected: PopupState = {
  state: "connected",
  generation: "g",
  office: "https://example.com",
  currentTab: { id: 7, eligible: true },
  agents: [{ id: "a", name: "Agent" }],
  members: [
    { id: "bob", name: "Bob" },
    { id: "carol", name: "Carol" },
  ],
  officeScope: true,
  sharedAccess: true,
  access: { agents: "mine", members: [], openTabs: false },
  assignments: [],
};
const settleDom = () => new Promise((resolve) => setTimeout(resolve, 0));
// A popup over a stand-in background that keeps the access it is sent.
// answer, when it returns a promise, answers that message instead.
// tab: the mutedInfo of the tab the popup opened on, and Chrome's answer to
// a tab update (default: it applies).
async function openPopup(
  initial: PopupState,
  answer?: (message: Record<string, unknown>) => Promise<unknown> | undefined,
  tab: {
    mutedInfo?: Record<string, unknown>;
    update?: () => Promise<void>;
    // The page the popup opened on, and its selected text; "refused": the
    // page takes no script (chrome://, the web store).
    url?: string;
    title?: string;
    selection?: string | "refused";
    // chrome.storage.local, kept across popup opens.
    local?: Map<string, unknown>;
  } = {},
) {
  document.body.innerHTML = popupHTML;
  let state = structuredClone(initial);
  const messages: Record<string, unknown>[] = [];
  const tabUpdates: Array<[number, Record<string, unknown>]> = [];
  const scripts: Record<string, unknown>[] = [];
  const local = tab.local ?? new Map<string, unknown>();
  const invocationTab = {
    id: 7,
    windowId: 1,
    url: tab.url ?? "https://example.com/post",
    title: tab.title ?? "A post",
    ...(tab.mutedInfo ? { mutedInfo: tab.mutedInfo } : {}),
  };
  let poll!: () => void;
  await popupScript.runInNewContext({
    document,
    window,
    navigator: { language: "en" },
    Date,
    chrome: {
      storage: { session: noDraft, local: localOn(local) },
      scripting: {
        executeScript: async (injection: Record<string, unknown>) => {
          scripts.push(injection);
          if (tab.selection === "refused")
            throw new Error("Cannot access a chrome:// URL");
          return [{ frameId: 0, result: tab.selection ?? "" }];
        },
      },
      tabs: {
        query: async () => [structuredClone(invocationTab)],
        get: async () => structuredClone(invocationTab),
        update: async (id: number, options: Record<string, unknown>) => {
          tabUpdates.push([id, options]);
          await tab.update?.();
          return { id, windowId: 1 };
        },
      },
      runtime: {
        id: "fixture-id",
        sendMessage: async (message: Record<string, unknown>) => {
          messages.push(message);
          const custom = answer?.(message);
          if (custom) return custom;
          if (message.action === "access")
            state = { ...state, access: structuredClone(message.access) };
          return structuredClone(state);
        },
      },
    },
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
    clearInterval() {},
  });
  await settleDom();
  return {
    messages,
    tabUpdates,
    scripts,
    local,
    sent: (action: string) => messages.filter((m) => m.action === action),
    set: (next: PopupState) => {
      state = structuredClone(next);
    },
    poll: async () => {
      poll();
      await settleDom();
    },
    picker: document.getElementById("agents") as HTMLSelectElement,
    members: document.getElementById("members")!,
    toggle: document.getElementById("allow") as HTMLInputElement,
    openTabs: document.getElementById("open-tabs") as HTMLInputElement,
    tabState: document.getElementById("tab-state")!,
  };
}
const optionValues = (picker: HTMLSelectElement) =>
  [...picker.options].filter((o) => !o.hidden).map((o) => o.value);
const memberBoxes = (members: HTMLElement) => [
  ...members.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];
const choose = async (picker: HTMLSelectElement, value: string) => {
  picker.value = value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await settleDom();
};

test("the popup has one Agents picker for both switches: it sends the access at once, shows the members to pick, and keeps the picks", async () => {
  const p = await openPopup(connected);
  try {
    // One Agents picker in the whole popup, and no expiry choice. The share
    // and office pickers choose an agent to share with and an office.
    expect(
      [...document.querySelectorAll("select")]
        .map((s) => s.id)
        .filter((id) => id !== "share-agent" && id !== "office-picker"),
    ).toEqual(["agents"]);
    expect(document.getElementById("expiry")).toBeNull();
    expect(optionValues(p.picker)).toEqual(["mine", "members", "office"]);
    const labels = [...p.picker.options].map((o) => o.textContent.trim());
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(3);
    expect(p.picker.value).toBe("mine");
    expect(p.picker.disabled).toBe(false);
    expect(p.members.hidden).toBe(true);
    expect([p.toggle, p.openTabs].map((s) => s.getAttribute("role"))).toEqual([
      "switch",
      "switch",
    ]);

    await choose(p.picker, "members");
    expect(p.sent("access").at(-1)?.access).toEqual({
      agents: "members",
      members: [],
      openTabs: false,
    });
    expect(p.members.hidden).toBe(false);
    expect(memberBoxes(p.members).map((b) => [b.value, b.checked])).toEqual([
      ["bob", false],
      ["carol", false],
    ]);
    expect(p.members.textContent).toContain("Bob");
    expect(p.members.textContent).toContain("Carol");

    memberBoxes(p.members)[0].click();
    await settleDom();
    expect(p.sent("access").at(-1)?.access).toEqual({
      agents: "members",
      members: ["bob"],
      openTabs: false,
    });
    expect(memberBoxes(p.members).map((b) => b.checked)).toEqual([true, false]);

    p.openTabs.click();
    await settleDom();
    expect(p.sent("access").at(-1)?.access).toEqual({
      agents: "members",
      members: ["bob"],
      openTabs: true,
    });

    // Back to My agents: the picks stay stored, the list goes.
    await choose(p.picker, "mine");
    expect(p.sent("access").at(-1)?.access).toEqual({
      agents: "mine",
      members: ["bob"],
      openTabs: true,
    });
    expect(p.members.hidden).toBe(true);

    // Use this tab names no agents and no expiry: the background picks.
    p.toggle.click();
    await settleDom();
    const offer = p.sent("offer").at(-1);
    expect(offer).toBeDefined();
    expect(["scope", "durationMinutes"].filter((k) => k in offer!)).toEqual([]);

    // No other member has an agent in the member's rooms: the list says so.
    p.set({
      ...connected,
      members: [],
      access: { agents: "members", members: [], openTabs: false },
    });
    await p.poll();
    expect(p.members.hidden).toBe(false);
    expect(memberBoxes(p.members)).toHaveLength(0);
    expect(p.members.textContent.trim()).not.toBe("");
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("with a tab on, the picker stays usable and a change applies at once; the switch stops control", async () => {
  const on = {
    ...connected,
    assignments: [
      {
        scope: { kind: "shared" },
        id: "grant",
        tabId: 7,
        current: true,
        phase: "on",
        durationMinutes: 0,
        expiresAt: null,
      },
    ],
  };
  const p = await openPopup(on);
  try {
    expect(p.toggle.checked).toBe(true);
    expect(p.tabState.textContent.trim()).not.toBe("");
    expect(p.picker.disabled).toBe(false);
    await choose(p.picker, "office");
    expect(p.sent("access").at(-1)?.access).toEqual({
      agents: "office",
      members: [],
      openTabs: false,
    });
    expect(p.sent("stop")).toEqual([]);
    expect(p.toggle.checked).toBe(true);
    p.toggle.click();
    await settleDom();
    expect(p.sent("stop").map((m) => m.assignment)).toEqual(["grant"]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("an office without shared access offers no members choice; a stored members pick shows as My agents, and a switch change keeps it stored", async () => {
  const rows: Array<[boolean, string[]]> = [
    [true, ["mine", "office"]],
    [false, ["mine"]],
  ];
  for (const [officeScope, values] of rows) {
    const p = await openPopup({
      ...connected,
      officeScope,
      sharedAccess: undefined,
      access: { agents: "members", members: ["bob"], openTabs: true },
    });
    try {
      expect({ officeScope, values: optionValues(p.picker) }).toEqual({
        officeScope,
        values,
      });
      expect(p.picker.value).toBe("mine");
      expect(p.members.hidden).toBe(true);
      expect(p.openTabs.checked).toBe(true);
      expect(p.sent("access")).toEqual([]);
      // Turning Open their own tabs off changes only that: the background
      // tells this office My agents, and the picks wait for an office that
      // takes them.
      p.openTabs.click();
      await settleDom();
      expect({ officeScope, access: p.sent("access").at(-1)?.access }).toEqual({
        officeScope,
        access: { agents: "members", members: ["bob"], openTabs: false },
      });
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
});

test("the tabs agents opened are listed under Open their own tabs, with Show and Close", async () => {
  const opened = (id: string, agent: string, manager?: string) => ({
    scope: { kind: "opened", agentId: agent, via: manager ? "office" : "all" },
    id,
    agent: { id: agent, name: agent },
    ...(manager ? { manager: { name: manager } } : {}),
    tabId: 9,
    current: false,
    phase: "on",
    durationMinutes: 0,
    expiresAt: null,
  });
  const p = await openPopup({
    ...connected,
    access: { agents: "members", members: ["bob"], openTabs: true },
    assignments: [opened("t1", "Helper"), opened("t2", "Builder", "Bob")],
  });
  try {
    const list = document.getElementById("agent-tabs-list")!;
    expect(
      p.openTabs.compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    const rows = [...list.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Helper");
    expect(rows[1].textContent).toContain("Builder");
    expect(rows[1].textContent).toContain("Bob");
    const [show, close] = [...rows[1].querySelectorAll("button")];
    show.click();
    await settleDom();
    close.click();
    await settleDom();
    // Close tab closes the tab (task 9361ce1b); Off ("stop") only ends
    // control and leaves it open.
    expect(
      p.messages
        .filter((m) => ["focus", "stop", "close"].includes(String(m.action)))
        .map((m) => [m.action, m.assignment]),
    ).toEqual([
      ["focus", "t2"],
      ["close", "t2"],
    ]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("Close tab goes through while another popup command still waits", async () => {
  const opened = (id: string) => ({
    scope: { kind: "opened", agentId: "a", via: "all" },
    id,
    agent: { id: "a", name: "Helper" },
    tabId: 9,
    current: false,
    phase: "on",
    durationMinutes: 0,
    expiresAt: null,
  });
  let answerFocus!: (value: unknown) => void;
  const p = await openPopup(
    {
      ...connected,
      access: { agents: "mine", members: [], openTabs: true },
      assignments: [opened("t1"), opened("t2")],
    },
    (message) =>
      message.action === "focus"
        ? new Promise((resolve) => {
            answerFocus = resolve;
          })
        : undefined,
  );
  try {
    const rows = [
      ...document.getElementById("agent-tabs-list")!.querySelectorAll("li"),
    ];
    const [show] = [...rows[0].querySelectorAll("button")];
    const [, close] = [...rows[1].querySelectorAll("button")];
    show.click();
    await settleDom();
    // The enabling state: Show tab was sent and has no answer yet.
    expect(p.sent("focus").map((m) => m.assignment)).toEqual(["t1"]);
    close.click();
    await settleDom();
    expect(p.sent("close").map((m) => m.assignment)).toEqual(["t2"]);
    answerFocus(undefined);
    await settleDom();
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("Use this tab stays locked until the office answers, unlocks after a refusal, and follows the tab's phase", async () => {
  let accept!: (value: unknown) => void;
  const p = await openPopup(connected, (message) =>
    message.action === "offer"
      ? new Promise((resolve) => {
          accept = resolve;
        })
      : undefined,
  );
  try {
    expect(p.toggle.checked).toBe(false);
    expect(p.toggle.disabled).toBe(false);
    expect(p.tabState.textContent).toBe("");
    p.toggle.click();
    await settleDom();
    expect(p.sent("offer")).toHaveLength(1);
    expect(p.toggle.disabled).toBe(true);
    // A poll before the answer does not unlock the switch.
    await p.poll();
    expect(p.toggle.disabled).toBe(true);
    accept({ ...structuredClone(connected), error: "fixture refused" });
    await settleDom();
    expect(document.getElementById("error")!.textContent).not.toBe("");
    await p.poll();
    expect([p.toggle.disabled, p.toggle.checked]).toEqual([false, false]);

    const grant = {
      scope: { kind: "shared" },
      id: "grant",
      tabId: 7,
      current: true,
      durationMinutes: 0,
      expiresAt: null,
    };
    const phases: Array<[string, boolean, boolean]> = [
      // [phase, checked, disabled]
      ["offering", true, false],
      ["on", true, false],
      ["revoking", false, true],
    ];
    for (const [phase, checked, disabled] of phases) {
      p.set({ ...connected, assignments: [{ ...grant, phase }] });
      await p.poll();
      expect({
        phase,
        checked: p.toggle.checked,
        disabled: p.toggle.disabled,
        line: p.tabState.textContent.trim() !== "",
      }).toEqual({ phase, checked, disabled, line: true });
    }
    // A tab the extension cannot offer: the switch is off and says why.
    p.set({ ...connected, currentTab: { id: 7, eligible: false } });
    await p.poll();
    expect([p.toggle.disabled, p.tabState.textContent.trim() !== ""]).toEqual([
      true,
      true,
    ]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

// Task ded3ae49: Chrome's tab menu cannot unmute a tab an extension muted, so
// the popup offers Unmute tab on a tab this extension muted, paired or not.
const OURS = { muted: true, reason: "extension", extensionId: "fixture-id" };
const UNPAIRED: PopupState = {
  state: "unpaired",
  office: "",
  agents: [],
  assignments: [],
};
// The element and none of its ancestors is hidden.
const shown = (element: HTMLElement | null) => {
  for (let node = element; node; node = node.parentElement)
    if (node.hidden) return false;
  return !!element;
};

test("the popup offers Unmute tab only on a tab this extension muted; it unmutes the tab and hides, and stays after a refused update", async () => {
  const rows: Array<[string, PopupState, Record<string, unknown> | undefined]> =
    [
      ["not muted", connected, undefined],
      ["unmuted by this extension", connected, { ...OURS, muted: false }],
      ["muted by the member", connected, { muted: true, reason: "user" }],
      [
        "muted by another extension",
        connected,
        { ...OURS, extensionId: "other" },
      ],
    ];
  for (const [name, state, mutedInfo] of rows) {
    await openPopup(state, undefined, { mutedInfo });
    try {
      expect({
        name,
        shown: shown(document.getElementById("unmute-tab")),
      }).toEqual({ name, shown: false });
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
  for (const state of [connected, UNPAIRED]) {
    const p = await openPopup(state, undefined, { mutedInfo: OURS });
    try {
      const button = document.getElementById("unmute-tab") as HTMLElement;
      expect({ state: state.state, shown: shown(button) }).toEqual({
        state: state.state,
        shown: true,
      });
      expect(button.textContent?.trim()).toBeTruthy();
      button.click();
      await settleDom();
      expect(p.tabUpdates).toEqual([[7, { muted: false }]]);
      expect(shown(button)).toBe(false);
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
  // Chrome refuses the update, for example because the tab closed.
  const refused = await openPopup(connected, undefined, {
    mutedInfo: OURS,
    update: async () => {
      throw new Error("No tab with id: 7.");
    },
  });
  try {
    const button = document.getElementById("unmute-tab") as HTMLElement;
    button.click();
    await settleDom();
    // The enabling state: the popup asked Chrome.
    expect(refused.tabUpdates).toEqual([[7, { muted: false }]]);
    expect(shown(button)).toBe(true);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

// Share page with agent (task 68da3968): a picker of the agents the member
// reaches, grouped by room, that keeps the last pick per office, and a Share
// button that sends the popup's page.
const SHARING: PopupState = {
  ...connected,
  share: true,
  shareAgents: [
    { id: "far", name: "Far", room: "Alpha" },
    { id: "zed", name: "Zed", room: "Beta" },
    { id: "ann", name: "Ann", room: "Beta" },
  ],
};
const shareParts = () => ({
  section: document.getElementById("share-section"),
  picker: document.getElementById("share-agent") as HTMLSelectElement,
  button: document.getElementById("share") as HTMLButtonElement,
  status: document.getElementById("share-status")!,
});

test("the share picker groups the agents by room, starts with no pick, and keeps the last pick for its office", async () => {
  const local = new Map<string, unknown>();
  const p = await openPopup(SHARING, undefined, { local });
  try {
    const ui = shareParts();
    expect(shown(ui.section)).toBe(true);
    expect(
      [...ui.picker.querySelectorAll("optgroup")].map((group) => [
        group.label,
        [...group.querySelectorAll("option")].map((o) => o.value),
      ]),
    ).toEqual([
      ["Alpha", ["far"]],
      ["Beta", ["zed", "ann"]],
    ]);
    expect(ui.picker.textContent).toContain("Ann");
    expect(ui.picker.value).toBe("");
    expect(ui.button.disabled).toBe(true);
    await choose(ui.picker, "ann");
    expect(ui.button.disabled).toBe(false);
    // A poll keeps the pick.
    await p.poll();
    expect(shareParts().picker.value).toBe("ann");
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
  const reopens: Array<[PopupState, string]> = [
    [SHARING, "ann"],
    // Another office: the pick was for the first one.
    [{ ...SHARING, office: "https://other.example" }, ""],
    // The agent is no longer in the list.
    [
      {
        ...SHARING,
        shareAgents: (SHARING.shareAgents as { id: string }[]).filter(
          (agent) => agent.id !== "ann",
        ),
      },
      "",
    ],
  ];
  for (const [state, value] of reopens) {
    await openPopup(state, undefined, { local });
    try {
      const ui = shareParts();
      expect([state.office, ui.picker.value]).toEqual([state.office, value]);
      expect(ui.button.disabled).toBe(value === "");
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
});

test("Share sends the popup's page, its selected text and the pick, waits while pending, and says how each share ended", async () => {
  let finish!: (value: unknown) => void;
  const p = await openPopup(
    SHARING,
    (message) =>
      message.action === "share"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
    { selection: "Read this" },
  );
  try {
    const ui = shareParts();
    await choose(ui.picker, "ann");
    const statuses: string[] = [];
    for (const result of ["sent", "awaits_member_answer", "unanswered"]) {
      ui.button.click();
      await settleDom();
      expect(p.sent("share").at(-1)).toMatchObject({
        agentId: "ann",
        url: "https://example.com/post",
        title: "A post",
        selection: "Read this",
      });
      // No second share while one waits.
      expect(ui.button.disabled).toBe(true);
      const count = p.sent("share").length;
      ui.button.click();
      await settleDom();
      expect(p.sent("share")).toHaveLength(count);
      finish({ ...structuredClone(SHARING), shareResult: result });
      await settleDom();
      expect(ui.button.disabled).toBe(false);
      statuses.push(ui.status.textContent.trim());
    }
    expect(p.sent("share")).toHaveLength(3);
    // The selection is read from the popup's tab, main frame only.
    const target = p.scripts[0].target as Record<string, unknown>;
    expect(target.tabId).toBe(7);
    expect(target.allFrames).toBeFalsy();
    // Sent names the agent; each ending reads differently.
    expect(statuses[0]).toContain("Ann");
    expect(statuses.every(Boolean)).toBe(true);
    expect(new Set(statuses).size).toBe(3);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("a page that takes no script shares its link and title with no selected text", async () => {
  const p = await openPopup(SHARING, undefined, {
    url: "https://chromewebstore.google.com/detail/x",
    title: "Store page",
    selection: "refused",
  });
  try {
    const ui = shareParts();
    await choose(ui.picker, "far");
    ui.button.click();
    await settleDom();
    expect(p.scripts).toHaveLength(1);
    const share = p.sent("share").at(-1)!;
    expect([share.url, share.title, share.agentId]).toEqual([
      "https://chromewebstore.google.com/detail/x",
      "Store page",
      "far",
    ]);
    expect(share.selection).toBeFalsy();
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("Share shows only on a connected office that takes it, and a page that is not http(s) cannot be shared", async () => {
  for (const state of [connected, { ...UNPAIRED, share: true }]) {
    await openPopup(state);
    try {
      expect(shown(shareParts().section)).toBe(false);
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
  for (const url of ["chrome://extensions/", "file:///home/a.html"]) {
    const p = await openPopup(SHARING, undefined, { url });
    try {
      const ui = shareParts();
      expect(shown(ui.section)).toBe(true);
      await choose(ui.picker, "far");
      expect(ui.button.disabled).toBe(true);
      expect(ui.status.textContent.trim()).not.toBe("");
      ui.button.click();
      await settleDom();
      expect(p.sent("share")).toEqual([]);
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
});

// Task 811ed3de: with an office paired, a picker over the office section
// lists every paired office; the section below shows the picked one.
const ONE_OFFICE = "https://example.com";
const TWO_OFFICE = "https://two.example";
const bothOffices = (two: string): PopupState => ({
  ...connected,
  offices: [
    { office: ONE_OFFICE, state: "connected" },
    { office: TWO_OFFICE, state: two },
  ],
});
const officePicker = () =>
  document.getElementById("office-picker") as HTMLSelectElement | null;
const optionOf = (picker: HTMLSelectElement, value: string) =>
  [...picker.options].find((o) => o.value === value);

test("the office picker lists each paired office with its state, a pick names that office in the popup's commands, and the extra option shows an empty pair form", async () => {
  const second = (): PopupState => ({
    ...bothOffices("connected"),
    office: TWO_OFFICE,
    generation: "g2",
  });
  const p = await openPopup(bothOffices("offline"), (message) =>
    message.office === TWO_OFFICE
      ? Promise.resolve(structuredClone(second()))
      : undefined,
  );
  try {
    const picker = officePicker();
    expect(shown(picker)).toBe(true);
    const values = [...picker!.options].map((o) => o.value);
    expect(values).toHaveLength(3);
    expect(values).toContain(ONE_OFFICE);
    expect(values).toContain(TWO_OFFICE);
    expect(picker!.value).toBe(ONE_OFFICE);
    expect(optionOf(picker!, TWO_OFFICE)!.textContent).toContain("two.example");
    // Each option shows its office's state.
    const offline = optionOf(picker!, TWO_OFFICE)!.textContent;
    p.set(bothOffices("connected"));
    await p.poll();
    expect(optionOf(picker!, TWO_OFFICE)!.textContent).not.toBe(offline);

    await choose(picker!, TWO_OFFICE);
    await settleDom();
    expect(p.messages.at(-1)).toMatchObject({ office: TWO_OFFICE });
    expect(picker!.value).toBe(TWO_OFFICE);
    p.toggle.click();
    await settleDom();
    expect(p.sent("offer").at(-1)).toMatchObject({
      office: TWO_OFFICE,
      generation: "g2",
    });

    const add = values.find((v) => v !== ONE_OFFICE && v !== TWO_OFFICE)!;
    await choose(picker!, add);
    expect(shown(document.getElementById("pair-form"))).toBe(true);
    expect(
      [
        document.getElementById("office") as HTMLInputElement,
        document.getElementById("code") as HTMLInputElement,
      ].map((input) => input.value),
    ).toEqual(["", ""]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("on a tab another office holds, Use this tab is off and locked and names that office", async () => {
  const p = await openPopup({
    ...bothOffices("connected"),
    currentTab: { id: 7, eligible: true, office: TWO_OFFICE },
  });
  try {
    expect([p.toggle.checked, p.toggle.disabled]).toEqual([false, true]);
    expect(p.tabState.textContent).toContain("two.example");
    p.toggle.click();
    await settleDom();
    expect(p.sent("offer")).toEqual([]);
    // The enabling condition: the same tab, held by no office.
    p.set({
      ...bothOffices("connected"),
      currentTab: { id: 7, eligible: true },
    });
    await p.poll();
    expect([p.toggle.checked, p.toggle.disabled]).toEqual([false, false]);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("with no office paired, the popup shows the pair form and no office picker", async () => {
  await openPopup({ ...UNPAIRED, offices: [] });
  try {
    expect(shown(officePicker())).toBe(false);
    expect(shown(document.getElementById("pair-form"))).toBe(true);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

// Task cfbf6ba5: the picker already names the office and its state, so the
// popup does not show them a second time.
test("with the office picker shown, the status line shows only for the steps the picker shortens, and the office shows once", async () => {
  const statusLine = () => document.getElementById("status")!;
  const away = { url: "https://page.test/post" };
  const visibleText = () => shownText(document.querySelector("main")!);
  // Connected: the picker option says it all.
  await openPopup(bothOffices("connected"), undefined, away);
  try {
    expect(shown(officePicker())).toBe(true);
    expect(statusLine().dataset.state).toBe("connected");
    expect(shown(statusLine())).toBe(false);
    expect(visibleText().split("example.com")).toHaveLength(2);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
  // Blocked and unknown: the option is the short form, the line the step.
  for (const state of ["blocked", "unknown"]) {
    await openPopup(
      {
        ...connected,
        state,
        offices: [
          { office: ONE_OFFICE, state },
          { office: TWO_OFFICE, state: "connected" },
        ],
      },
      undefined,
      away,
    );
    try {
      expect(shown(officePicker())).toBe(true);
      expect(statusLine().dataset.state).toBe(state);
      expect(shown(statusLine())).toBe(true);
      // Add an office: the step names the office picked before.
      const add = [...officePicker()!.options].find(
        (o) => o.value !== ONE_OFFICE && o.value !== TWO_OFFICE,
      )!.value;
      await choose(officePicker()!, add);
      expect(shown(document.getElementById("pair-form"))).toBe(true);
      expect(shown(statusLine())).toBe(false);
    } finally {
      window.dispatchEvent(new Event("pagehide"));
    }
  }
  // No office paired: no picker, so the line says so.
  await openPopup({ ...UNPAIRED, offices: [] });
  try {
    expect(shown(officePicker())).toBe(false);
    expect(statusLine().dataset.state).toBe("unpaired");
    expect(shown(statusLine())).toBe(true);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});

test("Share and Use this tab come before the member list, and the browser owner line comes after the tab controls", async () => {
  await openPopup(connected);
  try {
    const at = (id: string) => document.getElementById(id)!;
    const before = (a: string, b: string) =>
      (at(a).compareDocumentPosition(at(b)) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;
    expect(before("share", "allow")).toBe(true);
    expect(before("allow", "agents")).toBe(true);
    expect(before("allow", "members-list")).toBe(true);
    expect(before("tab-control", "member")).toBe(true);
    expect(at("tab-control").contains(at("member"))).toBe(false);
  } finally {
    window.dispatchEvent(new Event("pagehide"));
  }
});
