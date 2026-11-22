// "... and automate" on the ask card (task 33891b5b). Under the box, a button
// named after what the card sends ("<Reply|tag> and automate") opens a
// section with a guide, a second box (the agent's automateText while
// untouched) and one send button named like the opener. While it is open the
// opener is gone (task d5e10d03: two buttons with one name) and nothing else
// sends: not the first send button, not a tag, not an option, not Enter in
// the first box. Its button sends the card's answer to the same route with
// `automate` (the second box; "" when blank). The section's × closes it,
// keeps its words and brings the opener back. Focus follows: into the box on
// open (not on a touch screen, where the keyboard would move the card), onto
// the opener on ×. Not offered on asks the agent can never decide alone.
//
// Hooks: [data-ask-automate-open=<kind>] (the bottom row button),
// [data-ask-automate] (the section), [data-ask-automate-close],
// [data-ask-automate-input], [data-ask-automate-send=<kind>]; <kind> is
// reply, dismiss, postpone or rewrite.
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const { NOW, mount, seeded } =
  await import("../test-support/asks-stack-fixture.tsx");
const { ASK_UNDO_MS } = await import("../components/AsksView.tsx");
const inbox = await import("../test-support/asks-view.ts");
const { t } = (await import("../../shared/i18n/translate.ts")).translatorFor(
  "en",
);
type AskEntry = import("../../shared/types.ts").AskEntry;
type View = ReturnType<typeof mount>;

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

type Post = { path: string; text: unknown; automate: unknown };
let posts: Post[] = [];
beforeEach(() => {
  posts = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      const b = (body ?? {}) as { text?: unknown; automate?: unknown };
      posts.push({ path, text: b.text, automate: b.automate });
    }
    return undefined;
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));

const AGENT = "t1";
const ask = (id: string, fields: Partial<AskEntry> = {}): AskEntry => ({
  id,
  agentId: AGENT,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  ...fields,
});

async function stack(...entries: AskEntry[]): Promise<View> {
  const view = mount(false, AGENT);
  await act(async () => {
    for (const entry of entries)
      seeded({ type: "ask_upserted", entry: entry as never });
  });
  await waitFor(() =>
    expect(view.container.querySelector("[data-asks-stack]")).not.toBe(null),
  );
  const collapsed = view.container.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  );
  if (collapsed) await act(async () => void fireEvent.click(collapsed));
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(`[data-ask="${entries[0].id}"]`).length,
    ).toBe(1),
  );
  return view;
}

const card = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
const q = <T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  id: string,
  sel: string,
) => card(root, id).querySelector<T>(sel);
const input = (root: HTMLElement, id: string) =>
  q<HTMLTextAreaElement>(root, id, "[data-ask-reply-input]")!;
const box = (root: HTMLElement, id: string) =>
  q<HTMLTextAreaElement>(root, id, "[data-ask-automate-input]");
const opener = (root: HTMLElement, id: string) =>
  q<HTMLButtonElement>(root, id, "[data-ask-automate-open]");
const section = (root: HTMLElement, id: string) =>
  q(root, id, "[data-ask-automate]");
const automateSend = (root: HTMLElement, id: string) =>
  q<HTMLButtonElement>(root, id, "[data-ask-automate-send]");
const sendButton = (root: HTMLElement, id: string) =>
  q<HTMLButtonElement>(root, id, "[data-ask-send]")!;
const tagButton = (root: HTMLElement, id: string, tag: string) =>
  q<HTMLButtonElement>(root, id, `[data-ask-tag="${tag}"]`)!;
const option = (root: HTMLElement, id: string, label: string) =>
  [
    ...card(root, id).querySelectorAll<HTMLButtonElement>("[data-ask-option]"),
  ].find((b) => b.textContent?.includes(label))!;
