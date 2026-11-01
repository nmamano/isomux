import { test, expect } from "bun:test";
import { setUpDomTestFile } from "../ui/test-support/dom";
import { translatorFor } from "../shared/i18n/translate";

setUpDomTestFile();
const { Script } = await import("node:vm");
const { readFile } = await import("node:fs/promises");
// Build and compile once; each popup still gets a fresh VM context and DOM.
const build = await Bun.build({
  entrypoints: ["browser-extension/connection.ts"],
  target: "browser",
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
async function openPopup(
  initial: PopupState,
  answer?: (message: Record<string, unknown>) => Promise<unknown> | undefined,
) {
  document.body.innerHTML = popupHTML;
  let state = structuredClone(initial);
  const messages: Record<string, unknown>[] = [];
  let poll!: () => void;
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
    // One picker in the whole popup, and no expiry choice.
    expect([...document.querySelectorAll("select")].map((s) => s.id)).toEqual([
      "agents",
    ]);
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
