// The WhatsApp card of the Integrations Messaging tab (task d03a61d8): the member links their own
// WhatsApp by QR or by a pairing code, sees the live status the server
// pushes, and unlinks. Rendered over a live reducer, so a whatsapp_status
// message reaches the section as it does from the socket.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render, act } = await import("@testing-library/react");
const { WhatsAppSection } = await import("./WhatsAppSection.tsx");
const { asMember, selfUserRecord, stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { getWhatsAppLayout, setWhatsAppLayout, WHATSAPP_HELD_ROWS_MAX } =
  await import("../device-settings.ts");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { ApiError, setApiShim } = await import("../api.ts");

type WhatsAppStatus = import("../../shared/whatsapp.ts").WhatsAppStatus;
type Action = Parameters<typeof reducer>[1];
type WhatsAppRoute = import("../../shared/whatsapp.ts").WhatsAppRoute;
type WhatsAppChatSeen = import("../../shared/whatsapp.ts").WhatsAppChatSeen;
type AppState = import("../store.tsx").AppState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type RoomWire = import("../../shared/types.ts").RoomWire;

let current: WhatsAppStatus = { state: "unlinked" };
let calls: { method: string; path: string; body: unknown }[] = [];
let linkAnswer: () => Promise<unknown> = async () => current;
// The contact rows (slice 2).
let rows: WhatsAppRoute[] = [];
let seenChats: WhatsAppChatSeen[] = [];
let rowAnswer: (body: unknown) => Promise<unknown> = async () => ({});
// An edit (task 70fae82c): the server's answer to a PATCH of a row.
let patchAnswer: (path: string, body: unknown) => Promise<unknown> = async (
  path,
  body,
) => {
  const id = path.split("/").at(-1);
  rows = rows.map((r) =>
    r.id === id ? ({ ...r, ...(body as object) } as WhatsAppRoute) : r,
  );
  return rows.find((r) => r.id === id);
};
const defaultPatchAnswer = patchAnswer;
// The held layout (task eeec205a): a read held open until its release, and a
// read that fails.
let statusGate: Promise<void> | null = null;
let routesGate: Promise<void> | null = null;
let statusFails = false;
let routesFail = false;

beforeEach(() => {
  statusGate = null;
  routesGate = null;
  statusFails = false;
  routesFail = false;
  window.localStorage.removeItem("isomux-whatsapp-layout");
  current = { state: "unlinked" };
  calls = [];
  linkAnswer = async () => current;
  rows = [];
  seenChats = [];
  rowAnswer = async () => ({});
  patchAnswer = defaultPatchAnswer;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/whatsapp/routes") {
      if (routesGate) await routesGate;
      if (routesFail) throw new ApiError(500, "internal", "Internal");
      return rows;
    }
    if (method === "GET" && path === "/api/whatsapp/chats") return seenChats;
    if (method === "POST" && path === "/api/whatsapp/routes")
      return rowAnswer(body);
    if (method === "PATCH" && path.startsWith("/api/whatsapp/routes/"))
      return patchAnswer(path, body);
    if (method === "DELETE" && path.startsWith("/api/whatsapp/routes/")) {
      rows = rows.filter((r) => !path.endsWith(`/${r.id}`));
      return undefined;
    }
    if (method === "GET" && path === "/api/whatsapp") {
      if (statusGate) await statusGate;
      if (statusFails) throw new ApiError(500, "internal", "Internal");
      return current;
    }
    if (method === "POST" && path === "/api/whatsapp/link") return linkAnswer();
    if (method === "DELETE" && path === "/api/whatsapp") return undefined;
    throw new Error(`unexpected ${method} ${path}`);
  });
});

afterAll(() => setApiShim(null));

async function settle() {
  await act(async () => {});
}

async function show(over: Partial<AppState> = {}) {
  let state = stateWithSelfUser(null, over);
  const tree = () => (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider
        value={(action) => {
          state = reducer(state, action);
          view.rerender(tree());
        }}
      >
        <LanguageProvider>
          <WhatsAppSection />
        </LanguageProvider>
      </DispatchCtx.Provider>
    </StateCtx.Provider>
  );
  const view = render(tree());
  await settle();
  // A server push, as the socket dispatches it.
  const push = async (status: WhatsAppStatus) => {
    const action: Action = { type: "whatsapp_status", status };
    await act(async () => {
      state = reducer(state, action);
      view.rerender(tree());
    });
  };
  const q = (selector: string) => view.container.querySelector(selector);
  const click = async (selector: string) => {
    const el = q(selector);
    if (!(el instanceof HTMLElement)) throw new Error(`no ${selector}`);
    await act(async () => {
      fireEvent.click(el);
    });
    await settle();
  };
  const card = () =>
    q("[data-integrations-card=whatsapp]")?.getAttribute("data-whatsapp-state");
  return { view, push, q, click, card };
}

const writes = () => calls.filter((c) => c.method !== "GET");

