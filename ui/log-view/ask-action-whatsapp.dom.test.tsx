// The card of a WhatsApp route ask (task 0b53ff37): the agent names a chat by
// a name to match, and the card lists the member's chats that match it - the
// chats their WhatsApp saw and the chats that have a row - as one choice
// each. One match is picked already; several wait for the member's pick;
// none leaves no Apply. Only the member the ask is for gets the choice and
// Apply: another viewer's chats are not the member's. A pick that has a row to another agent names that
// agent before Apply moves it. Apply sends the picked chat id.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { useEffect } = await import("react");
const { StoreProvider, useDispatch } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;

const NOW = Date.now();
const agent = (id: string, name: string, userId: string) =>
  ({
    id,
    name,
    roomId: "r1",
    desk: 0,
    access: "standard",
    userId,
  }) as never;
const ASKER = agent("a1", "Asker", "u1");
const PM = agent("a2", "Project Lead", "u2");
const HELPER = agent("a3", "Inbox Helper", "u1");

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const GROUP = "120363000000000001@g.us";
const OTHER_GROUP = "120363000000000002@g.us";
const BOOK = "120363000000000003@g.us";
const CONTACT = "447700900123@s.whatsapp.net";

let posts: string[] = [];
let gets: string[] = [];
let postBodies: unknown[] = [];
let chats: unknown[] = [];
let routes: unknown[] = [];
beforeEach(() => {
  posts = [];
  gets = [];
  postBodies = [];
  chats = [];
  routes = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push(path);
      postBodies.push(body);
      return undefined;
    }
    gets.push(path);
    if (path === "/api/whatsapp/chats") return chats;
    if (path === "/api/whatsapp/routes") return routes;
    return undefined;
  });
});
afterAll(() => setApiShim(null));

function Seed({
  entries,
  children,
}: {
  entries: AskEntry[];
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch({
      type: "session_context",
      context: {
        userId: "u1",
        username: "Morgan",
        role: "owner",
        currentSessionPrefix: "abcd1234",
      } as never,
    });
    for (const a of [ASKER, PM, HELPER])
      dispatch({ type: "agent_added", agent: a });
    dispatch({ type: "asks_loaded", entries, revision: 0 });
  }, [dispatch, entries]);
  return <>{children}</>;
}

async function mount(step: Record<string, unknown>, memberUserId = "u1") {
  const entry = {
    id: "wa000001",
    agentId: "a1",
    memberUserId,
    prompt: "Please route the Akido group to the Project Lead.",
    createdAt: NOW,
    updatedAt: NOW,
    step,
  } as AskEntry;
  const view = render(
    <StoreProvider>
      <Seed entries={[entry]}>
        <AsksStack agentId="a1" isMobile={false} />
      </Seed>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("[data-ask]").length).toBe(1),
  );
  const block = () =>
    view.container.querySelector<HTMLElement>(
      `[data-ask="wa000001"] [data-ask-action]`,
    );
  const radios = () => [
    ...(block()?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ??
      []),
  ];
  const apply = () =>
    block()?.querySelector<HTMLButtonElement>("[data-ask-action-apply]") ??
    null;
  const picked = () =>
    block()?.getAttribute("data-ask-action-chat-picked") ?? null;
  return { view, block, radios, apply, picked };
}

const step = (extra: Record<string, unknown> = {}) => ({
  kind: "whatsapp-route",
  chatName: "akido",
  agentId: "a2",
  ...extra,
});

it("names the agent; one matching chat is picked already, and Apply sends its id", async () => {
  chats = [
    { chat: GROUP, name: "Akido Legal Team", group: true },
    { chat: BOOK, name: "Book club", group: true },
  ];
  const m = await mount(step());
  await waitFor(() => expect(m.picked()).toBe(GROUP));
  const text = m.block()!.textContent ?? "";
  expect(text.includes("Akido Legal Team")).toBe(true);
  expect(text.includes("Book club")).toBe(false);
  expect(text.includes("Project Lead")).toBe(true);
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect([posts[0], postBodies[0]]).toEqual([
    "/api/asks/wa000001/action",
    { chat: GROUP },
  ]);
});

it("several matches wait for the member's pick, matched without case; a chat with a row is a choice even when the bridge did not see it", async () => {
  chats = [
    { chat: GROUP, name: "Akido Legal Team", group: true },
    { chat: CONTACT, name: "Mom", group: false },
  ];
  routes = [
    {
      id: "r1",
      chat: OTHER_GROUP,
      group: true,
      name: "AKIDO board",
      agentId: "a3",
      trigger: "mention",
      createdAt: 1,
    },
  ];
  const m = await mount(step());
  await waitFor(() => expect(m.radios().length).toBe(2));
  expect(m.radios().map((r) => [r.value, r.checked])).toEqual([
    [GROUP, false],
    [OTHER_GROUP, false],
  ]);
  // No pick, no run.
  const before = m.apply();
  if (before) {
    fireEvent.click(before);
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(posts.length).toBe(0);
  fireEvent.click(m.radios()[0]);
  await waitFor(() => expect(m.radios()[0].checked).toBe(true));
  fireEvent.click(m.apply()!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(postBodies[0]).toEqual({ chat: GROUP });
});

it("a pick with a row to another agent names that agent before Apply", async () => {
  chats = [{ chat: GROUP, name: "Akido Legal Team", group: true }];
  routes = [
    {
      id: "r1",
      chat: GROUP,
      group: true,
      name: "Akido",
      agentId: "a3",
      trigger: "mention",
      createdAt: 1,
    },
  ];
  const m = await mount(step());
  await waitFor(() => expect(m.picked()).toBe(GROUP));
  expect(m.block()!.querySelectorAll("[data-ask-action-wa-moves]").length).toBe(
    1,
  );
  expect((m.block()!.textContent ?? "").includes("Inbox Helper")).toBe(true);
  expect(posts.length).toBe(0);
});

it("a pick with a row to the same agent says nothing of a move", async () => {
  chats = [{ chat: GROUP, name: "Akido Legal Team", group: true }];
  routes = [
    {
      id: "r1",
      chat: GROUP,
      group: true,
      name: "Akido",
      agentId: "a2",
      trigger: "all",
      createdAt: 1,
    },
  ];
  const m = await mount(step());
  await waitFor(() => expect(m.picked()).toBe(GROUP));
  expect(m.block()!.querySelectorAll("[data-ask-action-wa-moves]").length).toBe(
    0,
  );
});

it("a viewer who is not the ask's member reads no chats and gets no choice and no Apply", async () => {
  chats = [{ chat: GROUP, name: "Akido Legal Team", group: true }];
  const m = await mount(step(), "u3");
  await waitFor(() =>
    expect(m.block()?.textContent?.includes("Project Lead") ?? false).toBe(
      true,
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(gets.filter((p) => p.startsWith("/api/whatsapp/")).length).toBe(0);
  expect(m.radios().length).toBe(0);
  expect(m.picked()).toBe(null);
  expect(m.apply()).toBe(null);
});

it("no matching chat: no choice and no Apply that runs", async () => {
  chats = [{ chat: BOOK, name: "Book club", group: true }];
  const m = await mount(step());
  await waitFor(() =>
    expect(m.block()?.textContent?.includes("Project Lead") ?? false).toBe(
      true,
    ),
  );
  // The lists arrived and none matched.
  await waitFor(() =>
    expect(
      ["/api/whatsapp/chats", "/api/whatsapp/routes"].every((p) =>
        gets.includes(p),
      ),
    ).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(m.radios().length).toBe(0);
  const button = m.apply();
  if (button) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(posts.length).toBe(0);
});
