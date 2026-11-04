// The ask stack above the chat input remembers that the member folded it
// (task 107e0eee): per member and agent, in this browser, until a new ask
// comes for that agent. Each fresh mount is a new store, as after a reload or
// a visit to another chat, so only localStorage carries the fold. The stack
// mounts once the store holds the seed, as LogView mounts after full_state.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent, waitFor } =
  await import("@testing-library/react");
const { useEffect, useState } = await import("react");
const { StoreProvider, useDispatch, FeaturesProvider } =
  await import("../store.tsx");
const { PRODUCTION_FEATURES, DEMO_FEATURES } =
  await import("../../shared/features.ts");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { AsksStack } = await import("./AsksStack.tsx");
const { loadFoldedAsks, saveFoldedAsks } =
  await import("../view-persistence.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type SessionContext = import("../../shared/types.ts").SessionContext;

const NOW = Date.now();
const entry = (id: string, agentId: string, ageMin: number): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});
const ENTRIES: AskEntry[] = [
  entry("aaaa0001", "a1", 120),
  entry("bbbb0002", "a1", 5),
  entry("cccc0003", "a2", 1),
];
const NEW_ASK = entry("vvvv0022", "a1", 0);

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});
beforeEach(() => {
  localStorage.clear();
  setApiShim(async () => undefined);
});
afterAll(() => setApiShim(null));

const context = (username: string) =>
  ({ userId: `u-${username}`, username, role: "member" }) as SessionContext;

// The store's dispatch, for a change after the stack is drawn.
let seeded: ReturnType<typeof useDispatch> = () => {};
function Seed({
  user,
  entries,
  children,
}: {
  user: string | null;
  entries: AskEntry[] | null;
  children: React.ReactNode;
}) {
  const dispatch = useDispatch();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seeded = dispatch;
    if (user) dispatch({ type: "session_context", context: context(user) });
    if (entries) dispatch({ type: "asks_loaded", entries, revision: 0 });
    setReady(true);
    // Seeds once per store, as the socket and useAsksSync do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);
  return ready ? <>{children}</> : null;
}

interface Opts {
  user?: string | null;
  agentId?: string;
  isMobile?: boolean;
  entries?: AskEntry[] | null;
  demo?: boolean;
}
function tree({
  user = "Nil",
  agentId = "a1",
  isMobile = false,
  entries = ENTRIES,
  demo = false,
}: Opts) {
  return (
    <FeaturesProvider features={demo ? DEMO_FEATURES : PRODUCTION_FEATURES}>
      <StoreProvider>
        <Seed user={user} entries={entries}>
          {/* LogView mounts the stack with key={agent.id}. */}
          <AsksStack key={agentId} agentId={agentId} isMobile={isMobile} />
        </Seed>
      </StoreProvider>
    </FeaturesProvider>
  );
}

async function mount(opts: Opts = {}) {
  const view = render(tree(opts));
  if (opts.entries !== null)
    await waitFor(() => expect(stack(view.container)).not.toBe(null));
  return view;
}

const stack = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-asks-stack]")?.dataset.asksStack ??
  null;
const cards = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-ask]")].map(
    (c) => c.dataset.ask,
  );
// The bar of a folded stack, or the header of an open one.
const toggle = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>("[data-asks-stack] > button")!;
const foldedIds = (user = "Nil", agentId = "a1") =>
  loadFoldedAsks(user, agentId)?.toSorted() ?? null;

async function foldNow(root: HTMLElement) {
  expect(stack(root)).toBe("open");
  fireEvent.click(toggle(root));
  expect(stack(root)).toBe("collapsed");
}

it("keeps the fold when the member visits another chat and comes back, and after a reload", async () => {
  const view = await mount();
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  await foldNow(view.container);
  expect(foldedIds()).toEqual(["aaaa0001", "bbbb0002"]);
  // Another agent's chat: its own stack, not folded.
  view.rerender(tree({ agentId: "a2" }));
  expect(stack(view.container)).toBe("open");
  expect(cards(view.container)).toEqual(["cccc0003"]);
  view.rerender(tree({ agentId: "a1" }));
  expect(stack(view.container)).toBe("collapsed");
  view.unmount();

  const again = await mount();
  expect(stack(again.container)).toBe("collapsed");
  expect(cards(again.container)).toEqual([]);
  again.unmount();
  // The same member under another case is the same member.
  const lower = await mount({ user: "nil" });
  expect(stack(lower.container)).toBe("collapsed");
  lower.unmount();
  // Another member in this browser has their own stack.
  const pam = await mount({ user: "Pam" });
  expect(stack(pam.container)).toBe("open");
  pam.unmount();
  expect(foldedIds()).toEqual(["aaaa0001", "bbbb0002"]);
});

it("opens again and drops the fold when a new ask came while the member was away", async () => {
  const view = await mount();
  await foldNow(view.container);
  view.unmount();

  const back = await mount({ entries: [...ENTRIES, NEW_ASK] });
  expect(stack(back.container)).toBe("open");
  expect(cards(back.container)).toEqual(["vvvv0022", "bbbb0002", "aaaa0001"]);
  await waitFor(() => expect(foldedIds()).toBe(null));
  back.unmount();
});

