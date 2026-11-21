// The ask card's tags (task 1466ea8b): Dismiss, Postpone and Rewrite under
// the agent's options. A tag is a chip at the start of the reply box; the
// send button takes its name and its button sends; at most one; an option
// takes it off. Suggestions sit above the box for Postpone and Rewrite. Each
// tag sends the box to its own route as typed. The agent can recommend one.
// The stack sends at once; the Inbox holds every answer but a rewrite.
// Task 9d79a544: a tag or suggestion tap replaces the box's words (no
// append), with an Undo line when it erased the member's own words; "File
// as a task" is plain Postpone words; each tag button carries the option's
// mark.
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
// What a suggestion puts in the box: its words, and a space after a label
// that ends with a colon (it asks for words after it).
const wordsOf = (root: HTMLElement, id: string, name: string) => {
  const words = suggestion(root, id, name).textContent!.trim();
  return words.endsWith(":") ? `${words} ` : words;
};
// The "text replaced" line under the box, and its Undo.
const replacedLines = (root: HTMLElement, id: string) =>
  card(root, id).querySelectorAll("[data-ask-replaced]").length;
const replacedUndo = (root: HTMLElement, id: string) =>
  card(root, id).querySelector<HTMLButtonElement>(
    "[data-ask-replaced] [data-ask-replaced-undo]",
  )!;
// The box, its chip and the line, as scalars.
const state = (root: HTMLElement, id: string) => ({
  value: input(root, id).value,
  chip: chip(root, id),
  line: replacedLines(root, id),
});

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

  // Another tag replaces it, and the typed words go too (task 9d79a544).
  await type(root, "tttt1002", "The new rule covers it");
  await click(tagButton(root, "tttt1002", "postpone"));
  expect([
    chip(root, "tttt1002"),
    sends(root, "tttt1002"),
    tagSends(root, "tttt1002"),
    input(root, "tttt1002").value,
  ]).toEqual(["postpone", "postpone", ["postpone"], ""]);
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

