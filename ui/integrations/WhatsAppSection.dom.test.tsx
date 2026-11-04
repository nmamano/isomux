// The WhatsApp card of the Integrations Messaging tab (task d03a61d8): the member links their own
// WhatsApp by QR or by a pairing code, sees the live status the server
// pushes, and unlinks. Rendered over a live reducer, so a whatsapp_status
// message reaches the section as it does from the socket.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render, act } = await import("@testing-library/react");
const { WhatsAppSection } = await import("./WhatsAppSection.tsx");
const { stateWithSelfUser } =
  await import("../test-support/language-fixture.tsx");
const { StateCtx, DispatchCtx, reducer } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { ApiError, setApiShim } = await import("../api.ts");

type WhatsAppStatus = import("../../shared/whatsapp.ts").WhatsAppStatus;
type Action = Parameters<typeof reducer>[1];
type WhatsAppRoute = import("../../shared/whatsapp.ts").WhatsAppRoute;
type WhatsAppChatSeen = import("../../shared/whatsapp.ts").WhatsAppChatSeen;
type AppState = import("../store.tsx").AppState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;

let current: WhatsAppStatus = { state: "unlinked" };
let calls: { method: string; path: string; body: unknown }[] = [];
let linkAnswer: () => Promise<unknown> = async () => current;
// The contact rows (slice 2).
let rows: WhatsAppRoute[] = [];
let seenChats: WhatsAppChatSeen[] = [];
let rowAnswer: (body: unknown) => Promise<unknown> = async () => ({});

beforeEach(() => {
  current = { state: "unlinked" };
  calls = [];
  linkAnswer = async () => current;
  rows = [];
  seenChats = [];
  rowAnswer = async () => ({});
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/whatsapp/routes") return rows;
    if (method === "GET" && path === "/api/whatsapp/chats") return seenChats;
    if (method === "POST" && path === "/api/whatsapp/routes")
      return rowAnswer(body);
    if (method === "DELETE" && path.startsWith("/api/whatsapp/routes/")) {
      rows = rows.filter((r) => !path.endsWith(`/${r.id}`));
      return undefined;
    }
    if (method === "GET" && path === "/api/whatsapp") return current;
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
