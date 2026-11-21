// The ask card's tags (task 1466ea8b): Dismiss, Postpone and Rewrite under
// the agent's options. A tag is a chip at the start of the reply box; the
// send button takes its name and its button sends; at most one; an option
// takes it off. Suggestions sit above the box for Postpone and Rewrite. Each
// tag sends the box to its own route as typed. The agent can recommend one.
// The stack sends at once; the Inbox holds every answer but a rewrite.
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
type AskEntry = import("../../shared/types.ts").AskEntry;
type View = ReturnType<typeof mount>;

// No socket: the store's provider would open one.
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

let posts: { path: string; text: unknown }[] = [];
beforeEach(() => {
  posts = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST")
      posts.push({
        path,
        text: (body as { text?: unknown } | undefined)?.text,
      });
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

// The stack of agent t1 with these asks, opened.
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
const input = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLTextAreaElement>("[data-ask-reply-input]")!;
const tagButton = (root: HTMLElement, id: string, tag: string) =>
  card(root, id).querySelector<HTMLButtonElement>(`[data-ask-tag="${tag}"]`)!;
// Scalars only: a failed toBe on two DOM nodes serialises both.
const tags = (root: HTMLElement, id: string) =>
  [...card(root, id).querySelectorAll<HTMLElement>("[data-ask-tag]")].map(
    (b) => b.dataset.askTag,
  );
const chip = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLElement>("[data-ask-tag-chip]")?.dataset
    .askTagChip ?? null;
const sendButton = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLButtonElement>("[data-ask-send]")!;
const sends = (root: HTMLElement, id: string) =>
  sendButton(root, id)?.dataset.askSend ?? null;
// The tag buttons marked as the one a tap sends.
const tagSends = (root: HTMLElement, id: string) =>
  [...card(root, id).querySelectorAll<HTMLElement>("[data-ask-tag-sends]")].map(
    (b) => b.dataset.askTag,
  );
const suggestions = (root: HTMLElement, id: string) =>
  [
    ...card(root, id).querySelectorAll<HTMLElement>("[data-ask-suggestion]"),
  ].map((b) => b.dataset.askSuggestion);
const suggestion = (root: HTMLElement, id: string, name: string) =>
  card(root, id).querySelector<HTMLButtonElement>(
    `[data-ask-suggestion="${name}"]`,
  )!;
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));
const type = (root: HTMLElement, id: string, value: string) =>
  act(async () => {
    fireEvent.change(input(root, id), { target: { value } });
  });
const precedes = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

it("draws Dismiss, Postpone and Rewrite in a row after the agent's options, and no Dismiss, file or Simplify buttons under the box; Reply is off while the box is empty", async () => {
  const view = await stack(ask("tttt1001", { options: ["Yes", "No"] }));
  const root = view.container;
  expect(tags(root, "tttt1001")).toEqual(["dismiss", "postpone", "rewrite"]);
  const options = card(root, "tttt1001").querySelector("[data-ask-options]")!;
  // Their own row, after the options and before the box.
  expect(options.contains(tagButton(root, "tttt1001", "dismiss"))).toBe(false);
  expect(precedes(options, tagButton(root, "tttt1001", "dismiss"))).toBe(true);
  expect(
    precedes(tagButton(root, "tttt1001", "rewrite"), input(root, "tttt1001")),
  ).toBe(true);
  expect(
    card(root, "tttt1001").querySelectorAll(
      "[data-ask-dismiss], [data-ask-file-task], [data-ask-simplify]",
    ).length,
  ).toBe(0);
  expect([chip(root, "tttt1001"), sends(root, "tttt1001")]).toEqual([
    null,
    "reply",
  ]);
  expect(input(root, "tttt1001").value).toBe("");
  expect(sendButton(root, "tttt1001").disabled).toBe(true);
  expect(tagSends(root, "tttt1001")).toEqual([]);
});

