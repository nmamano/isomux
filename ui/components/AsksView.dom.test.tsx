// The Asks page (ui/components/AsksView.tsx) over a real reducer: groups by
// agent with the longest wait first, the agent's name opens its chat, an ask
// from an agent the client does not have stays out, and a group goes with its
// last card.
import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { useReducer, createElement } = await import("react");
const { AsksView } = await import("./AsksView.tsx");
const { StateCtx, DispatchCtx, initialState, reducer } =
  await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AppState = typeof initialState;

const NOW = Date.now();
const ask = (id: string, agentId: string, ageMin: number): AskEntry => ({
  id,
  agentId,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - ageMin * 60_000,
  updatedAt: NOW - ageMin * 60_000,
});

let posts: string[] = [];
let bodies: unknown[] = [];
beforeEach(() => {
  posts = [];
  bodies = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push(path);
      bodies.push(body);
    }
    return undefined;
  });
});
afterAll(() => setApiShim(null));

function mount(asks: AskEntry[]) {
  const seeded: AppState = {
    ...initialState,
    asks,
    rooms: [
      { id: "r1", name: "Room One" },
      { id: "r2", name: "Room Two" },
    ] as AppState["rooms"],
    agents: [
      { id: "a1", name: "Scout", roomId: "r1" },
      { id: "a2", name: "Ranger", roomId: "r2" },
    ] as AppState["agents"],
  };
  const focused: string[] = [];
  const latest: { state: AppState } = { state: seeded };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, seeded);
    latest.state = state;
    return createElement(
      StateCtx.Provider,
      { value: state },
      createElement(
        DispatchCtx.Provider,
        { value: dispatch },
        createElement(AsksView, {
          onFocusAgent: (id: string) => focused.push(id),
        }),
      ),
    );
  }
  const view = render(createElement(Harness));
  return { view, focused, latest };
}

const groupIds = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-asks-group]")].map(
    (el) => el.dataset.asksGroup,
  );
const cardIds = (view: ReturnType<typeof render>, agentId: string) =>
  [
    ...view.container.querySelectorAll<HTMLElement>(
      `[data-asks-group="${agentId}"] [data-ask]`,
    ),
  ].map((el) => el.dataset.ask);

it("groups by agent, longest wait first, cards oldest first, with the room", () => {
  const { view } = mount([
    ask("a1new", "a1", 5),
    ask("a2old", "a2", 90),
    ask("a1old", "a1", 30),
  ]);
  expect(groupIds(view)).toEqual(["a2", "a1"]);
  expect(cardIds(view, "a1")).toEqual(["a1old", "a1new"]);
  const header = view.container.querySelector('[data-asks-group="a2"]')!;
  expect(header.textContent).toContain("Ranger");
  expect(header.textContent).toContain("Room Two");
});

it("leaves out an ask whose agent the client does not have", () => {
  const { view } = mount([ask("seen", "a1", 5), ask("hidden", "gone", 50)]);
  expect(groupIds(view)).toEqual(["a1"]);
  expect(view.container.querySelector('[data-ask="hidden"]')).toBeNull();
});

it("opens the agent's chat from its name", async () => {
  const { view, focused } = mount([ask("q1", "a2", 5)]);
  const name = view.container.querySelector<HTMLButtonElement>(
    '[data-asks-agent="a2"]',
  )!;
  expect(name.tagName).toBe("BUTTON");
  await act(async () => fireEvent.click(name));
  expect(focused).toEqual(["a2"]);
});

it("drops a group with its last card, then shows the empty state", async () => {
  const { view } = mount([ask("onlyA", "a1", 5), ask("onlyB", "a2", 10)]);
  expect(view.container.querySelector("[data-asks-empty]")).toBeNull();
  const reply = (id: string) =>
    view.container
      .querySelector(`[data-ask="${id}"]`)!
      .querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => fireEvent.click(reply("onlyA")));
  expect(posts).toEqual(["/api/asks/onlyA/reply"]);
  expect(groupIds(view)).toEqual(["a2"]);
  // The form's other button is Dismiss; Show more sits outside the form.
  const dismiss = view.container
    .querySelector('[data-ask="onlyB"]')!
    .querySelector<HTMLButtonElement>('form button[type="button"]')!;
  await act(async () => fireEvent.click(dismiss));
  expect(posts).toEqual(["/api/asks/onlyA/reply", "/api/asks/onlyB/dismiss"]);
  expect(groupIds(view)).toEqual([]);
  expect(view.container.querySelector("[data-asks-empty]")).not.toBeNull();
});

it("fills the reply field with a tapped option, and Reply sends it", async () => {
  const { view } = mount([
    { ...ask("pick", "a1", 5), options: ["Yes", "No"] },
    ask("open", "a2", 10),
  ]);
  const card = view.container.querySelector('[data-ask="pick"]')!;
  const options = [
    ...card.querySelectorAll<HTMLButtonElement>("[data-ask-option]"),
  ];
  expect(options.map((b) => b.textContent)).toEqual(["Yes", "No"]);
  await act(async () => fireEvent.click(options[1]));
  expect(posts).toEqual([]);
  expect(card.querySelector<HTMLInputElement>("form input")!.value).toBe("No");
  await act(async () =>
    fireEvent.click(
      card.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    ),
  );
  expect(posts).toEqual(["/api/asks/pick/reply"]);
  expect(bodies).toEqual([{ text: "No" }]);
  expect(groupIds(view)).toEqual(["a2"]);
});

it("moves with Tab from one agent's reply field to the next agent's, in page order", () => {
  const { view } = mount([ask("later", "a1", 30), ask("first", "a2", 90)]);
  const field = (id: string) =>
    view.container.querySelector<HTMLInputElement>(
      `[data-ask="${id}"] form input`,
    )!;
  // A scalar: a failed toBe on two DOM nodes serialises both.
  const focused = () => {
    const el = document.activeElement;
    return `${el?.closest<HTMLElement>("[data-ask]")?.dataset.ask}/${el?.tagName}`;
  };
  // a2 waited longest, so its group is drawn first.
  act(() => field("first").focus());
  let free = true;
  act(() => {
    free = fireEvent.keyDown(field("first"), { key: "Tab" });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("later/INPUT");
  act(() => {
    free = fireEvent.keyDown(field("later"), { key: "Tab", shiftKey: true });
  });
  expect(free).toBe(false);
  expect(focused()).toBe("first/INPUT");
});

it("hands an editor or command card to the ask's agent and opens that agent's chat", async () => {
  const { view, focused, latest } = mount([
    {
      ...ask("acts", "a2", 5),
      commands: ["bun test"],
      editFiles: [{ cwd: "/w", path: "/w/notes.md" }],
    },
  ]);
  const card = view.container.querySelector('[data-ask="acts"]')!;
  await act(async () =>
    fireEvent.click(
      card.querySelector("[data-ask-edit-file] button[data-panel-action]")!,
    ),
  );
  expect(focused).toEqual(["a2"]);
  expect(latest.state.pendingEditorPaths.get("a2")).toBe("/w/notes.md");
  expect(latest.state.sidePanels.get("a2")).toBe("editor");
  await act(async () =>
    fireEvent.click(
      card.querySelector("[data-ask-command] button[data-panel-action]")!,
    ),
  );
  expect(focused).toEqual(["a2", "a2"]);
  expect(latest.state.pendingTerminalCommands.get("a2")).toBe("bun test");
  expect(latest.state.sidePanels.get("a2")).toBe("terminal");
  // Nothing was answered, and the card stays.
  expect(posts).toEqual([]);
  expect(cardIds(view, "a2")).toEqual(["acts"]);
});