it("links by QR: one POST, the pushed QR shows, then the linked number; Unlink sends DELETE", async () => {
  const s = await show();
  expect(s.card()).toBe("unlinked");
  linkAnswer = async () => ({ state: "linking", method: "qr" });
  await s.click("[data-whatsapp-link]");
  expect(writes()).toEqual([
    { method: "POST", path: "/api/whatsapp/link", body: { method: "qr" } },
  ]);
  expect(s.card()).toBe("linking");
  expect(s.q("[data-whatsapp-qr]")).toBeNull();

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" data-code="Q1"></svg>';
  await s.push({ state: "linking", method: "qr", qrSvg: svg });
  const img = s.q("img[data-whatsapp-qr]");
  expect(img).not.toBeNull();
  const src = img!.getAttribute("src") ?? "";
  expect(src.startsWith("data:image/svg+xml")).toBe(true);
  expect(decodeURIComponent(src)).toContain('data-code="Q1"');
  // Never as markup in the page.
  expect(s.q("svg[data-code]")).toBeNull();

  await s.push({
    state: "linked",
    phone: "447700900123",
    linkedAt: 1,
    connected: true,
  });
  expect(s.card()).toBe("linked");
  expect(s.view.container.textContent).toContain("447700900123");
  expect(
    s.q("[data-whatsapp-connected]")?.getAttribute("data-whatsapp-connected"),
  ).toBe("true");

  await s.click("[data-whatsapp-unlink]");
  expect(writes().slice(1)).toEqual([
    { method: "DELETE", path: "/api/whatsapp", body: undefined },
  ]);
  expect(s.card()).toBe("unlinked");
});

it("asks for a code with the typed number, once per click, and shows the pushed code", async () => {
  const s = await show();
  await s.click("[data-whatsapp-code-form]");
  const field = s.q('input[name="whatsappPhone"]');
  if (!(field instanceof HTMLInputElement)) throw new Error("no phone field");
  await act(async () => {
    fireEvent.change(field, { target: { value: "+44 7700 900123" } });
  });
  linkAnswer = async () => ({ state: "linking", method: "code" });
  await s.click("[data-whatsapp-get-code]");
  expect(writes()).toEqual([
    {
      method: "POST",
      path: "/api/whatsapp/link",
      body: { method: "code", phone: "+44 7700 900123" },
    },
  ]);
  await s.push({ state: "linking", method: "code", pairingCode: "ABCD1234" });
  expect(s.q("[data-whatsapp-pairing-code]")?.textContent).toContain(
    "ABCD1234",
  );
});

it("a refused number and a code asked too soon each show their own line", async () => {
  const s = await show();
  await s.click("[data-whatsapp-code-form]");
  const field = s.q('input[name="whatsappPhone"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(field, { target: { value: "12345" } });
  });
  const alertFor = async (status: number, code: string) => {
    linkAnswer = async () => {
      throw new ApiError(status, code, "refused");
    };
    await s.click("[data-whatsapp-get-code]");
    const alert = s.q('[role="alert"]');
    expect(alert, String(status)).not.toBeNull();
    return alert!.textContent;
  };
  const badNumber = await alertFor(400, "invalid_request");
  const tooSoon = await alertFor(429, "too_many_codes");
  expect(badNumber).not.toBe(tooSoon);
  expect(s.card()).toBe("unlinked");
});

it("a dead link shows its reason and offers to link again", async () => {
  current = { state: "dead", reason: "crash_loop", phone: "447700900123" };
  const s = await show();
  expect(s.card()).toBe("dead");
  expect(
    s.q("[data-whatsapp-reason]")?.getAttribute("data-whatsapp-reason"),
  ).toBe("crash_loop");
  expect(s.q("[data-whatsapp-link]")).not.toBeNull();
});

// The contact rows of a linked member (slice 2). The self user is u1.
const LINKED: WhatsAppStatus = {
  state: "linked",
  phone: "447700900111",
  linkedAt: 1,
  connected: true,
};
const agent = (id: string, name: string, userId: string, access: string) =>
  ({ id, name, userId, access }) as unknown as AgentInfo;
const AGENTS = [
  agent("a-office", "Helper", "u1", "office"),
  agent("a-std", "Shell", "u1", "standard"),
  agent("a-chat", "Talker", "u1", "chat"),
  agent("a-other", "Not mine", "u2", "office"),
];
const MOM = "447700900123@s.whatsapp.net";
const FAMILY = "120363000000000001@g.us";

async function openAdd(s: Awaited<ReturnType<typeof show>>) {
  await s.click("[data-integrations-add]");
  const form = s.q("[data-whatsapp-add-form]");
  if (!(form instanceof HTMLElement)) throw new Error("no add form");
  return form;
}
const field = (root: Element, name: string) => {
  const el = root.querySelector(`[name="${name}"]`);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement))
    throw new Error(`no ${name}`);
  return el;
};
async function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}
const posts = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/api/whatsapp/routes");
// The picker's "add a person by phone number" choice.
const byNumber = (form: Element) => {
  const el = form.querySelector("option[data-whatsapp-by-number]");
  if (!(el instanceof HTMLOptionElement))
    throw new Error("no by-number option");
  return el;
};
const saveDisabled = (form: Element) =>
  (form.querySelector("[data-panel-save]") as HTMLButtonElement).disabled;
// Where an option sits: the index of its optgroup in the select, or -1 at
// the top level.
const groupOf = (select: HTMLSelectElement, value: string) => {
  const opt = [...select.options].find((o) => o.value === value);
  if (!opt) throw new Error(`no option ${value}`);
  const parent = opt.parentElement;
  return parent instanceof HTMLOptGroupElement
    ? [...select.querySelectorAll("optgroup")].indexOf(parent)
    : -1;
};
const groupValues = (select: HTMLSelectElement) =>
  [...select.querySelectorAll("optgroup")].map((g) =>
    [...g.querySelectorAll("option")].map((o) => o.value),
  );