it("puts a tag on the box as a chip that names the send button and makes its button the one that sends; one tag at a time; an option takes it off", async () => {
  const view = await stack(
    ask("tttt1002"),
    ask("tttt1003", { options: ["Yes", "No"] }),
  );
  const root = view.container;
  // The untouched default of an ask with no options.
  expect(input(root, "tttt1002").value).not.toBe("");

  await click(tagButton(root, "tttt1002", "dismiss"));
  expect(posts).toEqual([]);
  // The tag replaces the untouched default.
  expect([
    chip(root, "tttt1002"),
    sends(root, "tttt1002"),
    tagSends(root, "tttt1002"),
    input(root, "tttt1002").value,
  ]).toEqual(["dismiss", "dismiss", ["dismiss"], ""]);
  // A tagged send with an empty box is on.
  expect(sendButton(root, "tttt1002").disabled).toBe(false);

  // Another tag replaces it and keeps the typed words.
  await type(root, "tttt1002", "The new rule covers it");
  await click(tagButton(root, "tttt1002", "postpone"));
  expect([
    chip(root, "tttt1002"),
    sends(root, "tttt1002"),
    tagSends(root, "tttt1002"),
    input(root, "tttt1002").value,
  ]).toEqual(["postpone", "postpone", ["postpone"], "The new rule covers it"]);
  expect(
    card(root, "tttt1002").querySelectorAll("[data-ask-tag-chip]").length,
  ).toBe(1);
  // The chip sits at the start of the box.
  expect(
    precedes(
      card(root, "tttt1002").querySelector("[data-ask-tag-chip]")!,
      input(root, "tttt1002"),
    ),
  ).toBe(true);

  // An option takes the tag off: the box holds the option, and Reply sends.
  await click(tagButton(root, "tttt1003", "rewrite"));
  expect(chip(root, "tttt1003")).toBe("rewrite");
  await click(
    card(root, "tttt1003").querySelectorAll<HTMLElement>(
      "[data-ask-option]",
    )[0],
  );
  expect(posts).toEqual([]);
  expect([
    chip(root, "tttt1003"),
    sends(root, "tttt1003"),
    tagSends(root, "tttt1003"),
    input(root, "tttt1003").value,
  ]).toEqual([null, "reply", [], "Yes"]);
});

it("takes the tag off with its × or with Backspace at the box start; Backspace over selected words or past the start keeps it", async () => {
  const view = await stack(ask("tttt1004"));
  const root = view.container;
  const id = "tttt1004";
  await click(tagButton(root, id, "rewrite"));
  await click(
    card(root, id).querySelector<HTMLElement>("[data-ask-tag-chip-remove]")!,
  );
  expect([chip(root, id), sends(root, id)]).toEqual([null, "reply"]);

  await click(tagButton(root, id, "dismiss"));
  await type(root, id, "abc");
  const el = input(root, id);
  const backspace = (from: number, to: number) =>
    act(async () => {
      el.focus();
      el.setSelectionRange(from, to);
      fireEvent.keyDown(el, { key: "Backspace" });
    });
  // Words selected from the start: Backspace deletes them, not the tag.
  await backspace(0, 3);
  expect(chip(root, id)).toBe("dismiss");
  // The caret past the start.
  await backspace(1, 1);
  expect(chip(root, id)).toBe("dismiss");
  // At the start: the tag goes, the words stay.
  await backspace(0, 0);
  expect([chip(root, id), sends(root, id), el.value]).toEqual([
    null,
    "reply",
    "abc",
  ]);
  expect(posts).toEqual([]);
});

it("sends each tag to its route with the box as typed, and with no words when the box is blank", async () => {
  const cases: [string, string[], string][] = [
    ["dismiss", [], "dismiss"],
    ["postpone", [], "postpone"],
    ["rewrite", [], "rewrite"],
    // Postpone with its File as a task suggestion files the ask.
    ["postpone", ["file"], "file-task"],
  ];
  let n = 0;
  for (const [tag, picks, route] of cases)
    for (const words of ["Not this quarter", ""]) {
      const id = `tttt20${String(n++).padStart(2, "0")}`;
      posts = [];
      const view = await stack(ask(id));
      const root = view.container;
      await click(tagButton(root, id, tag));
      for (const pick of picks) await click(suggestion(root, id, pick));
      await type(root, id, words);
      await click(sendButton(root, id));
      expect({ tag, picks, words, posts }).toEqual({
        tag,
        picks,
        words,
        posts: [
          {
            path: `/api/asks/${id}/${route}`,
            text: words === "" ? undefined : words,
          },
        ],
      });
      view.unmount();
    }
});

