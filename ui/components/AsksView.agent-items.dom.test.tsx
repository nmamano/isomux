// The agent items on the Asks page (task ddf02829): an agent waiting on a
// permission request and an agent that failed show above the asks, follow
// the room filter but not the priority filter, answer and dismiss in place,
// and count on the Inbox badge until the page has shown them.
// Who sees which item is ui/inbox-agent-items.test.ts.
//
// Markers the page carries: [data-agent-item="<item key>"] on each card,
// [data-agent-item-open] (Open chat) and, on a failed card,
// [data-agent-item-text] (the error) and [data-agent-item-dismiss].
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { setApiShim } = await import("../api.ts");
const { resetInboxSeenForTests } = await import("../inbox-seen.ts");
const { selfUserRecord } = await import("../test-support/language-fixture.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { useInboxCounts } = await import("../inbox.ts");
const { failureKey } = await import("../inbox-agent-items.ts");
const { ranked, mount, setRooms, setPriorities } =
  await import("../test-support/asks-view.ts");
type AppState = typeof initialState;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type AgentChoiceInteraction =
  import("../../shared/types.ts").AgentChoiceInteraction;

const ME = "u1";

let calls: { method: string; path: string; body: unknown }[] = [];
beforeEach(() => {
  localStorage.clear();
  resetInboxSeenForTests();
  calls = [];
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return undefined;
  });
});
afterEach(() => setApiShim(null));

const agents = [
  // r1: a permission wait with choices, and a failure its manager (me) sees.
  {
    id: "a1",
    name: "Scout",
    roomId: "r1",
    userId: "u9",
    pendingPrompt: "permission",
    turnMemberIds: [],
  },
  {
    id: "a3",
    name: "Pathfinder",
    roomId: "r1",
    userId: ME,
    pendingPrompt: null,
    turnMemberIds: [],
    failure: {
      since: 300,
      content: "\n  Error: disk full \nType /clear to start fresh.",
      memberIds: [],
    },
  },
  // r2: a failure of a turn I started, and one I already dismissed.
  {
    id: "a2",
    name: "Ranger",
    roomId: "r2",
    userId: "u9",
    pendingPrompt: null,
    turnMemberIds: [],
    failure: { since: 200, content: "Error: rate limited", memberIds: [ME] },
  },
  {
    id: "a4",
    name: "Tracker",
    roomId: "r2",
    userId: ME,
    pendingPrompt: null,
    turnMemberIds: [],
    failure: { since: 100, content: "Error: old", memberIds: [] },
  },
] as unknown as AgentInfo[];

const interactions: AgentChoiceInteraction[] = [
  {
    id: "perm-1",
    agentId: "a1",
    kind: "permission",
    title: "Scout wants to run Bash",
    instruction: "Pick one",
    choices: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny" },
    ],
    permission: {
      description: "Publish the package",
      input: { command: "npm publish --tags" },
    },
  },
];

// a4's failure is dismissed; "gone:1" names a failure no agent has any more.
// The keys are built when a test runs, from the module's own failureKey.
const dismissed = () => [failureKey("a4", 100), "gone:1"];

function place(over: Partial<AppState> = {}): Partial<AppState> {
  return {
    agents: agents as AppState["agents"],
    interactions,
    sessionContext: {
      userId: ME,
      username: "Mia",
      role: "member",
    } as AppState["sessionContext"],
    // The store keys a record by its lowercased name (ui/user-merge.ts).
    users: new Map([
      [
        "mia",
        {
          ...selfUserRecord(null),
          id: ME,
          name: "Mia",
          role: "member",
          inboxDismissed: dismissed(),
        },
      ],
    ]) as unknown as AppState["users"],
    ...over,
  };
}

const PERM = "permission:perm-1";
let F3 = "";
let F2 = "";
beforeEach(() => {
  F3 = `failed:${failureKey("a3", 300)}`;
  F2 = `failed:${failureKey("a2", 200)}`;
});

const itemKeys = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-agent-item]")].map(
    (el) => el.dataset.agentItem!,
  );
const item = (root: HTMLElement, key: string) =>
  root.querySelector<HTMLElement>(`[data-agent-item="${key}"]`);

