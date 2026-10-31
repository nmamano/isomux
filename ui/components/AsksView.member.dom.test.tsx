// The Asks page's member select for an office owner (task a49856f7): whose
// open asks the page lists, and the card of another member's ask, which the
// owner answers as their own (task d555a32e). The choice's storage has its
// own owner ("asks member" in ui/device-settings.test.ts) and the slice its
// own ("reducer: other members' asks" in ui/store.test.ts). A separate file
// because each DOM file has a wall-time budget.
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, mount, control, choose, pageOrder } =
  await import("../test-support/asks-view.ts");
const { ASK_UNDO_MS } = await import("./AsksView.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { filterButton } = await import("../test-support/checkbox-filters.ts");

type AppState = import("../test-support/asks-view.ts").AppState;
type AskAgentWire = import("../../shared/contract-shapes.ts").AskAgentWire;
type View = ReturnType<typeof mount>["view"];

const session = (role: "owner" | "member") =>
  ({
    userId: "u1",
    username: "nil",
    role,
    currentSessionPrefix: "abcd1234",
  }) as AppState["sessionContext"];

// Another member's ask, as GET /api/asks/others sends it.
const other = (
  id: string,
  agentId: string,
  ageMin: number,
  member: string,
  extra: Partial<AskAgentWire> = {},
): AskAgentWire => ({
  ...ask(id, agentId, ageMin),
  memberUserId: `u-${member}`,
  member,
  ...extra,
});

// Nil's own ask carries a command too: the own card is the twin another
// member's card must match.
const OWN = [{ ...ask("mine1", "a1", 30), commands: ["ls -la"] }];
const OTHERS = [
  other("pat1", "a1", 20, "pat", {
    options: ["Ship", "Wait"],
    recommended: "Ship",
    commands: ["git push"],
  }),
  other("abe1", "a2", 10, "Abe"),
  // An agent the client does not have (a hidden room): never shown.
  other("ghost", "a9", 5, "pat"),
];

const seed = (role: "owner" | "member") => ({
  sessionContext: session(role),
  othersAsks: OTHERS,
});

const card = (view: View, id: string) =>
  view.container.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const shownIds = (view: View) =>
  [...view.container.querySelectorAll<HTMLElement>("[data-ask]")].map(
    (el) => el.dataset.ask,
  );
// Whether `a` comes before `b` in the page.
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

let posts: string[] = [];
let bodies: unknown[] = [];
let answer: () => Promise<unknown> = async () => undefined;
beforeEach(() => {
  posts = [];
  bodies = [];
  answer = async () => undefined;
  setApiShim(async (method, path, body) => {
    if (method !== "POST") return undefined;
    posts.push(path);
    bodies.push(body);
    return answer();
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));

// Moves the fake clock, then lets the shim's promise and its dispatch land.
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

describe("the member select", () => {
  beforeEach(() => localStorage.clear());

  it("is not drawn for a member who is not an owner, whose page lists only their own asks", () => {
    const { view } = mount(OWN, seed("member"));
    expect(view.container.querySelector("select[data-asks-member]")).toBeNull();
    expect(shownIds(view)).toEqual(["mine1"]);
  });

  it("lists the owner's own asks first, every member's, or one member's, and the choice survives a remount", () => {
    const first = mount(OWN, seed("owner"));
    const { view } = first;
    // The select comes after the room and priority filters, so those keep
    // their place for members and owners, and before the sort.
    const member = control(view, "data-asks-member");
    expect(member).not.toBeNull();
    const row = [
      filterButton(view.container, "room"),
      filterButton(view.container, "priority"),
      member,
      control(view, "data-asks-sort"),
    ];
    expect(row.slice(1).map((el, i) => precedes(row[i], el))).toEqual([
      true,
      true,
      true,
    ]);
    // A labeled control, whatever the words.
    expect(member.getAttribute("aria-label") ?? "").not.toBe("");
    // Mine, all, then each other member with an open ask, by name whatever
    // the case.
    expect([...member.options].map((o) => o.value)).toEqual([
      "mine",
      "all",
      "member:Abe",
      "member:pat",
    ]);
    expect(member.value).toBe("mine");
    expect(shownIds(view)).toEqual(["mine1"]);

    choose(view, "data-asks-member", "all");
    expect(new Set(shownIds(view))).toEqual(new Set(["mine1", "pat1", "abe1"]));
    // The sort applies to the whole set: by agent, oldest first.
    expect(pageOrder(view)).toEqual(["a1:mine1,pat1", "a2:abe1"]);

    choose(view, "data-asks-member", "member:pat");
    expect(shownIds(view)).toEqual(["pat1"]);

    view.unmount();
    const again = mount(OWN, seed("owner")).view;
    expect(control(again, "data-asks-member").value).toBe("member:pat");
    expect(shownIds(again)).toEqual(["pat1"]);
  });

  it("keeps a chosen member while their last ask closes, with an empty page", () => {
    const { view, latest } = mount(OWN, seed("owner"));
    choose(view, "data-asks-member", "member:Abe");
    expect(shownIds(view)).toEqual(["abe1"]);
    act(() => latest.dispatch({ type: "others_ask_removed", id: "abe1" }));
    const member = control(view, "data-asks-member");
    expect(member.value).toBe("member:Abe");
    expect([...member.options].map((o) => o.value)).toContain("member:Abe");
    expect(shownIds(view)).toEqual([]);
    expect(
      view.container.querySelector(
        "[data-asks-empty], [data-asks-filtered-empty]",
      ),
    ).not.toBeNull();
  });
});

// The pending line's kind, or null while the card is drawn.
const pendingOf = (view: View, id: string) => {
  const el = card(view, id);
  const marked = el?.matches("[data-ask-pending]")
    ? el
    : el?.querySelector<HTMLElement>("[data-ask-pending]");
  return marked?.dataset.askPending ?? null;
};
const fieldOf = (view: View, id: string) =>
  card(view, id)?.querySelector<HTMLTextAreaElement>("[data-ask-reply-input]");
// Types the reply in the card's field and sends it.
async function reply(view: View, id: string, text: string) {
  fireEvent.change(fieldOf(view, id)!, { target: { value: text } });
  const send = card(view, id)!.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  await act(async () => fireEvent.click(send));
}

// Nil's note at sign-off (task d555a32e): an owner answers another member's
// ask as their own, from the Inbox.
describe("another member's ask", () => {
  beforeEach(() => localStorage.clear());

  it("is a full card that names the member: options, the reply field, file as task, Simplify and the command as buttons, as on the owner's own card", async () => {
    const { view, focused } = mount(OWN, seed("owner"));
    choose(view, "data-asks-member", "all");
    const mine = card(view, "mine1")!;
    const theirs = card(view, "pat1")!;
    // Who the ask is for, whatever the words around the name; never on the
    // owner's own card.
    expect(theirs.querySelector("[data-ask-for]")?.textContent).toContain(
      "pat",
    );
    expect(mine.querySelector("[data-ask-for]")).toBeNull();
    expect(theirs.querySelector("[data-ask-prompt]")?.textContent).toContain(
      "Question pat1?",
    );
    for (const sel of [
      "[data-ask-reply-input]",
      'button[type="submit"]',
      "[data-ask-file-task]",
      "[data-ask-simplify]",
      "[data-ask-command] button",
      "[data-ask-about]",
    ])
      expect({
        sel,
        mine: mine.querySelector(sel) !== null,
        theirs: theirs.querySelector(sel) !== null,
      }).toEqual({ sel, mine: true, theirs: true });
    // The options are buttons, the recommended one marked.
    expect(
      [...theirs.querySelectorAll("[data-ask-option]")].map(
        (o) => `${o.tagName}:${o.hasAttribute("data-ask-option-recommended")}`,
      ),
    ).toEqual(["BUTTON:true", "BUTTON:false"]);
    act(() => void fireEvent.click(theirs.querySelector("[data-ask-about]")!));
    expect(focused).toEqual(["a1"]);
    // Simplify asks the agent on the ask's own route.
    await act(async () =>
      fireEvent.click(theirs.querySelector("[data-ask-simplify]")!),
    );
    expect(posts).toEqual(["/api/asks/pat1/simplify"]);
  });

  it("holds a reply for ASK_UNDO_MS, sends it on the ask's route, and the card stays gone in flight and once the POST lands, before any push", async () => {
    jest.useFakeTimers();
    let settle!: () => void;
    answer = () =>
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      });
    const { view, latest } = mount(OWN, seed("owner"));
    choose(view, "data-asks-member", "all");
    await reply(view, "pat1", "Ship it");
    expect(pendingOf(view, "pat1")).toBe("reply");
    await advance(ASK_UNDO_MS - 1);
    expect(posts).toEqual([]);
    await advance(1);
    expect(posts).toEqual(["/api/asks/pat1/reply"]);
    expect(bodies).toEqual([{ text: "Ship it" }]);
    // In flight: the ask is still in the slice, and the page shows nothing
    // of it.
    expect(latest.state.othersAsks.map((e) => e.id)).toContain("pat1");
    expect(card(view, "pat1")).toBeNull();
    // The POST lands; the others_ask_removed push has not come.
    await act(async () => settle());
    await act(async () => {});
    expect(card(view, "pat1")).toBeNull();
    expect(new Set(shownIds(view))).toEqual(new Set(["mine1", "abe1"]));
    await advance(ASK_UNDO_MS * 2);
    expect(posts).toHaveLength(1);
  });

  it("shows the card again with the error and the draft when the answer is refused", async () => {
    jest.useFakeTimers();
    answer = async () => {
      throw new ApiError(409, "ask_busy", "ask_busy");
    };
    const { view } = mount(OWN, seed("owner"));
    choose(view, "data-asks-member", "all");
    await reply(view, "pat1", "go");
    await advance(ASK_UNDO_MS);
    expect(posts).toEqual(["/api/asks/pat1/reply"]);
    expect(pendingOf(view, "pat1")).toBeNull();
    expect(
      card(view, "pat1")!.querySelector("[role=alert]")?.textContent,
    ).toContain("ask_busy");
    expect(fieldOf(view, "pat1")?.value).toBe("go");
  });

  it("waiting for its rewrite, shows the banner with Undo, which withdraws the request on the ask's route", async () => {
    const { view } = mount(OWN, {
      sessionContext: session("owner"),
      othersAsks: [
        other("pat2", "a1", 15, "pat", {
          options: ["Ship", "Wait"],
          simplifyRequestedAt: Date.now(),
        }),
      ],
    });
    choose(view, "data-asks-member", "all");
    const theirs = card(view, "pat2")!;
    expect(theirs.querySelector("[data-ask-for]")?.textContent).toContain(
      "pat",
    );
    expect(theirs.querySelector("[data-ask-simplify-pending]")).not.toBeNull();
    expect(theirs.querySelector("[data-ask-option]")).toBeNull();
    const undo = theirs.querySelector<HTMLButtonElement>(
      "[data-ask-simplify-undo]",
    );
    expect(undo).not.toBeNull();
    await act(async () => fireEvent.click(undo!));
    expect(posts).toEqual(["/api/asks/pat2/simplify/undo"]);
  });
});