it("sends a note that matches the old default: no 'changed from the prefill' rule is left", async () => {
  const view = await stack(ask("tttt1005"));
  const root = view.container;
  const id = "tttt1005";
  const defaultText = input(root, id).value;
  expect(defaultText).not.toBe("");
  await click(tagButton(root, id, "dismiss"));
  await type(root, id, defaultText);
  await click(sendButton(root, id));
  expect(posts).toEqual([
    { path: `/api/asks/${id}/dismiss`, text: defaultText },
  ]);
});

it("sends the tagged answer from the tag's own button and from Enter", async () => {
  const view = await stack(ask("tttt1006"), ask("tttt1007"));
  const root = view.container;
  // A second tap on the tag that sends.
  await click(tagButton(root, "tttt1006", "postpone"));
  await type(root, "tttt1006", "Circle back at: Friday");
  expect(posts).toEqual([]);
  await click(tagButton(root, "tttt1006", "postpone"));
  expect(posts).toEqual([
    { path: "/api/asks/tttt1006/postpone", text: "Circle back at: Friday" },
  ]);
  posts = [];
  await click(tagButton(root, "tttt1007", "rewrite"));
  await type(root, "tttt1007", "More context");
  await act(async () => {
    fireEvent.keyDown(input(root, "tttt1007"), { key: "Enter" });
  });
  expect(posts).toEqual([
    { path: "/api/asks/tttt1007/rewrite", text: "More context" },
  ]);
});

it("shows suggestions above the box only for Postpone and Rewrite: a word suggestion fills an empty box or follows the typed words, and File as a task toggles onto the Postpone tag", async () => {
  const view = await stack(ask("tttt1008"));
  const root = view.container;
  const id = "tttt1008";
  const hints = () =>
    card(root, id).querySelectorAll("[data-ask-rewrite-hint]").length;
  expect([suggestions(root, id), hints()]).toEqual([[], 0]);
  await click(tagButton(root, id, "dismiss"));
  expect([suggestions(root, id), hints()]).toEqual([[], 0]);

  await click(tagButton(root, id, "postpone"));
  expect([suggestions(root, id), hints()]).toEqual([
    ["file", "circle-back"],
    0,
  ]);
  for (const name of ["file", "circle-back"])
    expect(precedes(suggestion(root, id, name), input(root, id))).toBe(true);
  await click(suggestion(root, id, "file"));
  expect([chip(root, id), sends(root, id)]).toEqual(["file", "file"]);
  await click(suggestion(root, id, "file"));
  expect([chip(root, id), sends(root, id)]).toEqual(["postpone", "postpone"]);
  await click(suggestion(root, id, "circle-back"));
  const circle = input(root, id).value;
  expect(circle).not.toBe("");
  expect(chip(root, id)).toBe("postpone");

  await type(root, id, "");
  await click(tagButton(root, id, "rewrite"));
  expect([suggestions(root, id), hints()]).toEqual([
    ["simplify", "context", "visuals", "answer"],
    1,
  ]);
  for (const name of ["simplify", "context", "visuals", "answer"])
    expect(precedes(suggestion(root, id, name), input(root, id))).toBe(true);
  await click(suggestion(root, id, "context"));
  const context = input(root, id).value;
  expect(context).not.toBe("");
  // After typed words: a space, then the suggestion's words.
  await type(root, id, "Please");
  await click(suggestion(root, id, "visuals"));
  const after = input(root, id).value;
  expect(after.startsWith("Please ")).toBe(true);
  expect(after.length).toBeGreaterThan("Please ".length);
  expect(after).not.toContain(context);
  expect(posts).toEqual([]);
});