describe("agent items on the Asks page", () => {
  it("shows the permission wait and the undismissed failures above the asks, also after a sort change", async () => {
    const { view } = mount([ranked("q1", "a1", 30, "P1")], place());
    const c = view.container;
    expect(itemKeys(c)).toEqual([PERM, F3, F2]);
    const firstAsk = c.querySelector("[data-ask]");
    expect(firstAsk).not.toBeNull();
    for (const key of [PERM, F3, F2])
      expect(
        item(c, key)!.compareDocumentPosition(firstAsk!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    // The failed card says what failed: only the error's first line, on one
    // line that ends in an ellipsis (Nil, 2026-11-11 sign-off). The chat has
    // the rest.
    const text = item(c, F3)!.querySelector<HTMLElement>(
      "[data-agent-item-text]",
    )!;
    expect(text.textContent).toBe("Error: disk full");
    expect(text.style.whiteSpace).toBe("nowrap");
    expect(text.style.overflow).toBe("hidden");
    expect(text.style.textOverflow).toBe("ellipsis");
    // Another sort (the last one the page offers) keeps them on top.
    const sort = c.querySelector<HTMLSelectElement>("select[data-asks-sort]")!;
    const other = [...sort.options].at(-1)!.value;
    expect(other).not.toBe(sort.value);
    act(() => void fireEvent.change(sort, { target: { value: other } }));
    expect(sort.value).toBe(other);
    expect(
      item(c, PERM)!.compareDocumentPosition(c.querySelector("[data-ask]")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("follows the room filter, not the priority filter", async () => {
    const { view } = mount([ranked("q1", "a1", 30, "P1")], place());
    const c = view.container;
    await setRooms(view, ["r2"]);
    expect(itemKeys(c)).toEqual([F2]);
    await setRooms(view, ["r1", "r2"]);
    await setPriorities(view, ["P0"]);
    expect(itemKeys(c)).toEqual([PERM, F3, F2]);
  });

  it("shows the items when no ask is open, without the no-asks empty state", () => {
    const { view } = mount([], place());
    expect(itemKeys(view.container)).toEqual([PERM, F3, F2]);
    expect(view.container.querySelector("[data-asks-empty]")).toBeNull();
  });

  it("answers a permission choice in place through the respond route, showing what it is for", async () => {
    const { view, focused } = mount([], place());
    const card = item(view.container, PERM)!;
    // The reason and the command, as the chat shows them above its card.
    expect(
      card.querySelector("[data-agent-item-description]")?.textContent,
    ).toContain("Publish the package");
    expect(
      card.querySelector('[data-agent-item-input="command"]')?.textContent,
    ).toContain("npm publish --tags");
    const allow = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.includes("Allow"),
    );
    expect(allow).toBeTruthy();
    await act(async () => void fireEvent.click(allow!));
    // Leave out the seen marks the page sent when it showed the items.
    expect(calls.filter((x) => x.path !== "/api/me/view/inbox-seen")).toEqual([
      {
        method: "POST",
        path: "/api/agents/a1/interactions/perm-1/respond",
        body: { value: "allow" },
      },
    ]);
    // Open chat goes to the agent.
    await act(
      async () =>
        void fireEvent.click(
          card.querySelector<HTMLElement>("[data-agent-item-open]")!,
        ),
    );
    expect(focused).toEqual(["a1"]);
  });

  it("shows a permission wait with no choices as Open chat only", () => {
    const { view } = mount([], place({ interactions: [] }));
    const card = item(view.container, "permission:a1")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-agent-item-open]")).not.toBeNull();
    expect(card.querySelector("[data-agent-item-dismiss]")).toBeNull();
    expect(card.querySelector("section button")).toBeNull();
  });

  it("dismisses a failure for the member: the whole list, live keys kept, stale ones dropped", async () => {
    const { view, latest } = mount([], place());
    const card = item(view.container, F2)!;
    expect(
      item(view.container, PERM)!.querySelector("[data-agent-item-dismiss]"),
    ).toBeNull();
    await act(
      async () =>
        void fireEvent.click(
          card.querySelector<HTMLElement>("[data-agent-item-dismiss]")!,
        ),
    );
    const patches = calls.filter(
      (x) => x.method === "PATCH" && x.path === "/api/me/preferences",
    );
    expect(patches).toHaveLength(1);
    const body = patches[0].body as { inboxDismissed: string[] };
    expect(Object.keys(body)).toEqual(["inboxDismissed"]);
    expect([...body.inboxDismissed].sort()).toEqual(
      [failureKey("a4", 100), failureKey("a2", 200)].sort(),
    );
    // The server's answer (user_self_updated) removes the card.
    act(() =>
      latest.dispatch({
        type: "user_self_updated",
        user: { id: ME, name: "Mia", inboxDismissed: body.inboxDismissed },
      } as unknown as Parameters<typeof latest.dispatch>[0]),
    );
    expect(itemKeys(view.container)).toEqual([PERM, F3]);
  });
});

describe("agent items on the Inbox badge", () => {
  function Probe() {
    const c = useInboxCounts();
    return createElement("output", {
      "data-counts": `${c.asks}/${c.newAsks}`,
    });
  }
  const counts = (root: HTMLElement) =>
    root.querySelector<HTMLElement>("[data-counts]")!.dataset.counts;

  it("counts the items as new until the Asks page shows them, also with no ask open", async () => {
    const state = { ...initialState, ...place(), asks: [] } as AppState;
    const probe = render(
      createElement(StateCtx.Provider, { value: state }, createElement(Probe)),
    );
    expect(counts(probe.container)).toBe("3/3");
    const { view } = mount([], place());
    await act(async () => {});
    expect(itemKeys(view.container)).toHaveLength(3);
    // Marked on the member's record, by their keys (task 64d3950a).
    const marks = calls.filter(
      (x) => x.method === "POST" && x.path === "/api/me/view/inbox-seen",
    );
    expect(marks.length).toBe(1);
    expect([...(marks[0].body as { keys: string[] }).keys].sort()).toEqual(
      [PERM, F3, F2].sort(),
    );
    expect(counts(probe.container)).toBe("3/0");
  });
});
