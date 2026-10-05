import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { RoomTabBar } = await import("./RoomTabBar.tsx");
const { StoreProvider, FeaturesProvider } = await import("../store.tsx");
const { LanguageProvider } = await import("../i18n.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, shimEmit, connect } = await import("../ws.ts");
const { PRODUCTION_FEATURES } = await import("../../shared/features.ts");

type RoomWire = import("../../shared/types.ts").RoomWire;
const room = (id: string): RoomWire => ({
  id,
  name: `Room ${id}`,
  prompt: null,
  canCloseWhenEmpty: false,
});
const noop = () => {};

function fullState(ids: string[]) {
  shimEmit({
    type: "full_state",
    agents: [],
    rooms: ids.map(room),
    office: { name: "Tab test", prompt: null },
    recentCwds: [],
    killedAgents: [],
    interactions: [],
  });
}

// Each PUT /api/me/view/order waits here until the test answers it.
let writes: {
  order: string[];
  resolve: () => void;
  reject: (e: Error) => void;
}[] = [];

beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  setApiShim(async (method, path, body) => {
    if (method === "PUT" && path === "/api/me/view/order") {
      return new Promise<void>((resolve, reject) =>
        writes.push({
          order: (body as { order: string[] }).order,
          resolve,
          reject,
        }),
      );
    }
    if (path.startsWith("/api/members-chat"))
      return { messages: [], hasMore: false, readPointer: null, unread: 0 };
    return {};
  });
});
afterAll(() => {
  setApiShim(null);
  setShim(noop);
  connect(noop, noop);
});

function mount(ids: string[]) {
  setShim(noop);
  const view = render(
    <StoreProvider>
      <LanguageProvider>
        <FeaturesProvider features={PRODUCTION_FEATURES}>
          <RoomTabBar />
        </FeaturesProvider>
      </LanguageProvider>
    </StoreProvider>,
  );
  act(() => fullState(ids));
  return view;
}

// The tab order the member sees, by room id.
function shownOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[draggable]")].map(
    (el) => el.textContent?.match(/Room ([a-z])/)?.[1] ?? "?",
  );
}

function tab(container: HTMLElement, id: string): HTMLElement {
  const el = [...container.querySelectorAll("[draggable]")].find((t) =>
    t.textContent?.includes(`Room ${id}`),
  );
  if (!el) throw new Error(`no tab ${id}`);
  return el as HTMLElement;
}

function drag(container: HTMLElement, from: string, to: string) {
  const dataTransfer = { setData: noop, effectAllowed: "", dropEffect: "" };
  act(() => {
    fireEvent.dragStart(tab(container, from), { dataTransfer });
  });
  act(() => {
    fireEvent.dragOver(tab(container, to), { dataTransfer });
  });
  act(() => {
    fireEvent.drop(tab(container, to), { dataTransfer });
  });
}

it("moves the tab at once on drop, before the server answers", () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  expect(shownOrder(container)).toEqual(["c", "a", "b"]);
  expect(writes.map((w) => w.order)).toEqual([["c", "a", "b"]]);
});

it("returns to the server order when the write fails", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  await act(async () => writes[0].reject(new Error("offline")));
  expect(shownOrder(container)).toEqual(["a", "b", "c"]);
});

it("keeps the move over a full_state that lands while the write is in flight", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  // An unrelated push with the old order arrives first.
  act(() => fullState(["a", "b", "c"]));
  expect(shownOrder(container)).toEqual(["c", "a", "b"]);
  // Then the confirming push and the response.
  act(() => fullState(["c", "a", "b"]));
  await act(async () => writes[0].resolve());
  expect(shownOrder(container)).toEqual(["c", "a", "b"]);
  // The overlay retired at the response: a later reorder from another
  // device shows as it is.
  act(() => fullState(["b", "a", "c"]));
  expect(shownOrder(container)).toEqual(["b", "a", "c"]);
});

it("takes the server order from the first full_state after success", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  await act(async () => writes[0].resolve());
  expect(shownOrder(container)).toEqual(["c", "a", "b"]);
  // The server clamped the write to another order: the server wins.
  act(() => fullState(["b", "c", "a"]));
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
});

it("converges on the confirming push after older pushes that follow the response", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  drag(container, "b", "c");
  // The newest write succeeds first; the older write's success comes later
  // and must not change the newest pending move.
  await act(async () => writes[1].resolve());
  await act(async () => writes[0].resolve());
  // Two older states were still queued on the socket ahead of the
  // confirming one. They may show for a moment.
  act(() => fullState(["a", "b", "c"]));
  act(() => fullState(["c", "a", "b"]));
  act(() => fullState(["b", "c", "a"]));
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
  // The overlay is gone: the next server state shows as it is.
  act(() => fullState(["a", "c", "b"]));
  expect(shownOrder(container)).toEqual(["a", "c", "b"]);
});

it("ignores an older write's success while the newest is in flight", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  drag(container, "b", "c");
  await act(async () => writes[0].resolve());
  // An unrelated push with the first move's order: the newest move holds.
  act(() => fullState(["c", "a", "b"]));
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
});

it("does not let an older failed write undo a newer move", async () => {
  const { container } = mount(["a", "b", "c"]);
  drag(container, "c", "a");
  drag(container, "b", "c");
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
  await act(async () => writes[0].reject(new Error("offline")));
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
  // A late full_state that still carries the first move does not confirm
  // the newer one.
  act(() => fullState(["c", "a", "b"]));
  expect(shownOrder(container)).toEqual(["b", "c", "a"]);
  await act(async () => writes[1].reject(new Error("offline")));
  expect(shownOrder(container)).toEqual(["c", "a", "b"]);
});
