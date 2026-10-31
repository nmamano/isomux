// The Asks page's member select for an office owner (task a49856f7): whose
// open asks the page lists, and the read-only card of another member's ask.
// The choice's storage has its own owner ("asks member" in
// ui/device-settings.test.ts) and the slice its own ("reducer: other
// members' asks" in ui/store.test.ts). A separate file because each DOM file
// has a wall-time budget.
import { describe, it, expect, beforeEach } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { ask, mount, control, choose, pageOrder } =
  await import("../test-support/asks-view.ts");

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

// Nil's own ask carries a command too, so the own card shows what a
// read-only card must not.
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
    // The select is first in the filter row, before the sort.
    const selects = [...view.container.querySelectorAll("select")];
    const member = control(view, "data-asks-member");
    expect(member).not.toBeNull();
    expect(selects.indexOf(member)).toBeLessThan(
      selects.indexOf(control(view, "data-asks-sort")),
    );
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

describe("another member's ask", () => {
  beforeEach(() => localStorage.clear());

  it("is read-only: the prompt, the member, the options and the command as text, with Discuss in chat and the id, and no answer control", () => {
    const { view, focused } = mount(OWN, seed("owner"));
    choose(view, "data-asks-member", "all");
    const mine = card(view, "mine1")!;
    const theirs = card(view, "pat1")!;
    // Enabling: Nil's own card keeps every control, and its command is a
    // button that sends it to the terminal.
    expect(mine.querySelector("[data-ask-reply-input]")).not.toBeNull();
    expect(mine.querySelector("[data-ask-command] button")).not.toBeNull();
    expect(mine.querySelector("[data-ask-for]")).toBeNull();

    expect(theirs.querySelector("[data-ask-prompt]")?.textContent).toContain(
      "Question pat1?",
    );
    // Who the ask is for, whatever the words around the name.
    expect(theirs.querySelector("[data-ask-for]")?.textContent).toContain(
      "pat",
    );
    for (const sel of [
      "[data-ask-reply-input]",
      "[data-ask-file-task]",
      "[data-ask-simplify]",
      "[data-ask-undo]",
      "textarea",
      "input",
    ])
      expect({ sel, found: theirs.querySelector(sel) !== null }).toEqual({
        sel,
        found: false,
      });
    // The options are listed, the recommended one marked, and none can be
    // tapped.
    const options = [...theirs.querySelectorAll("[data-ask-option]")];
    expect(
      options.map((o) => o.textContent?.includes("Ship") ?? false),
    ).toEqual([true, false]);
    expect(
      theirs.querySelectorAll("[data-ask-option-recommended]"),
    ).toHaveLength(1);
    // The command is text: no button sends it to Nil's terminal.
    const command = theirs.querySelector("[data-ask-command]");
    expect(command?.textContent).toContain("git push");
    expect(command?.querySelector("button")).toBeNull();
    // Every button left is Discuss in chat, a link or the id chip: no Reply
    // and no Dismiss, whatever their words.
    const buttons = [
      ...theirs.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((b) => !b.disabled);
    expect(
      buttons
        .filter(
          (b) =>
            !b.closest(
              "[data-ask-about], [data-ask-office-link], [data-ask-id]",
            ),
        )
        .map((b) => b.outerHTML),
    ).toEqual([]);
    const about = theirs.querySelector<HTMLButtonElement>("[data-ask-about]");
    expect(about).not.toBeNull();
    act(() => void fireEvent.click(about!));
    expect(focused).toEqual(["a1"]);
  });
});