it("the chat picker opens on a disabled prompt and Add waits for a pick; people and groups each have their own group in the server's order, by number above them", async () => {
  current = LINKED;
  const DAD = "447700900124@s.whatsapp.net";
  const WORK = "120363000000000002@g.us";
  // Newest first, people and groups mixed, as the server sends them.
  seenChats = [
    { chat: FAMILY, name: "Family", group: true },
    { chat: MOM, name: "Mom", group: false },
    { chat: WORK, name: "Work", group: true },
    { chat: DAD, name: "Dad", group: false },
  ];
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  const picker = field(form, "whatsappChat") as HTMLSelectElement;

  // Nothing picked: the selected option is a disabled prompt, no number
  // field, and Add stays disabled even with a name and an agent.
  expect(picker.selectedOptions[0]?.disabled).toBe(true);
  expect(groupOf(picker, picker.value)).toBe(-1);
  expect(form.querySelector('[name="whatsappRowPhone"]')).toBeNull();
  await change(field(form, "whatsappRowName"), "Someone");
  expect((field(form, "whatsappRowAgent") as HTMLSelectElement).value).not.toBe(
    "",
  );
  expect(saveDisabled(form)).toBe(true);

  // By number: its own top-level option, after the prompt and the member's
  // own number (task 610f7756) and before the groups; it shows the number
  // field, and a number makes Add ready.
  const top = [...picker.children].map((c) => c.tagName);
  expect(top).toEqual(["OPTION", "OPTION", "OPTION", "OPTGROUP", "OPTGROUP"]);
  expect(byNumber(form).disabled).toBe(false);
  expect(byNumber(form).parentElement?.tagName).toBe("SELECT");
  await change(picker, byNumber(form).value);
  expect(saveDisabled(form)).toBe(true);
  await change(field(form, "whatsappRowPhone"), "+44 7700 900125");
  expect(saveDisabled(form)).toBe(false);

  // People first, then groups; each in the server's order.
  expect(groupValues(picker)).toEqual([
    [MOM, DAD],
    [FAMILY, WORK],
  ]);
  // A pick from the list needs no number.
  await change(picker, WORK);
  expect(form.querySelector('[name="whatsappRowPhone"]')).toBeNull();
  expect(saveDisabled(form)).toBe(false);
});

it("the chat picker leaves out an empty group, and opens on the prompt again after a pick", async () => {
  current = LINKED;
  seenChats = [{ chat: FAMILY, name: "Family", group: true }];
  const s = await show({ agents: AGENTS });
  let form = await openAdd(s);
  let picker = field(form, "whatsappChat") as HTMLSelectElement;
  expect(groupValues(picker)).toEqual([[FAMILY]]);
  expect(groupOf(picker, FAMILY)).toBe(0);

  await change(picker, FAMILY);
  expect(picker.value).toBe(FAMILY);
  // Cancel: the button before Save.
  const cancel =
    form.querySelector("[data-panel-save]")?.previousElementSibling;
  if (!(cancel instanceof HTMLButtonElement)) throw new Error("no cancel");
  await act(async () => {
    fireEvent.click(cancel);
  });
  expect(s.q("[data-whatsapp-add-form]")).toBeNull();
  form = await openAdd(s);
  picker = field(form, "whatsappChat") as HTMLSelectElement;
  expect(picker.selectedOptions[0]?.disabled).toBe(true);
  expect(saveDisabled(form)).toBe(true);
});

it("the agent picker groups the member's agents by room, in the office's room order and desk order, and starts on the first", async () => {
  current = LINKED;
  const room = (id: string, name: string) =>
    ({ id, name, prompt: null, canCloseWhenEmpty: true }) as RoomWire;
  const placed = (
    id: string,
    roomId: string,
    desk: number,
    userId = "u1",
    access = "office",
  ) => ({ ...agent(id, id, userId, access), roomId, desk }) as AgentInfo;
  const s = await show({
    // Office order: Beta before Alpha; Empty holds none of the member's.
    rooms: [room("rb", "Beta"), room("rx", "Empty"), room("ra", "Alpha")],
    agents: [
      placed("a1", "ra", 0),
      placed("b2", "rb", 3),
      placed("b1", "rb", 1),
      placed("a-talk", "ra", 2, "u1", "chat"),
      placed("x-other", "rx", 0, "u2"),
    ],
  });
  const form = await openAdd(s);
  const select = field(form, "whatsappRowAgent") as HTMLSelectElement;
  expect(groupValues(select)).toEqual([["b1", "b2"], ["a1"]]);
  expect(select.value).toBe("b1");
});

it("an agent whose room the member does not see is still a choice", async () => {
  current = LINKED;
  const s = await show({
    rooms: [],
    agents: [
      {
        ...agent("lost", "Lost", "u1", "office"),
        roomId: "gone",
        desk: 0,
      } as AgentInfo,
    ],
  });
  const form = await openAdd(s);
  const select = field(form, "whatsappRowAgent") as HTMLSelectElement;
  expect([...select.options].map((o) => o.value)).toEqual(["lost"]);
  expect(select.value).toBe("lost");
});