it("shows suggestions above the box only for Postpone and Rewrite; a suggestion's words replace the box's words and keep the tag", async () => {
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
  // File as a task is words like the others: the tag stays Postpone.
  await click(suggestion(root, id, "file"));
  expect([chip(root, id), sends(root, id), input(root, id).value]).toEqual([
    "postpone",
    "postpone",
    wordsOf(root, id, "file"),
  ]);
  // The next suggestion replaces those words; it does not follow them.
  await click(suggestion(root, id, "circle-back"));
  expect([chip(root, id), input(root, id).value]).toEqual([
    "postpone",
    wordsOf(root, id, "circle-back"),
  ]);

  await type(root, id, "");
  await click(tagButton(root, id, "rewrite"));
  expect([suggestions(root, id), hints()]).toEqual([
    ["simplify", "context", "visuals", "answer"],
    1,
  ]);
  for (const name of ["simplify", "context", "visuals", "answer"])
    expect(precedes(suggestion(root, id, name), input(root, id))).toBe(true);
  await click(suggestion(root, id, "context"));
  expect(input(root, id).value).toBe(wordsOf(root, id, "context"));
  // Over typed words: the box holds only the suggestion's words.
  await type(root, id, "Please");
  await click(suggestion(root, id, "visuals"));
  expect([chip(root, id), input(root, id).value]).toEqual([
    "rewrite",
    wordsOf(root, id, "visuals"),
  ]);
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

// Task 39d79a4e: an edit of the ask moves the star. The button that lost it
// is re-rendered, not mounted again, and must get the padding of a button
// that never had it (a removed paddingLeft next to an unchanged padding
// clears the left padding).
it("gives the option and the tag that lose the star after an edit the padding of one that never had it", async () => {
  const options = ["design", "hold", "obsolete"];
  const view = await stack(ask("tttt1012", { options, recommended: "hold" }));
  const root = view.container;
  const option = (name: string) =>
    [
      ...card(root, "tttt1012").querySelectorAll<HTMLElement>(
        "[data-ask-option]",
      ),
    ].find((b) => b.textContent!.includes(name))!;
  // Scalars only: the four sides as the inline style sets them.
  const pad = (el: HTMLElement) =>
    [
      el.style.paddingTop,
      el.style.paddingRight,
      el.style.paddingBottom,
      el.style.paddingLeft,
    ].join(" ");
  const starred = (attr: string) =>
    [...card(root, "tttt1012").querySelectorAll<HTMLElement>(`[${attr}]`)].map(
      (b) => b.dataset.askTag ?? b.textContent!.trim(),
    );
  const edit = (fields: Partial<AskEntry>) =>
    act(async () => {
      seeded({
        type: "ask_upserted",
        entry: ask("tttt1012", { options, ...fields }) as never,
      });
    });

  // Before: the starred option is tight on the left, the others are not.
  const plain = pad(option("design"));
  expect(pad(option("hold"))).not.toBe(plain);
  option("hold").dataset.probe = "same-node";
  tagButton(root, "tttt1012", "dismiss").dataset.probe = "same-node";

  await edit({ recommended: "obsolete" });
  expect(starred("data-ask-option-recommended")).toEqual([
    expect.stringContaining("obsolete"),
  ]);
  // The same button, re-rendered: a fresh mount draws it right anyway.
  expect(option("hold").dataset.probe).toBe("same-node");
  expect({
    hold: pad(option("hold")),
    design: pad(option("design")),
    obsoleteTight: pad(option("obsolete")) !== plain,
  }).toEqual({ hold: plain, design: plain, obsoleteTight: true });

  // The same for the tags: the agent moves its recommended tag.
  await edit({ recommended: "obsolete", recommendedTag: "dismiss" });
  const tagPlain = pad(tagButton(root, "tttt1012", "rewrite"));
  expect(pad(tagButton(root, "tttt1012", "dismiss"))).not.toBe(tagPlain);
  await edit({ recommended: "obsolete", recommendedTag: "postpone" });
  expect(starred("data-ask-tag-recommended")).toEqual(["postpone"]);
  expect(tagButton(root, "tttt1012", "dismiss").dataset.probe).toBe(
    "same-node",
  );
  expect({
    dismiss: pad(tagButton(root, "tttt1012", "dismiss")),
    rewrite: pad(tagButton(root, "tttt1012", "rewrite")),
    postponeTight: pad(tagButton(root, "tttt1012", "postpone")) !== tagPlain,
  }).toEqual({ dismiss: tagPlain, rewrite: tagPlain, postponeTight: true });
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

// Task 9d79a544: a tap that erases the member's own words shows a line with
// Undo, which brings back the words and the tag from before the tap.
const focusedField = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.hasAttribute("data-ask-reply-input")
    ? el.closest<HTMLElement>("[data-ask]")!.dataset.ask!
    : null;
};

it("a tag tap over typed words empties the box with an Undo line; Undo brings back the words and the tag before the tap, and focuses the box", async () => {
  const view = await stack(ask("tttt3001"), ask("tttt3002"));
  const root = view.container;

  // No tag before the tap.
  await type(root, "tttt3001", "My own words");
  expect(state(root, "tttt3001")).toEqual({
    value: "My own words",
    chip: null,
    line: 0,
  });
  await click(tagButton(root, "tttt3001", "dismiss"));
  expect(state(root, "tttt3001")).toEqual({
    value: "",
    chip: "dismiss",
    line: 1,
  });
  await act(async () => input(root, "tttt3001").blur());
  expect(focusedField()).toBe(null);
  await click(replacedUndo(root, "tttt3001"));
  expect(state(root, "tttt3001")).toEqual({
    value: "My own words",
    chip: null,
    line: 0,
  });
  expect(focusedField()).toBe("tttt3001");
  expect(sends(root, "tttt3001")).toBe("reply");

  // Another tag before the tap: Undo puts that tag back.
  await click(tagButton(root, "tttt3002", "postpone"));
  await type(root, "tttt3002", "Monday works");
  await click(tagButton(root, "tttt3002", "rewrite"));
  expect(state(root, "tttt3002")).toEqual({
    value: "",
    chip: "rewrite",
    line: 1,
  });
  await click(replacedUndo(root, "tttt3002"));
  expect(state(root, "tttt3002")).toEqual({
    value: "Monday works",
    chip: "postpone",
    line: 0,
  });
  expect(posts).toEqual([]);
});

it("a suggestion tap over typed words shows the Undo line too, and Undo brings back the typed words with the tag", async () => {
  const view = await stack(ask("tttt3003"));
  const root = view.container;
  const id = "tttt3003";
  await click(tagButton(root, id, "rewrite"));
  await type(root, id, "Please");
  await click(suggestion(root, id, "context"));
  expect(state(root, id)).toEqual({
    value: wordsOf(root, id, "context"),
    chip: "rewrite",
    line: 1,
  });
  await click(replacedUndo(root, id));
  expect(state(root, id)).toEqual({
    value: "Please",
    chip: "rewrite",
    line: 0,
  });
  expect(posts).toEqual([]);
});

it("keeps the Undo line through a tag tap then a suggestion tap, and Undo brings back the words from before the first tap", async () => {
  const view = await stack(ask("tttt3004"));
  const root = view.container;
  const id = "tttt3004";
  await type(root, id, "My long note");
  await click(tagButton(root, id, "postpone"));
  expect(state(root, id)).toEqual({ value: "", chip: "postpone", line: 1 });
  await click(suggestion(root, id, "circle-back"));
  expect(state(root, id)).toEqual({
    value: wordsOf(root, id, "circle-back"),
    chip: "postpone",
    line: 1,
  });
  // A second tag tap in the chain keeps it too.
  await click(tagButton(root, id, "rewrite"));
  expect(state(root, id)).toEqual({ value: "", chip: "rewrite", line: 1 });
  await click(replacedUndo(root, id));
  expect(state(root, id)).toEqual({
    value: "My long note",
    chip: null,
    line: 0,
  });
  expect(posts).toEqual([]);
});

it("shows no Undo line when the tap erases only the untouched default, the agent's recommended words or a blank box", async () => {
  const view = await stack(
    ask("tttt3005"),
    ask("tttt3006", {
      recommendedTag: "postpone",
      recommendedText: "Circle back at: Monday",
    }),
    ask("tttt3007", {
      recommendedTag: "postpone",
      recommendedText: "Circle back at: Monday",
    }),
  );
  const root = view.container;
  // The untouched default of an ask with no options.
  expect(input(root, "tttt3005").value).not.toBe("");
  await click(tagButton(root, "tttt3005", "dismiss"));
  expect(state(root, "tttt3005")).toEqual({
    value: "",
    chip: "dismiss",
    line: 0,
  });
  // Blank box with a tag: a suggestion erases nothing.
  await click(tagButton(root, "tttt3005", "postpone"));
  await click(suggestion(root, "tttt3005", "file"));
  expect(state(root, "tttt3005")).toEqual({
    value: wordsOf(root, "tttt3005", "file"),
    chip: "postpone",
    line: 0,
  });
  // The agent's words: a suggestion tap and a tag tap.
  await click(suggestion(root, "tttt3006", "file"));
  expect(state(root, "tttt3006")).toEqual({
    value: wordsOf(root, "tttt3006", "file"),
    chip: "postpone",
    line: 0,
  });
  await click(tagButton(root, "tttt3007", "dismiss"));
  expect(state(root, "tttt3007")).toEqual({
    value: "",
    chip: "dismiss",
    line: 0,
  });
  expect(posts).toEqual([]);
});

it("takes the Undo line away when the box changes another way: typing, an option, or the tag's ×", async () => {
  const view = await stack(
    ask("tttt3008"),
    ask("tttt3009", { options: ["Yes", "No"] }),
    ask("tttt3010"),
  );
  const root = view.container;
  const replace = async (id: string) => {
    await type(root, id, "Words of mine");
    await click(tagButton(root, id, "dismiss"));
    expect([id, replacedLines(root, id)]).toEqual([id, 1]);
  };
  await replace("tttt3008");
  await type(root, "tttt3008", "x");
  expect(state(root, "tttt3008")).toEqual({
    value: "x",
    chip: "dismiss",
    line: 0,
  });
  // Typed back to what the tap left: the line stays gone.
  await type(root, "tttt3008", "");
  expect(state(root, "tttt3008")).toEqual({
    value: "",
    chip: "dismiss",
    line: 0,
  });

  await replace("tttt3009");
  await click(
    card(root, "tttt3009").querySelectorAll<HTMLElement>(
      "[data-ask-option]",
    )[1],
  );
  expect(state(root, "tttt3009")).toEqual({ value: "No", chip: null, line: 0 });

  await replace("tttt3010");
  await click(
    card(root, "tttt3010").querySelector<HTMLElement>(
      "[data-ask-tag-chip-remove]",
    )!,
  );
  expect(state(root, "tttt3010")).toEqual({ value: "", chip: null, line: 0 });
  expect(posts).toEqual([]);
});

it("files as a task with Postpone and the suggestion's words: the agent gets a postpone with them, never a file-task", async () => {
  const view = await stack(ask("tttt3011"));
  const root = view.container;
  const id = "tttt3011";
  await click(tagButton(root, id, "postpone"));
  await click(suggestion(root, id, "file"));
  const words = wordsOf(root, id, "file");
  expect(words).not.toBe("");
  expect([chip(root, id), sends(root, id), input(root, id).value]).toEqual([
    "postpone",
    "postpone",
    words,
  ]);
  await click(sendButton(root, id));
  expect(posts).toEqual([{ path: `/api/asks/${id}/postpone`, text: words }]);
});

it("draws each tag button with the agent options' mark: the pencil when it does not send, the arrow when it does, always shown", async () => {
  const view = await stack(ask("tttt3012", { options: ["Yes", "No"] }));
  const root = view.container;
  const id = "tttt3012";
  const options = () => [
    ...card(root, id).querySelectorAll<HTMLElement>("[data-ask-option]"),
  ];
  // The drawn mark of a button: its svg, with no hidden box around it.
  const mark = (b: HTMLElement) => {
    const svg = b.querySelector("svg");
    if (!svg) return "none";
    for (let el: Element | null = svg; el && el !== b; el = el.parentElement)
      if ((el as HTMLElement).style?.visibility === "hidden") return "hidden";
    return svg.outerHTML;
  };
  const pencil = mark(options()[0]);
  // Option Yes in the box: its button sends.
  await click(options()[0]);
  const arrow = mark(options()[0]);
  expect(pencil).not.toBe(arrow);
  expect([pencil.startsWith("<svg"), arrow.startsWith("<svg")]).toEqual([
    true,
    true,
  ]);
  await click(tagButton(root, id, "dismiss"));
  const marks = () =>
    ["dismiss", "postpone", "rewrite"].map((tag) => {
      const m = mark(tagButton(root, id, tag));
      return m === pencil ? "pencil" : m === arrow ? "arrow" : m;
    });
  expect(marks()).toEqual(["arrow", "pencil", "pencil"]);
  await click(
    card(root, id).querySelector<HTMLElement>("[data-ask-tag-chip-remove]")!,
  );
  expect(marks()).toEqual(["pencil", "pencil", "pencil"]);
});
