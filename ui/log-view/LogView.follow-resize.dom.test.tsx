// Task ffe82e3a: an image that loads late, or a scroller that shrinks, moves
// the bottom with no logs change and no scroll event. While the member follows
// the bottom, the chat re-pins on those; once they scrolled up, it leaves their
// place alone. Growth the member causes (expanding a card) is never re-pinned.
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type LogEntry = import("../../shared/types.ts").LogEntry;

// happy-dom has no layout and no ResizeObserver: the test owns both. A resize
// reaches only the observers that watch the resized element, as in a browser.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  static resize(target: Element) {
    for (const observer of FakeResizeObserver.instances)
      if (!observer.disconnected && observer.targets.includes(target))
        observer.callback([{ target }]);
  }
  targets: Element[] = [];
  disconnected = false;
  constructor(readonly callback: (entries: { target: Element }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}
const globals = globalThis as Record<string, unknown>;
const originalResizeObserver = globals.ResizeObserver;
beforeEach(() => {
  FakeResizeObserver.instances = [];
  globals.ResizeObserver = FakeResizeObserver;
});
afterEach(() => {
  globals.ResizeObserver = originalResizeObserver;
});

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "waiting_for_response",
  agentType: "codex",
  modelFamily: "gpt-6-astra",
  topic: null,
  capabilities: { edit: true },
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

const logs: LogEntry[] = [
  { id: "t1", agentId: "a1", timestamp: 1, kind: "text", content: "reply" },
];

function Page() {
  const state = useAppState();
  return (
    <StateCtx.Provider value={state}>
      <LogView
        agent={agent}
        logs={logs}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

// A scroller with a fake geometry: every scrollTop write is recorded.
function fakeGeometry(scroller: HTMLElement) {
  const geometry = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  const writes: number[] = [];
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      writes.push(value);
      geometry.scrollTop = Math.min(
        value,
        geometry.scrollHeight - geometry.clientHeight,
      );
    },
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  return { geometry, writes };
}

async function mount() {
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page />
    </StoreProvider>,
  );
  const scroller = view.container.querySelector<HTMLElement>(".chat-messages")!;
  const fake = fakeGeometry(scroller);
  // Let the mount-time effects (and their animation frames) settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const following = () =>
    view.container.querySelector("[data-jump-to-bottom]") === null;
  // The member scrolls: the geometry moves, then the scroll event fires.
  const scrollTo = async (top: number) => {
    fake.geometry.scrollTop = top;
    await act(async () => {
      fireEvent.scroll(scroller);
    });
  };
  // An image inside the transcript finishes loading. load does not bubble.
  const imageLoads = async () => {
    const image = document.createElement("img");
    scroller.lastElementChild!.appendChild(image);
    await act(async () => {
      image.dispatchEvent(new Event("load"));
    });
    image.remove();
  };
  const scrollerResizes = async () => {
    await act(async () => FakeResizeObserver.resize(scroller));
  };
  return {
    view,
    scroller,
    following,
    scrollTo,
    imageLoads,
    scrollerResizes,
    ...fake,
  };
}

it("re-pins when an image loads while the member follows", async () => {
  const { view, following, scrollTo, imageLoads, geometry, writes } =
    await mount();
  await scrollTo(800); // at the bottom of 1000 - 200
  expect(following()).toBe(true);
  geometry.scrollHeight = 1600; // the image is taller than its placeholder
  writes.length = 0;
  await imageLoads();
  expect(writes).toEqual([1600]);
  expect(geometry.scrollTop).toBe(1400);
  view.unmount();
});

it("re-pins when the scroller shrinks while the member follows", async () => {
  const { view, following, scrollTo, scrollerResizes, geometry, writes } =
    await mount();
  await scrollTo(800);
  expect(following()).toBe(true);
  geometry.clientHeight = 150; // the composer grew
  writes.length = 0;
  await scrollerResizes();
  expect(writes).toEqual([1000]);
  expect(geometry.scrollTop).toBe(850);
  view.unmount();
});

it("leaves the member's place alone after they scrolled up", async () => {
  const {
    view,
    following,
    scrollTo,
    imageLoads,
    scrollerResizes,
    geometry,
    writes,
  } = await mount();
  await scrollTo(800);
  await scrollTo(100); // the member scrolls up
  expect(following()).toBe(false);
  geometry.scrollHeight = 1600;
  geometry.clientHeight = 150;
  writes.length = 0;
  await imageLoads();
  await scrollerResizes();
  expect(writes).toEqual([]);
  expect(geometry.scrollTop).toBe(100);
  view.unmount();
});

// A member at the bottom expands a card: it must open downward. Only an image
// load or a scroller resize re-pins, so a resize of anything inside the
// transcript writes nothing.
it("does not re-pin growth inside the transcript", async () => {
  const { view, scroller, following, scrollTo, geometry, writes } =
    await mount();
  await scrollTo(800);
  expect(following()).toBe(true);
  geometry.scrollHeight = 1600; // a card opened
  writes.length = 0;
  await act(async () => {
    for (const element of scroller.querySelectorAll("*"))
      FakeResizeObserver.resize(element);
  });
  expect(writes).toEqual([]);
  view.unmount();
});

it("stops following image loads and resizes on unmount", async () => {
  const { view, scroller, following, scrollTo, geometry, writes } =
    await mount();
  await scrollTo(800);
  expect(following()).toBe(true);
  const image = document.createElement("img");
  scroller.lastElementChild!.appendChild(image);
  view.unmount();
  geometry.scrollHeight = 1600;
  writes.length = 0;
  image.dispatchEvent(new Event("load"));
  FakeResizeObserver.resize(scroller);
  expect(writes).toEqual([]);
});

// Safari fires the scroll event of a pin a frame later. When an image loaded
// in that frame, the event sees a gap although the view did not move up; the
// member did not leave the bottom, and the load re-pins.
it("keeps following when content grew before the scroll event of a pin", async () => {
  const { view, following, scrollTo, imageLoads, geometry, writes } =
    await mount();
  await scrollTo(800);
  expect(following()).toBe(true);
  geometry.scrollHeight = 1600; // grew between the pin and its event
  await scrollTo(800);
  expect(following()).toBe(true);
  writes.length = 0;
  await imageLoads();
  expect(writes).toEqual([1600]);
  view.unmount();
});