it("lists the rows with their number or group, agent, trigger and a dead marker; Delete removes one", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: MOM,
      group: false,
      name: "Mom",
      agentId: "a-office",
      createdAt: 1,
    },
    {
      id: "r2",
      chat: FAMILY,
      group: true,
      name: "Family",
      agentId: "a-std",
      trigger: "mention",
      createdAt: 1,
      dead: "agent_not_yours",
    },
  ];
  const s = await show({ agents: AGENTS });
  const row1 = s.q('[data-whatsapp-row="r1"]');
  expect(row1?.textContent).toContain("Mom");
  expect(row1?.textContent).toContain("+447700900123");
  expect(row1?.textContent).toContain("Helper");
  expect(s.q('[data-whatsapp-row="r1"] [data-whatsapp-row-dead]')).toBeNull();
  expect(
    s
      .q('[data-whatsapp-row="r2"] [data-whatsapp-row-dead]')
      ?.getAttribute("data-whatsapp-row-dead"),
  ).toBe("agent_not_yours");
  expect(s.q('[data-whatsapp-row="r2"]')?.textContent).not.toContain("120363");

  await s.click('[data-whatsapp-row-delete="r1"]');
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(
    ["/api/whatsapp/routes/r1"],
  );
  expect(s.q('[data-whatsapp-row="r1"]')).toBeNull();
  expect(s.q('[data-whatsapp-row="r2"]')).not.toBeNull();
  expect(s.q('[role="alert"]')).toBeNull();
});

it("adds a group from the picker: routed chats left out, the name prefilled, only the member's agents above Chat stop, the trigger sent", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: MOM,
      group: false,
      name: "Mom",
      agentId: "a-office",
      createdAt: 1,
    },
  ];
  seenChats = [
    { chat: MOM, name: "Mom", group: false },
    { chat: FAMILY, name: "Family chat", group: true },
    { chat: "447700900124@s.whatsapp.net", name: "Dad", group: false },
  ];
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  const picker = field(form, "whatsappChat") as HTMLSelectElement;
  const values = [...picker.options].map((o) => o.value);
  expect(values).not.toContain(MOM);
  expect(values).toContain(FAMILY);
  const agents = [
    ...(field(form, "whatsappRowAgent") as HTMLSelectElement).options,
  ].map((o) => o.value);
  expect(agents.sort()).toEqual(["a-office", "a-std"]);

  await change(picker, FAMILY);
  expect((field(form, "whatsappRowName") as HTMLInputElement).value).toBe(
    "Family chat",
  );
  await change(field(form, "whatsappRowAgent"), "a-office");
  expect(s.q("[data-whatsapp-shell-warning]")).toBeNull();
  await change(field(form, "whatsappRowAgent"), "a-std");
  expect(s.q("[data-whatsapp-shell-warning]")).not.toBeNull();
  await s.click('[data-whatsapp-add-form] [data-choice="all"]');
  rowAnswer = async (body) => {
    rows = [
      ...rows,
      {
        id: "r2",
        ...(body as object),
        group: true,
        createdAt: 2,
      } as WhatsAppRoute,
    ];
    return rows.at(-1);
  };
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(posts().map((c) => c.body)).toEqual([
    { chat: FAMILY, name: "Family chat", agentId: "a-std", trigger: "all" },
  ]);
  expect(s.q("[data-whatsapp-add-form]")).toBeNull();
  expect(s.q('[data-whatsapp-row="r2"]')).not.toBeNull();
});

it("adds a contact by number: one POST with the number; a refused number and a taken chat show different lines", async () => {
  current = LINKED;
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  await change(field(form, "whatsappChat"), byNumber(form).value);
  await change(field(form, "whatsappRowPhone"), "+44 7700 900124");
  await change(field(form, "whatsappRowName"), "Dad");
  const lineFor = async (status: number, code: string) => {
    rowAnswer = async () => {
      throw new ApiError(status, code, "refused");
    };
    await s.click("[data-whatsapp-add-form] [data-panel-save]");
    const alert = s.q('[role="alert"]');
    expect(alert, String(status)).not.toBeNull();
    return alert!.textContent;
  };
  const badNumber = await lineFor(400, "invalid_request");
  const taken = await lineFor(409, "conflict");
  expect(badNumber).not.toBe(taken);
  expect(posts().map((c) => c.body)).toEqual([
    { phone: "+44 7700 900124", name: "Dad", agentId: "a-office" },
    { phone: "+44 7700 900124", name: "Dad", agentId: "a-office" },
  ]);
  // A refused add keeps the form open.
  expect(s.q("[data-whatsapp-add-form]")).not.toBeNull();
});

it("shows no rows card unless linked", async () => {
  const s = await show({ agents: AGENTS });
  expect(s.card()).toBe("unlinked");
  expect(s.q("[data-whatsapp-rows]")).toBeNull();
  expect(calls.some((c) => c.path === "/api/whatsapp/routes")).toBe(false);
});

// While a read is out, the card holds the layout this device last saw, so it
// does not grow when the answer arrives (task eeec205a).

function gate(): [Promise<void>, () => Promise<void>] {
  let open!: () => void;
  const held = new Promise<void>((resolve) => (open = resolve));
  return [
    held,
    async () => {
      open();
      await settle();
    },
  ];
}
const route = (id: string): WhatsAppRoute => ({
  id,
  chat: `4477009001${id.slice(1).padStart(2, "0")}@s.whatsapp.net`,
  group: false,
  name: `Contact ${id}`,
  agentId: "a-office",
  createdAt: 1,
});
const routesOf = (n: number) =>
  Array.from({ length: n }, (_, i) => route(`r${i + 1}`));