it("starts an untouched card with the agent's recommended tag and its words, starred; Enter sends it; a tag this UI does not know is ignored", async () => {
  const view = await stack(
    ask("tttt1009", {
      recommendedTag: "postpone",
      recommendedText: "Circle back at: Monday",
    }),
    ask("tttt1010", { recommendedTag: "automate", recommendedText: "x" }),
  );
  const root = view.container;
  const marked = (id: string) =>
    [
      ...card(root, id).querySelectorAll<HTMLElement>(
        "[data-ask-tag-recommended]",
      ),
    ].map((b) => b.dataset.askTag);
  expect([
    chip(root, "tttt1009"),
    sends(root, "tttt1009"),
    input(root, "tttt1009").value,
    marked("tttt1009"),
  ]).toEqual(["postpone", "postpone", "Circle back at: Monday", ["postpone"]]);
  expect([
    tags(root, "tttt1010"),
    chip(root, "tttt1010"),
    sends(root, "tttt1010"),
    marked("tttt1010"),
  ]).toEqual([["dismiss", "postpone", "rewrite"], null, "reply", []]);

  await act(async () => {
    fireEvent.keyDown(input(root, "tttt1009"), { key: "Enter" });
  });
  expect(posts).toEqual([
    { path: "/api/asks/tttt1009/postpone", text: "Circle back at: Monday" },
  ]);
});

it("keeps the recommended tag off once the member took it off", async () => {
  const view = await stack(
    ask("tttt1011", { recommendedTag: "dismiss", recommendedText: "Done" }),
  );
  const root = view.container;
  await click(
    card(root, "tttt1011").querySelector<HTMLElement>(
      "[data-ask-tag-chip-remove]",
    )!,
  );
  expect([chip(root, "tttt1011"), sends(root, "tttt1011")]).toEqual([
    null,
    "reply",
  ]);
  // A later push of the ask (an edit of another field) does not bring it back.
  await act(async () => {
    seeded({
      type: "ask_upserted",
      entry: ask("tttt1011", {
        recommendedTag: "dismiss",
        recommendedText: "Done",
        priority: "P1",
      }) as never,
    });
  });
  expect(chip(root, "tttt1011")).toBe(null);
});

// The Inbox: a postpone waits out the Undo time like the other answers, a
// rewrite goes at once and the ask stays.
it("on the Inbox, holds a postpone on a postpone line and sends a rewrite at once", async () => {
  jest.useFakeTimers();
  const { view } = inbox.mount([
    inbox.ask("held", "a1", 5),
    inbox.ask("rw", "a1", 4),
  ]);
  const root = view.container;
  await click(tagButton(root, "held", "postpone"));
  await type(root, "held", "Circle back at: 9am");
  await click(sendButton(root, "held"));
  const line = root.querySelector<HTMLElement>(
    '[data-ask="held"][data-ask-pending], [data-ask="held"] [data-ask-pending]',
  );
  expect(line?.dataset.askPending).toBe("postpone");
  expect(posts).toEqual([]);

  await click(tagButton(root, "rw", "rewrite"));
  await type(root, "rw", "More context");
  await click(sendButton(root, "rw"));
  expect(posts).toEqual([
    { path: "/api/asks/rw/rewrite", text: "More context" },
  ]);
  // Sent: the tag and the words are reset, and the ask is still there.
  expect([chip(root, "rw"), card(root, "rw") !== null]).toEqual([null, true]);

  await act(async () => {
    jest.advanceTimersByTime(ASK_UNDO_MS);
  });
  await act(async () => {});
  expect(posts).toEqual([
    { path: "/api/asks/rw/rewrite", text: "More context" },
    { path: "/api/asks/held/postpone", text: "Circle back at: 9am" },
  ]);
});

it("on the Inbox, an ask with no agent has only its Dismiss button, and a reply draft to a messaging contact has only the Dismiss tag", async () => {
  const { view } = inbox.mount([
    { ...inbox.ask("noagent", "", 5), agentId: "" },
    {
      ...inbox.ask("draft", "a1", 4),
      options: ["Send", "Don't send"],
      messaging: { app: "whatsapp", routeId: "r1", text: "On my way" },
    } as AskEntry,
  ]);
  const root = view.container;
  expect([
    tags(root, "noagent"),
    card(root, "noagent").querySelectorAll("[data-ask-dismiss]").length,
  ]).toEqual([[], 1]);
  expect(tags(root, "draft")).toEqual(["dismiss"]);
});