it("opens when a new ask arrives in the folded chat, and an answer to it does not fold the stack again", async () => {
  const view = await mount();
  await foldNow(view.container);
  act(() => seeded({ type: "ask_upserted", entry: NEW_ASK }));
  expect(stack(view.container)).toBe("open");
  await waitFor(() => expect(foldedIds()).toBe(null));
  // The new ask is answered: the asks folded before it show again, open.
  act(() => seeded({ type: "ask_removed", id: NEW_ASK.id }));
  expect(stack(view.container)).toBe("open");
  expect(cards(view.container)).toEqual(["bbbb0002", "aaaa0001"]);
  view.unmount();
  const back = await mount();
  expect(stack(back.container)).toBe("open");
  back.unmount();
});

it("stays folded when an ask is answered, and keeps the fold while no ask is open", async () => {
  const view = await mount();
  await foldNow(view.container);
  act(() => seeded({ type: "ask_removed", id: "aaaa0001" }));
  expect(stack(view.container)).toBe("collapsed");
  expect(toggle(view.container).textContent).toContain("1");
  view.unmount();

  const back = await mount({ entries: [ENTRIES[1], ENTRIES[2]] });
  expect(stack(back.container)).toBe("collapsed");
  // The last ask is answered: nothing draws, and the fold is kept.
  act(() => seeded({ type: "ask_removed", id: "bbbb0002" }));
  expect(stack(back.container)).toBe(null);
  await act(async () => {});
  expect(foldedIds()).toEqual(["aaaa0001", "bbbb0002"]);
  back.unmount();
});

it("keeps the fold while the asks are not loaded yet, and draws it folded once they are", async () => {
  saveFoldedAsks("Nil", "a1", ["aaaa0001", "bbbb0002"]);
  const view = await mount({ entries: null });
  await act(async () => {});
  expect(stack(view.container)).toBe(null);
  expect(foldedIds()).toEqual(["aaaa0001", "bbbb0002"]);
  act(() => seeded({ type: "asks_loaded", entries: ENTRIES, revision: 0 }));
  expect(stack(view.container)).toBe("collapsed");
  view.unmount();
});

it("drops the fold when the member opens the stack", async () => {
  const view = await mount();
  await foldNow(view.container);
  fireEvent.click(toggle(view.container));
  expect(stack(view.container)).toBe("open");
  expect(foldedIds()).toBe(null);
  view.unmount();
  const back = await mount();
  expect(stack(back.container)).toBe("open");
  back.unmount();
});

it("reads the fold when the member's name arrives after the stack drew", async () => {
  saveFoldedAsks("Nil", "a1", ["aaaa0001", "bbbb0002"]);
  const view = await mount({ user: null });
  expect(stack(view.container)).toBe("open");
  act(() => seeded({ type: "session_context", context: context("Nil") }));
  expect(stack(view.container)).toBe("collapsed");
  view.unmount();
});

it("keeps a fold with no member name in this mount only, and writes nothing", async () => {
  const keysBefore = Object.keys(localStorage).toSorted();
  const view = await mount({ user: null });
  await foldNow(view.container);
  await act(async () => {});
  expect(Object.keys(localStorage).toSorted()).toEqual(keysBefore);
  view.unmount();
  const back = await mount({ user: null });
  expect(stack(back.container)).toBe("open");
  back.unmount();
});

// The demo keeps nothing between visits, as App's view and draft restore do
// (persistEnabled), so each visitor gets the scripted landing.
it("keeps a fold in the demo in this mount only, and neither reads nor writes one", async () => {
  const keysBefore = Object.keys(localStorage).toSorted();
  const view = await mount({ demo: true });
  await foldNow(view.container);
  await act(async () => {});
  expect(Object.keys(localStorage).toSorted()).toEqual(keysBefore);
  view.unmount();
  saveFoldedAsks("Nil", "a1", ["aaaa0001", "bbbb0002"]);
  const back = await mount({ demo: true });
  expect(stack(back.container)).toBe("open");
  back.unmount();
});

it("starts collapsed on a phone with or without a fold, and a new ask drops the fold there too", async () => {
  const bare = await mount({ isMobile: true });
  expect(stack(bare.container)).toBe("collapsed");
  // Opened on the phone: the next visit starts collapsed again.
  fireEvent.click(toggle(bare.container));
  expect(stack(bare.container)).toBe("open");
  expect(foldedIds()).toBe(null);
  bare.unmount();
  const next = await mount({ isMobile: true });
  expect(stack(next.container)).toBe("collapsed");
  next.unmount();

  saveFoldedAsks("Nil", "a1", ["aaaa0001", "bbbb0002"]);
  const folded = await mount({ isMobile: true });
  expect(stack(folded.container)).toBe("collapsed");
  act(() => seeded({ type: "ask_upserted", entry: NEW_ASK }));
  expect(stack(folded.container)).toBe("collapsed");
  await waitFor(() => expect(foldedIds()).toBe(null));
  folded.unmount();
});
