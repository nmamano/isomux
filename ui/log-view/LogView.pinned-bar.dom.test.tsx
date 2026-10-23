// Task f4baf304: the pinned "you:" bar overlays a fixed band at the top of the
// chat scroller. When it sat in the layout above the scroller, showing it
// shrank the scroller, which could show the message again and hide the bar,
// in a loop. Now the band is out of view whether or not the bar shows: a
// message hidden under it pins, and the bar never takes layout space.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { PINNED_BAR_HEIGHT } = await import("./pinned-message.ts");
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

const QUESTION = "what broke the build";
const logs: LogEntry[] = [
  {
    id: "u1",
    agentId: "a1",
    timestamp: 1,
    kind: "user_message",
    content: QUESTION,
    metadata: { username: "Nil" },
  },
  { id: "t1", agentId: "a1", timestamp: 2, kind: "text", content: "reply" },
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

// happy-dom has no layout: the test owns the rects of the scroller and of the
// human message.
function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 800,
    width: 800,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

it("pins a message hidden under the bar's band, and the bar takes no layout space", async () => {
  setApiShim(async () => ({ counts: {} }));
  const view = render(
    <StoreProvider>
      <Page />
    </StoreProvider>,
  );
  const scroller = view.container.querySelector<HTMLElement>(".chat-messages")!;
  const message = view.container.querySelector<HTMLElement>(
    '[data-log-entry-id="u1"]',
  )!;
  const scrollerTop = 100;
  const bandEdge = scrollerTop + PINNED_BAR_HEIGHT;
  let messageRect = rect(bandEdge - 20, bandEdge + 1);
  scroller.getBoundingClientRect = () => rect(scrollerTop, 600);
  message.getBoundingClientRect = () => messageRect;
  // Let the mount-time effects (and their animation frames) settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const scrollWith = async (next: DOMRect) => {
    messageRect = next;
    await act(async () => {
      fireEvent.scroll(scroller);
    });
  };
  // The bar is the only element outside the transcript that carries the
  // message as its tooltip.
  const bar = () =>
    [...view.container.querySelectorAll<HTMLElement>("[title]")].find(
      (element) =>
        element.getAttribute("title") === QUESTION &&
        !scroller.contains(element),
    );

  // One pixel of the message shows below the band: it is visible, no bar.
  await scrollWith(rect(bandEdge - 20, bandEdge + 1));
  expect(bar()).toBeUndefined();

  // Its bottom reaches the band: the bar would cover it, so it pins.
  await scrollWith(rect(bandEdge - 20, bandEdge));
  const shown = bar();
  expect(shown).toBeDefined();
  // The bar overlays exactly the band at the top of the scroller, out of flow,
  // so showing it cannot change the scroller's height.
  expect(shown!.parentElement === scroller.parentElement).toBe(true);
  expect(shown!.style.position).toBe("absolute");
  expect(shown!.style.top).toBe("0px");
  expect(shown!.style.height).toBe(`${PINNED_BAR_HEIGHT}px`);
  // Scrolls into view (a click on the bar, find in page) stop below the band.
  expect(scroller.style.scrollPaddingTop).toBe(`${PINNED_BAR_HEIGHT}px`);

  // While the bar shows, the same rule hides it again: the band is out of
  // view either way.
  await scrollWith(rect(bandEdge - 20, bandEdge + 1));
  expect(bar()).toBeUndefined();
  view.unmount();
});