// Matches outside any held block, that is, what the member can see and use.
function live(root: Element, selector: string): Element[] {
  return [...root.querySelectorAll(selector)].filter(
    (el) => el.closest("[data-reserved]") === null,
  );
}
function heldBlocks(root: Element): Element[] {
  const blocks = [...root.querySelectorAll("[data-reserved]")];
  for (const block of blocks) {
    expect(block.getAttribute("aria-hidden")).toBe("true");
    expect(block.hasAttribute("inert")).toBe(true);
  }
  return blocks;
}
const inHeld = (root: Element, selector: string) =>
  root.querySelectorAll(`[data-reserved] ${selector}`).length;
const section = (s: Awaited<ReturnType<typeof show>>) =>
  s.q("[data-integrations-card=whatsapp]")!;
const routeReads = () =>
  calls.filter((c) => c.method === "GET" && c.path === "/api/whatsapp/routes");

it("on a first visit, the card holds the link buttons until the status answers, and the live ones take their place", async () => {
  const [held, release] = gate();
  statusGate = held;
  const s = await show();
  expect(s.card()).toBe("loading");
  expect(section(s).getAttribute("aria-busy")).toBe("true");
  expect(heldBlocks(section(s)).length).toBeGreaterThan(0);
  expect(inHeld(section(s), "button")).toBeGreaterThan(0);
  // Nothing held can be used.
  expect(live(section(s), "button")).toHaveLength(0);
  // The unlinked layout has no rows.
  expect(s.q("[data-whatsapp-rows]")).toBeNull();

  await release();
  expect(s.card()).toBe("unlinked");
  expect(section(s).getAttribute("aria-busy")).toBe("false");
  expect(heldBlocks(section(s))).toHaveLength(0);
  expect(live(section(s), "[data-whatsapp-link]")).toHaveLength(1);
  expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 0 });
});

it("a linked load is remembered with its row count, and the next load holds the linked line and that many rows without reading them", async () => {
  current = LINKED;
  rows = routesOf(3);
  const first = await show({ agents: AGENTS });
  expect(live(section(first), "[data-whatsapp-row]")).toHaveLength(3);
  expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 3 });
  first.view.unmount();

  calls = [];
  const [held, release] = gate();
  statusGate = held;
  const s = await show({ agents: AGENTS });
  expect(s.card()).toBe("loading");
  expect(heldBlocks(section(s)).length).toBeGreaterThan(0);
  expect(inHeld(section(s), "[data-whatsapp-row]")).toBe(3);
  expect(inHeld(section(s), "[data-whatsapp-unlink]")).toBe(1);
  expect(inHeld(section(s), "[data-integrations-add]")).toBe(1);
  // Held, not unlinked: no link button anywhere.
  expect(s.q("[data-whatsapp-link]")).toBeNull();
  expect(live(section(s), "button")).toHaveLength(0);
  // A held copy reads nothing.
  expect(routeReads()).toHaveLength(0);

  // The status answers; the live rows then read, and hold the count meanwhile.
  const [rowsHeld, releaseRows] = gate();
  routesGate = rowsHeld;
  await release();
  expect(s.card()).toBe("linked");
  expect(live(section(s), "[data-whatsapp-connected]")).toHaveLength(1);
  expect(routeReads()).toHaveLength(1);
  expect(inHeld(section(s), "[data-whatsapp-row]")).toBe(3);
  expect(live(section(s), "[data-whatsapp-row]")).toHaveLength(0);

  await releaseRows();
  expect(heldBlocks(section(s))).toHaveLength(0);
  expect(live(section(s), "[data-whatsapp-row]")).toHaveLength(3);
});

it("with the status known, the rows hold the last row count until they answer, and the answer's count is remembered", async () => {
  current = LINKED;
  rows = routesOf(2);
  const first = await show({ agents: AGENTS });
  expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 2 });
  first.view.unmount();

  const [held, release] = gate();
  routesGate = held;
  rows = routesOf(1);
  // A second open in the same page load: the store has the status.
  const s = await show({ agents: AGENTS, whatsappStatus: LINKED });
  expect(s.card()).toBe("linked");
  expect(live(section(s), "[data-whatsapp-connected]")).toHaveLength(1);
  const block = s.q("[data-whatsapp-rows]")!;
  expect(heldBlocks(block).length).toBeGreaterThan(0);
  expect(inHeld(block, "[data-whatsapp-row]")).toBe(2);
  expect(inHeld(block, "[data-integrations-add]")).toBe(1);
  expect(live(block, "button")).toHaveLength(0);

  await release();
  expect(heldBlocks(section(s))).toHaveLength(0);
  expect(live(block, "[data-whatsapp-row]")).toHaveLength(1);
  expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 1 });
});

// A held block paints the real layout grayed out, not an empty box, and
// shows no value it does not know yet: a bar stands in for it (task
// a10fd923, Nil at the sign-off of eeec205a).
function paints(block: Element) {
  const style = (block as HTMLElement).style;
  expect(style.visibility).not.toBe("hidden");
  expect(Number(style.opacity)).toBeGreaterThan(0);
  expect(Number(style.opacity)).toBeLessThan(1);
}
// A row's own text, without its buttons.
function rowText(row: Element): string {
  const copy = row.cloneNode(true) as Element;
  for (const button of copy.querySelectorAll("button")) button.remove();
  return copy.textContent!.trim();
}
const bars = (root: Element) => root.querySelectorAll("[data-placeholder]");