// Scalars only: a failed toBe on two DOM nodes serialises both.
const sendMarks = (root: HTMLElement, id: string) =>
  card(root, id).querySelectorAll(
    "[data-ask-tag-sends], [data-ask-option-sends]",
  ).length;
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => void fireEvent.change(el, { target: { value } }));
const enter = (el: HTMLElement) =>
  act(async () => void fireEvent.keyDown(el, { key: "Enter" }));
// The focused element as a scalar: "box", "opener", else its tag.
const focused = () => {
  const el = document.activeElement;
  return el?.hasAttribute("data-ask-automate-input")
    ? "box"
    : el?.hasAttribute("data-ask-automate-open")
      ? "opener"
      : (el?.tagName ?? null);
};

const RULE = "Tab order and copy changes: go with your pick, tell me after.";

it("names the bottom row button after what the card sends, and it follows the tag", async () => {
  const id = "auto0001";
  const view = await stack(ask(id));
  const root = view.container;
  const kind = () => opener(root, id)?.dataset.askAutomateOpen ?? null;
  const label = () => opener(root, id)?.textContent?.trim() ?? null;
  expect([kind(), label()]).toEqual(["reply", t("asks.automateAs.reply")]);
  await click(tagButton(root, id, "dismiss"));
  expect([kind(), label()]).toEqual(["dismiss", t("asks.automateAs.dismiss")]);
  await click(tagButton(root, id, "rewrite"));
  expect([kind(), label()]).toEqual(["rewrite", t("asks.automateAs.rewrite")]);
  await click(tagButton(root, id, "postpone"));
  expect(kind()).toBe("postpone");
  // File as a task is Postpone words (task 9d79a544): still Postpone.
  await click(q<HTMLButtonElement>(root, id, '[data-ask-suggestion="file"]')!);
  expect([kind(), label()]).toEqual([
    "postpone",
    t("asks.automateAs.postpone"),
  ]);
  // The opener sits after the first send button, outside the section.
  expect(
    (sendButton(root, id).compareDocumentPosition(opener(root, id)!) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
      0,
  ).toBe(true);
  expect(section(root, id)).toBe(null);
});

it("is not offered on an app's ask, a messaging draft, a step ask, a secret or sudo request, or while a rewrite is pending", async () => {
  const cases: [string, Partial<AskEntry>][] = [
    ["app", { app: { name: "uptime" } } as Partial<AskEntry>],
    [
      "draft",
      {
        options: ["Send", "Don't send"],
        messaging: { app: "whatsapp", routeId: "r1", text: "On my way" },
      } as Partial<AskEntry>,
    ],
    ["step", { step: { kind: "browser-pairing" } } as Partial<AskEntry>],
    [
      "secret",
      {
        secret: {
          requestId: "req-1",
          scope: "personal",
          name: "GH_TOKEN",
          hosts: ["api.github.com"],
          form: { kind: "authorization" },
          reason: "PR",
        },
      } as Partial<AskEntry>,
    ],
    [
      "sudo",
      {
        sudo: { requestId: "req-2", command: "apt update", cwd: "/w" },
      } as Partial<AskEntry>,
    ],
    ["pending", { simplifyRequestedAt: NOW - 1000 }],
  ];
  const ids = cases.map((_, i) => `auto01${String(i).padStart(2, "0")}`);
  const view = await stack(
    ask("auto0199"),
    ...cases.map(([, fields], i) => ask(ids[i], fields)),
  );
  const root = view.container;
  // The condition: each card is drawn, and a plain one has the button.
  expect(opener(root, "auto0199") !== null).toBe(true);
  expect(
    cases.map(([name], i) => [
      name,
      card(root, ids[i]) !== null,
      opener(root, ids[i]) !== null,
    ]),
  ).toEqual(cases.map(([name]) => [name, true, false]));
});

it("on the Inbox, an ask with no agent has no automate button", async () => {
  const { view } = inbox.mount([
    { ...inbox.ask("noagent", "", 5), agentId: "" },
    inbox.ask("plain", "a1", 4),
  ]);
  const root = view.container;
  expect([
    card(root, "noagent") !== null,
    opener(root, "noagent"),
    opener(root, "plain") !== null,
  ]).toEqual([true, null, true]);
});

it("opens the section with the agent's rule in the box; while it is open nothing else sends: not the send button, a tag, an option or Enter in the first box", async () => {
  const id = "auto0002";
  const view = await stack(
    ask(id, { options: ["Ship now", "Wait"], automateText: RULE }),
  );
  const root = view.container;
  await click(option(root, id, "Ship now"));
  expect(input(root, id).value).toContain("Ship now");
  expect(sendMarks(root, id)).toBeGreaterThan(0);
  expect(sendButton(root, id).disabled).toBe(false);

  await click(opener(root, id)!);
  expect(section(root, id) !== null).toBe(true);
  expect(box(root, id)?.value).toBe(RULE);
  expect(automateSend(root, id)?.dataset.askAutomateSend).toBe("reply");
  expect(sendButton(root, id).disabled).toBe(true);
  expect(sendMarks(root, id)).toBe(0);

  await click(sendButton(root, id));
  await click(option(root, id, "Ship now"));
  await enter(input(root, id));
  await click(tagButton(root, id, "dismiss"));
  await click(tagButton(root, id, "dismiss"));
  expect(posts).toEqual([]);
});

it("sends the answer with the second box as automate, from its button and from Enter in the second box; a blank box sends automate ''", async () => {
  const cases: [string, string, string | undefined][] = [
    ["button", RULE, RULE],
    ["enter", RULE, RULE],
    ["button", "", ""],
  ];
  for (const [i, [how, rule, want]] of cases.entries()) {
    const id = `auto03${String(i).padStart(2, "0")}`;
    posts = [];
    const view = await stack(ask(id));
    const root = view.container;
    await type(input(root, id), "Ship now");
    await click(opener(root, id)!);
    await type(box(root, id)!, rule);
    if (how === "button") await click(automateSend(root, id)!);
    else await enter(box(root, id)!);
    expect({ how, rule, posts }).toEqual({
      how,
      rule,
      posts: [
        { path: `/api/asks/${id}/reply`, text: "Ship now", automate: want },
      ],
    });
    view.unmount();
  }
});

it("Reply and automate needs reply words, as Reply does; a tag does not", async () => {
  const id = "auto0004";
  const view = await stack(ask(id));
  const root = view.container;
  await type(input(root, id), "");
  await click(opener(root, id)!);
  await type(box(root, id)!, RULE);
  expect(automateSend(root, id)!.disabled).toBe(true);
  await enter(box(root, id)!);
  expect(posts).toEqual([]);
  await click(tagButton(root, id, "dismiss"));
  expect(automateSend(root, id)?.dataset.askAutomateSend).toBe("dismiss");
  expect(automateSend(root, id)!.disabled).toBe(false);
});

it("sends each tag to its own route with automate", async () => {
  const cases: [string, string[], string][] = [
    ["dismiss", [], "dismiss"],
    ["postpone", [], "postpone"],
    // File as a task is Postpone words (task 9d79a544).
    ["postpone", ["file"], "postpone"],
    ["rewrite", [], "rewrite"],
  ];
  for (const [i, [tag, picks, route]] of cases.entries()) {
    const id = `auto05${String(i).padStart(2, "0")}`;
    posts = [];
    const view = await stack(ask(id));
    const root = view.container;
    await click(tagButton(root, id, tag));
    for (const pick of picks)
      await click(
        q<HTMLButtonElement>(root, id, `[data-ask-suggestion="${pick}"]`)!,
      );
    // A suggestion's words go as typed; with none, the member's words.
    if (picks.length === 0) await type(input(root, id), "Not now");
    const words = input(root, id).value;
    expect(words.trim()).not.toBe("");
    await click(opener(root, id)!);
    await type(box(root, id)!, RULE);
    await click(automateSend(root, id)!);
    expect({ tag, picks, posts }).toEqual({
      tag,
      picks,
      posts: [
        { path: `/api/asks/${id}/${route}`, text: words, automate: RULE },
      ],
    });
    view.unmount();
  }
});

it("while the section is open the opener is gone and focus is in the box; × closes it, keeps its words and brings the opener back with focus; the send button works again", async () => {
  const id = "auto0007";
  const view = await stack(ask(id));
  const root = view.container;
  await type(input(root, id), "Ship now");
  expect(focused()).not.toBe("box");
  await click(opener(root, id)!);
  // Scalars only: a failed toEqual on a DOM node serialises it.
  expect([
    section(root, id) !== null,
    opener(root, id) !== null,
    focused(),
  ]).toEqual([true, false, "box"]);
  await type(box(root, id)!, RULE);
  await click(q<HTMLButtonElement>(root, id, "[data-ask-automate-close]")!);
  expect([
    section(root, id) !== null,
    opener(root, id) !== null,
    focused(),
  ]).toEqual([false, true, "opener"]);
  expect(sendButton(root, id).disabled).toBe(false);
  await click(opener(root, id)!);
  expect([opener(root, id) !== null, box(root, id)!.value]).toEqual([
    false,
    RULE,
  ]);
  await click(q<HTMLButtonElement>(root, id, "[data-ask-automate-close]")!);
  await click(sendButton(root, id));
  // Closed: a plain reply, no automate.
  expect(posts).toEqual([
    { path: `/api/asks/${id}/reply`, text: "Ship now", automate: undefined },
  ]);
});

it("on a touch screen, opening the section leaves the focus out of the box", async () => {
  const original = window.matchMedia;
  window.matchMedia = (query: string) =>
    query === "(pointer: coarse)"
      ? ({ matches: true, media: query } as MediaQueryList)
      : original.call(window, query);
  try {
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
    const id = "auto0008";
    const view = await stack(ask(id, { automateText: RULE }));
    const root = view.container;
    await click(opener(root, id)!);
    expect([section(root, id) !== null, box(root, id)?.value]).toEqual([
      true,
      RULE,
    ]);
    expect(focused()).not.toBe("box");
    view.unmount();
  } finally {
    window.matchMedia = original;
  }
});

it("on the Inbox, holds Dismiss and automate on its line; Undo brings the card back with the section open and its words; the held send carries automate", async () => {
  jest.useFakeTimers();
  const { view } = inbox.mount([inbox.ask("held", "a1", 5)]);
  const root = view.container;
  const id = "held";
  await click(tagButton(root, id, "dismiss"));
  await type(input(root, id), "");
  await click(opener(root, id)!);
  await type(box(root, id)!, RULE);
  await click(automateSend(root, id)!);
  expect(posts).toEqual([]);
  const undo = root.querySelector<HTMLElement>("[data-ask-undo]");
  expect(undo !== null).toBe(true);
  await click(undo!);
  await waitFor(() => expect(section(root, id) !== null).toBe(true));
  expect(box(root, id)!.value).toBe(RULE);
  await click(automateSend(root, id)!);
  await act(async () => {
    jest.advanceTimersByTime(ASK_UNDO_MS);
  });
  await act(async () => {});
  expect(posts).toEqual([
    { path: `/api/asks/${id}/dismiss`, text: undefined, automate: RULE },
  ]);
});

it("hides an open section when a rewrite becomes pending", async () => {
  const id = "auto0008";
  const view = await stack(ask(id));
  const root = view.container;
  await click(opener(root, id)!);
  await type(box(root, id)!, RULE);
  expect(section(root, id) !== null).toBe(true);
  // The rewrite was asked from another tab: the pushed ask is pending.
  await act(async () => {
    seeded({
      type: "ask_upserted",
      entry: ask(id, { simplifyRequestedAt: NOW, updatedAt: NOW }) as never,
    });
  });
  expect(card(root, id) !== null).toBe(true);
  expect(
    card(root, id).querySelectorAll(
      "[data-ask-automate], [data-ask-automate-send]",
    ).length,
  ).toBe(0);
});
