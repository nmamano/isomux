// Task 46fea319: End gives the focus to the composer, so the member types the
// first message of the new conversation at once. A click focuses End, and End
// turns inert when the clear empties the chat, which dropped the focus to the
// page. On a touch-primary device a focus opens the on-screen keyboard, so the
// focus stays where it was there, as at mount (task 472fa057).
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { primaryPointer } = await import("../test-support/pointer.ts");
const {
  outboxFixture: fx,
  setupOutboxTests,
  composer,
} = await import("../test-support/outbox-fixture.tsx");
setupOutboxTests();

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
const EN = translatorFor("en");

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
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

const conversation: LogEntry[] = [
  { id: "e1", agentId: agent.id, timestamp: 1, kind: "text", content: "hi" },
];

interface Setup {
  narrow: boolean;
  connected: boolean;
}

function Page({ narrow, connected, logs }: Setup & { logs: LogEntry[] }) {
  const state = useAppState();
  return (
    <StateCtx.Provider value={{ ...state, isMobile: narrow, connected }}>
      <LogView
        agent={agent}
        logs={logs}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

function endTitle(): string {
  return EN.t("logView.nav.endConversationTitle");
}

// The End button: inline in the bar on a wide layout, in the "..." menu on a
// narrow one. The menu renders in a portal, so look in the whole document.
async function endButton(narrow: boolean): Promise<HTMLButtonElement> {
  if (narrow) {
    const more = document.querySelector<HTMLButtonElement>(
      `button[title="${EN.t("common.moreActions")}"]`,
    );
    expect(more === null).toBe(false);
    await act(async () => {
      fireEvent.click(more!);
    });
  }
  const end = document.querySelector<HTMLButtonElement>(
    `button[title="${endTitle()}"]`,
  );
  expect(end === null).toBe(false);
  expect(end!.disabled).toBe(false);
  return end!;
}

// Mounts a chat with one entry, clicks End the way a mouse does (the press
// focuses the button first), then lets the clear land: the chat empties and
// End turns inert. Reports what has focus after the click and after the clear.
async function clickEnd(
  setup: Setup & { coarse: boolean },
): Promise<{ afterClick: string; afterClear: string; container: HTMLElement }> {
  const undo = primaryPointer(setup.coarse);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(setup.coarse);
    const view = render(
      <StoreProvider>
        <Page {...setup} logs={conversation} />
      </StoreProvider>,
    );
    const end = await endButton(setup.narrow);
    end.focus();
    // The condition the test needs: End holds the focus, not the composer.
    expect(document.activeElement === end).toBe(true);
    const where = () =>
      document.activeElement === composer(view.container)
        ? "composer"
        : document.activeElement === end
          ? "end"
          : (document.activeElement?.tagName ?? "none");
    await act(async () => {
      fireEvent.click(end);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const afterClick = where();
    view.rerender(
      <StoreProvider>
        <Page {...setup} logs={[]} />
      </StoreProvider>,
    );
    const inert = view.container.querySelector<HTMLButtonElement>(
      `button[title="${endTitle()}"]`,
    );
    if (inert) expect(inert.disabled).toBe(true);
    return { afterClick, afterClear: where(), container: view.container };
  } finally {
    undo();
  }
}

for (const narrow of [false, true]) {
  const layout = narrow ? "from the narrow layout's menu" : "from the bar";
  it(`End ${layout} gives the composer the focus with a mouse`, async () => {
    const { afterClick, afterClear } = await clickEnd({
      narrow,
      connected: true,
      coarse: false,
    });
    expect(fx.posts.map((p) => p.text)).toEqual(["/clear"]);
    expect(afterClick).toBe("composer");
    expect(afterClear).toBe("composer");
  });
}

it("End on a touch screen ends the conversation and does not focus the composer", async () => {
  const { afterClick, afterClear } = await clickEnd({
    narrow: true,
    connected: true,
    coarse: true,
  });
  expect(fx.posts.map((p) => p.text)).toEqual(["/clear"]);
  expect(afterClick === "composer").toBe(false);
  expect(afterClear === "composer").toBe(false);
});

it("End while disconnected sends nothing and does not focus the composer", async () => {
  const { afterClick, afterClear } = await clickEnd({
    narrow: false,
    connected: false,
    coarse: false,
  });
  expect(fx.posts.length).toBe(0);
  expect(afterClick === "composer").toBe(false);
  expect(afterClear === "composer").toBe(false);
});