it("a held linked card paints its line and rows with bars for the number, the connection and each chat", async () => {
  current = LINKED;
  rows = routesOf(2);
  const first = await show({ agents: AGENTS });
  const connected = live(section(first), "[data-whatsapp-connected]")[0]
    .textContent!;
  expect(connected).not.toBe("");
  first.view.unmount();

  statusGate = gate()[0];
  const s = await show({ agents: AGENTS });
  expect(s.card()).toBe("loading");
  const blocks = heldBlocks(section(s));
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  paints(block);
  const heldRows = [...block.querySelectorAll("[data-whatsapp-row]")];
  expect(heldRows).toHaveLength(2);
  // No number, chat name or connection state it does not know.
  expect(block.textContent).not.toMatch(/[0-9]/);
  expect(block.textContent).not.toContain(connected);
  expect(block.querySelector("[data-whatsapp-connected]")).toBeNull();
  for (const row of heldRows) {
    expect(rowText(row)).toBe("");
    expect(bars(row).length).toBeGreaterThan(0);
  }
  // The linked line: a bar for the number and one for the connection.
  const outsideRows = [...bars(block)].filter(
    (bar) => bar.closest("[data-whatsapp-row]") === null,
  );
  expect(outsideRows).toHaveLength(2);
  // The real controls are there, grayed out and out of reach.
  expect(inHeld(section(s), "[data-whatsapp-unlink]")).toBe(1);
  expect(inHeld(section(s), "[data-whatsapp-row-delete]")).toBe(2);
  expect(inHeld(section(s), "[data-integrations-add]")).toBe(1);
  expect(live(section(s), "button")).toHaveLength(0);
});

it("held rows of a known link paint with a bar for each chat", async () => {
  current = LINKED;
  setWhatsAppLayout({ linked: true, rows: 2 });
  routesGate = gate()[0];
  const s = await show({ agents: AGENTS, whatsappStatus: LINKED });
  const block = s.q("[data-whatsapp-rows]")!;
  const blocks = heldBlocks(block);
  expect(blocks).toHaveLength(1);
  paints(blocks[0]);
  const heldRows = [...blocks[0].querySelectorAll("[data-whatsapp-row]")];
  expect(heldRows).toHaveLength(2);
  expect(blocks[0].textContent).not.toMatch(/[0-9]/);
  for (const row of heldRows) {
    expect(rowText(row)).toBe("");
    expect(bars(row).length).toBeGreaterThan(0);
  }
  expect(inHeld(block, "[data-whatsapp-row-delete]")).toBe(2);
  expect(live(block, "button")).toHaveLength(0);
});

it("a held layout keeps at most the row cap", async () => {
  current = LINKED;
  rows = routesOf(WHATSAPP_HELD_ROWS_MAX + 5);
  const first = await show({ agents: AGENTS });
  expect(live(section(first), "[data-whatsapp-row]")).toHaveLength(
    WHATSAPP_HELD_ROWS_MAX + 5,
  );
  expect(getWhatsAppLayout()).toEqual({
    linked: true,
    rows: WHATSAPP_HELD_ROWS_MAX,
  });
  first.view.unmount();

  statusGate = gate()[0];
  const s = await show({ agents: AGENTS });
  expect(inHeld(section(s), "[data-whatsapp-row]")).toBe(
    WHATSAPP_HELD_ROWS_MAX,
  );
});

it("an unlink, a push and a link in progress rewrite the linked flag and keep the row count", async () => {
  current = LINKED;
  rows = routesOf(2);
  const s = await show({ agents: AGENTS });
  expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 2 });

  await s.click("[data-whatsapp-unlink]");
  expect(s.card()).toBe("unlinked");
  expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 2 });

  await s.push({ state: "linking", method: "qr" });
  expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 2 });

  await s.push(LINKED);
  await settle();
  expect(getWhatsAppLayout()).toEqual({ linked: true, rows: 2 });

  await s.push({ state: "dead", reason: "crash_loop", phone: "447700900111" });
  expect(getWhatsAppLayout()).toEqual({ linked: false, rows: 2 });
});

it("a failed read holds nothing: the error line shows without held space", async () => {
  statusFails = true;
  const s = await show();
  expect(s.q("[role=alert]")).not.toBeNull();
  expect(heldBlocks(section(s))).toHaveLength(0);
  s.view.unmount();

  statusFails = false;
  current = LINKED;
  routesFail = true;
  const r = await show({ agents: AGENTS, whatsappStatus: LINKED });
  const block = r.q("[data-whatsapp-rows]")!;
  expect(block.querySelector("[role=alert]")).not.toBeNull();
  expect(heldBlocks(block)).toHaveLength(0);
});

it("at environment read, the held card holds what the live one shows: no buttons", async () => {
  const member = asMember("read");
  const record = { ...selfUserRecord(null), ...member.record };
  const over = {
    ...member.state,
    users: new Map([[record.name.toLowerCase(), record]]),
    agents: AGENTS,
  };
  // Unlinked: the live card has no button, so nothing holds one.
  statusGate = gate()[0];
  const unlinked = await show(over);
  expect(unlinked.card()).toBe("loading");
  expect(inHeld(section(unlinked), "button")).toBe(0);
  unlinked.view.unmount();

  // Linked: the line and the rows, without Unlink, Delete or Add.
  setWhatsAppLayout({ linked: true, rows: 2 });
  const linked = await show(over);
  expect(inHeld(section(linked), "[data-whatsapp-row]")).toBe(2);
  expect(inHeld(section(linked), "button")).toBe(0);
});

// The Send step is optional per row, and a row can carry a prefix
// (task 70fae82c).
const checkbox = (root: Element, name: string) => {
  const el = root.querySelector(`input[name="${name}"]`);
  if (!(el instanceof HTMLInputElement) || el.type !== "checkbox")
    throw new Error(`no checkbox ${name}`);
  return el;
};
async function toggle(el: HTMLInputElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
}
const patches = () => calls.filter((c) => c.method === "PATCH");

it("Add: replies wait for Send by default, with no hint and no new field sent; unticked, a hint shows and the row sends at once with its prefix", async () => {
  current = LINKED;
  const s = await show({ agents: AGENTS });
  let form = await openAdd(s);
  const wait = checkbox(form, "whatsappRowWaitForSend");
  expect(wait.checked).toBe(true);
  expect(s.q("[data-whatsapp-direct-hint]")).toBeNull();
  expect((field(form, "whatsappRowPrefix") as HTMLInputElement).value).toBe("");
  await change(field(form, "whatsappChat"), byNumber(form).value);
  await change(field(form, "whatsappRowPhone"), "+44 7700 900124");
  await change(field(form, "whatsappRowName"), "Dad");
  rowAnswer = async (body) => {
    rows = [
      ...rows,
      {
        id: `r${rows.length + 1}`,
        chat: "447700900124@s.whatsapp.net",
        group: false,
        createdAt: 2,
        ...(body as object),
      } as WhatsAppRoute,
    ];
    return rows.at(-1);
  };
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  // The default is today's row: the body carries neither field.
  expect(posts().map((c) => c.body)).toEqual([
    { phone: "+44 7700 900124", name: "Dad", agentId: "a-office" },
  ]);
  expect(s.q('[data-whatsapp-row="r1"] [data-whatsapp-row-direct]')).toBeNull();

  form = await openAdd(s);
  await change(field(form, "whatsappChat"), byNumber(form).value);
  await change(field(form, "whatsappRowPhone"), "+44 7700 900125");
  await change(field(form, "whatsappRowName"), "Sis");
  await toggle(checkbox(form, "whatsappRowWaitForSend"));
  expect(checkbox(form, "whatsappRowWaitForSend").checked).toBe(false);
  expect(s.q("[data-whatsapp-direct-hint]")).not.toBeNull();
  await change(field(form, "whatsappRowPrefix"), "[Agent]:");
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(posts().at(-1)?.body).toEqual({
    phone: "+44 7700 900125",
    name: "Sis",
    agentId: "a-office",
    sendDirect: true,
    prefix: "[Agent]:",
  });
  // The row says it sends at once; the other does not.
  expect(
    s.q('[data-whatsapp-row="r2"] [data-whatsapp-row-direct]'),
  ).not.toBeNull();
  expect(s.q('[data-whatsapp-row="r1"] [data-whatsapp-row-direct]')).toBeNull();
});

it("Edit opens the form on the row as it is, with no chat picker; Save sends one PATCH with the fields, and false and an empty prefix clear them", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: MOM,
      group: false,
      name: "Mom",
      agentId: "a-std",
      createdAt: 1,
      sendDirect: true,
      prefix: "Bot:",
    },
  ];
  const s = await show({ agents: AGENTS });
  expect(
    s.q('[data-whatsapp-row="r1"] [data-whatsapp-row-direct]'),
  ).not.toBeNull();
  await s.click('[data-whatsapp-row-edit="r1"]');
  const form = s.q("[data-whatsapp-add-form]");
  if (!(form instanceof HTMLElement)) throw new Error("no edit form");
  // The chat cannot change: no picker, and the form names the row.
  expect(form.querySelector('[name="whatsappChat"]')).toBeNull();
  expect((field(form, "whatsappRowName") as HTMLInputElement).value).toBe(
    "Mom",
  );
  expect((field(form, "whatsappRowAgent") as HTMLSelectElement).value).toBe(
    "a-std",
  );
  expect(checkbox(form, "whatsappRowWaitForSend").checked).toBe(false);
  expect(s.q("[data-whatsapp-direct-hint]")).not.toBeNull();
  expect((field(form, "whatsappRowPrefix") as HTMLInputElement).value).toBe(
    "Bot:",
  );

  await toggle(checkbox(form, "whatsappRowWaitForSend"));
  expect(s.q("[data-whatsapp-direct-hint]")).toBeNull();
  await change(field(form, "whatsappRowPrefix"), "");
  await change(field(form, "whatsappRowName"), "Mum");
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(posts()).toEqual([]);
  expect(patches().map((c) => c.path)).toEqual(["/api/whatsapp/routes/r1"]);
  const body = patches()[0].body as Record<string, unknown>;
  expect(body).toMatchObject({
    name: "Mum",
    agentId: "a-std",
    sendDirect: false,
    prefix: "",
  });
  expect("chat" in body).toBe(false);
  expect(s.q("[data-whatsapp-add-form]")).toBeNull();
  expect(s.q('[data-whatsapp-row="r1"]')?.textContent).toContain("Mum");
  expect(s.q('[data-whatsapp-row="r1"] [data-whatsapp-row-direct]')).toBeNull();
});

it("a refused edit keeps the form open with its line", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: MOM,
      group: false,
      name: "Mom",
      agentId: "a-office",
      createdAt: 1,
    },
  ];
  patchAnswer = async () => {
    throw new ApiError(400, "invalid_request", "refused");
  };
  const s = await show({ agents: AGENTS });
  await s.click('[data-whatsapp-row-edit="r1"]');
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(patches()).toHaveLength(1);
  expect(s.q("[data-whatsapp-add-form]")).not.toBeNull();
  expect(s.q('[role="alert"]')).not.toBeNull();
});

// The member's own chat first in the picker, and whether the member's own
// messages reach the agent (task 610f7756).
const myself = (form: Element) => {
  const el = form.querySelector("option[data-whatsapp-myself]");
  return el instanceof HTMLOptionElement ? el : null;
};
const OWN = "447700900111@s.whatsapp.net";

it("the picker lists the member's own number first, at the top level, above the by-number choice and the seen chats", async () => {
  current = LINKED;
  seenChats = [
    { chat: "447700900124@s.whatsapp.net", name: "Dad", group: false },
    { chat: FAMILY, name: "Family chat", group: true },
  ];
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  const picker = field(form, "whatsappChat") as HTMLSelectElement;
  const own = myself(form);
  expect(own?.value).toBe(OWN);
  expect(own?.textContent).toContain("447700900111");
  // The first choice after the disabled prompt.
  const values = [...picker.options].map((o) => o.value);
  expect(picker.options[0].disabled).toBe(true);
  expect(values.indexOf(OWN)).toBe(1);
  expect(groupOf(picker, OWN)).toBe(-1);
  expect(values.indexOf(OWN)).toBeLessThan(
    values.indexOf(byNumber(form).value),
  );
  // Listed once.
  expect(values.filter((v) => v === OWN)).toHaveLength(1);
});

it("the own number is left out once a row has that chat", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: OWN,
      group: false,
      name: "+447700900111",
      agentId: "a-office",
      createdAt: 1,
    },
  ];
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  expect(myself(form)).toBeNull();
  const values = [
    ...(field(form, "whatsappChat") as HTMLSelectElement).options,
  ].map((o) => o.value);
  expect(values).not.toContain(OWN);
});

it("picking the own number fills the name with the number and turns own messages on; the add sends it", async () => {
  current = LINKED;
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(false);
  await change(field(form, "whatsappChat"), OWN);
  expect((field(form, "whatsappRowName") as HTMLInputElement).value).toBe(
    "+447700900111",
  );
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(true);
  rowAnswer = async (body) => {
    rows = [
      ...rows,
      {
        id: "r1",
        group: false,
        createdAt: 2,
        ...(body as object),
      } as WhatsAppRoute,
    ];
    return rows.at(-1);
  };
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(posts().map((c) => c.body)).toEqual([
    {
      chat: OWN,
      name: "+447700900111",
      agentId: "a-office",
      ownMessages: true,
    },
  ]);
});

it("a pick of another chat after the own number undoes what the own pick filled in", async () => {
  current = LINKED;
  seenChats = [
    { chat: "447700900124@s.whatsapp.net", name: "Dad", group: false },
  ];
  const s = await show({ agents: AGENTS });
  const form = await openAdd(s);
  await change(field(form, "whatsappChat"), OWN);
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(true);
  await change(field(form, "whatsappChat"), "447700900124@s.whatsapp.net");
  expect((field(form, "whatsappRowName") as HTMLInputElement).value).toBe(
    "Dad",
  );
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(false);
});

it("own messages: off by default and not sent; ticked on another chat it is sent; Edit shows it and sends it on and off", async () => {
  current = LINKED;
  rows = [
    {
      id: "r1",
      chat: MOM,
      group: false,
      name: "Mom",
      agentId: "a-office",
      createdAt: 1,
      ownMessages: true,
    },
  ];
  rowAnswer = async (body) => {
    rows = [
      ...rows,
      {
        id: `r${rows.length + 1}`,
        chat: "447700900124@s.whatsapp.net",
        group: false,
        createdAt: 2,
        ...(body as object),
      } as WhatsAppRoute,
    ];
    return rows.at(-1);
  };
  const s = await show({ agents: AGENTS });
  let form = await openAdd(s);
  await change(field(form, "whatsappChat"), byNumber(form).value);
  await change(field(form, "whatsappRowPhone"), "+44 7700 900124");
  await change(field(form, "whatsappRowName"), "Dad");
  await toggle(checkbox(form, "whatsappRowOwnMessages"));
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(posts().map((c) => c.body)).toEqual([
    {
      phone: "+44 7700 900124",
      name: "Dad",
      agentId: "a-office",
      ownMessages: true,
    },
  ]);

  await s.click('[data-whatsapp-row-edit="r1"]');
  form = s.q("[data-whatsapp-add-form]") as HTMLElement;
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(true);
  await toggle(checkbox(form, "whatsappRowOwnMessages"));
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(patches().at(-1)?.body).toMatchObject({ ownMessages: false });

  await s.click('[data-whatsapp-row-edit="r1"]');
  form = s.q("[data-whatsapp-add-form]") as HTMLElement;
  expect(checkbox(form, "whatsappRowOwnMessages").checked).toBe(false);
  await toggle(checkbox(form, "whatsappRowOwnMessages"));
  await s.click("[data-whatsapp-add-form] [data-panel-save]");
  expect(patches().at(-1)?.body).toMatchObject({ ownMessages: true });
  expect(patches()).toHaveLength(2);
});
