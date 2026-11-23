// The rule stage of "... and automate" on the ask card (task 1b4dfa91). After
// the member's answer with automate, the ask stays open: the card hides the
// answer controls (options, reply box, tags, the automate opener), shows
// what was sent, and then either a banner while the agent writes the rule or
// the rule itself (the action block, with Apply), a Change box and Don't
// save. Change posts the words to the rewrite route; Don't save posts a
// dismiss. The card that sent the answer stays, at its rule stage, whatever
// comes first: the server's push or the answer's response, in the chat's
// stack and on the Inbox after its Undo time. A "Rewrite and automate" that
// waits for the answer keeps the answer controls, without the opener.
//
// Hooks: [data-ask-rule-stage] (the wrapper), [data-ask-answer-sent],
// [data-ask-rule-pending] (the banner), [data-ask-rule-change] (the button),
// [data-ask-rule-change-input], [data-ask-rule-decline]; the rule is the
// action block ([data-ask-action], [data-ask-action-apply]).
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

setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

type Post = { path: string; body: Record<string, unknown> };
let posts: Post[] = [];
// What a POST does before it resolves (the server's push, for example).
let onPost: ((path: string) => void | Promise<void>) | null = null;
beforeEach(() => {
  posts = [];
  onPost = null;
  setApiShim(async (method, path, body) => {
    if (method === "POST") {
      posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
      await onPost?.(path);
    }
    return undefined;
  });
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));

const AGENT = "a1";
const LINE = "Tab order and copy changes: go with your pick, tell me after.";
const WORDS = "Pick the copy yourself next time.";
const ask = (id: string, fields: Partial<AskEntry> = {}): AskEntry => ({
  id,
  agentId: AGENT,
  memberUserId: "u1",
  prompt: `Question ${id}?`,
  options: ["Ship now", "Wait"],
  createdAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  ...fields,
});
const answered = (
  outcome: "replied" | "dismissed" | "postponed" = "replied",
  text: string | undefined = "Ship now",
) => ({
  automateRequest: {
    at: NOW,
    byUserId: "u1",
    words: WORDS,
    answer: { outcome, ...(text !== undefined ? { text } : {}), at: NOW },
  },
});
const rule = (line = LINE) => ({
  step: {
    kind: "instructions-line" as const,
    scope: "agent" as const,
    line,
    targetId: AGENT,
  },
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
  root.querySelector<HTMLElement>(`[data-ask="${id}"]`);
const count = (root: HTMLElement, id: string, sel: string) =>
  card(root, id)?.querySelectorAll(sel).length ?? -1;
const q = <T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  id: string,
  sel: string,
) => card(root, id)?.querySelector<T>(sel) ?? null;
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));
const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) =>
  act(async () => void fireEvent.change(el, { target: { value } }));
// The answer controls a rule stage hides.
const ANSWER_CONTROLS =
  "[data-ask-option], [data-ask-reply-input], [data-ask-tag], [data-ask-send], [data-ask-automate-open]";

it("before the rule: hides the answer controls, shows what was sent and the writing banner; Don't save posts a dismiss without automate", async () => {
  const cases: [string, ReturnType<typeof answered>, string | null][] = [
    ["rs01", answered("replied", "Ship now"), "Ship now"],
    ["rs02", answered("postponed", "Monday"), "Monday"],
    ["rs03", answered("dismissed", undefined), null],
  ];
  for (const [id, fields, shown] of cases) {
    posts = [];
    const view = await stack(ask(id, fields));
    const root = view.container;
    expect({
      id,
      stage: count(root, id, "[data-ask-rule-stage]"),
      sent: count(root, id, "[data-ask-answer-sent]"),
      pending: count(root, id, "[data-ask-rule-pending]"),
      controls: count(root, id, ANSWER_CONTROLS),
      action: count(root, id, "[data-ask-action]"),
      change: count(root, id, "[data-ask-rule-change]"),
    }).toEqual({
      id,
      stage: 1,
      sent: 1,
      pending: 1,
      controls: 0,
      action: 0,
      change: 0,
    });
    if (shown !== null)
      expect(
        (q(root, id, "[data-ask-answer-sent]")?.textContent ?? "").includes(
          shown,
        ),
      ).toBe(true);
    await click(q(root, id, "[data-ask-rule-decline]")!);
    await waitFor(() => expect(posts.length).toBe(1));
    expect({
      id,
      path: posts[0].path,
      automate: posts[0].body.automate,
    }).toEqual({ id, path: `/api/asks/${id}/dismiss`, automate: undefined });
    view.unmount();
  }
});

it("with the rule: shows the line in the action block; Apply sends the scope and the line; Change sends its words to the rewrite route; Don't save posts a dismiss", async () => {
  const id = "rs10";
  const view = await stack(ask(id, { ...answered(), ...rule() }));
  const root = view.container;
  expect({
    controls: count(root, id, ANSWER_CONTROLS),
    pending: count(root, id, "[data-ask-rule-pending]"),
    action: count(root, id, "[data-ask-action]"),
    line: (q(root, id, "[data-ask-action]")?.textContent ?? "").includes(LINE),
  }).toEqual({ controls: 0, pending: 0, action: 1, line: true });
  await click(q(root, id, "[data-ask-action-apply]")!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]).toEqual({
    path: `/api/asks/${id}/action`,
    body: { scope: "agent", line: LINE },
  });
  await type(
    q<HTMLTextAreaElement>(root, id, "[data-ask-rule-change-input]")!,
    "Only copy changes",
  );
  await click(q(root, id, "[data-ask-rule-change]")!);
  await waitFor(() => expect(posts.length).toBe(2));
  expect({ path: posts[1].path, text: posts[1].body.text }).toEqual({
    path: `/api/asks/${id}/rewrite`,
    text: "Only copy changes",
  });
  expect(posts[1].body.automate).toBe(undefined);
  await click(q(root, id, "[data-ask-rule-decline]")!);
  await waitFor(() => expect(posts.length).toBe(3));
  expect(posts[2].path).toBe(`/api/asks/${id}/dismiss`);
});

it("while a change is pending, the banner shows over the rule; the agent's new rule brings Apply with the new line", async () => {
  const id = "rs20";
  const view = await stack(
    ask(id, { ...answered(), ...rule(), simplifyRequestedAt: NOW }),
  );
  const root = view.container;
  expect(count(root, id, "[data-ask-rule-pending]")).toBe(1);
  const tuned = "Copy changes only: go with your pick.";
  await act(async () => {
    seeded({
      type: "ask_upserted",
      entry: ask(id, {
        ...answered(),
        ...rule(tuned),
        updatedAt: NOW,
      }) as never,
    });
  });
  await waitFor(() =>
    expect(count(root, id, "[data-ask-rule-pending]")).toBe(0),
  );
  await click(q(root, id, "[data-ask-action-apply]")!);
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].body).toEqual({ scope: "agent", line: tuned });
});

it("the card that sends an answer with automate stays, at its rule stage, whether the push comes before or after the response", async () => {
  for (const order of ["push first", "response first"] as const) {
    const id = order === "push first" ? "rs30" : "rs31";
    posts = [];
    const view = await stack(ask(id));
    const root = view.container;
    const push = () =>
      seeded({
        type: "ask_upserted",
        entry: ask(id, { ...answered(), updatedAt: NOW }) as never,
      });
    if (order === "push first") onPost = () => push();
    await click(q(root, id, "[data-ask-automate-open]")!);
    await click(q(root, id, '[data-ask-tag="dismiss"]')!);
    await type(
      q<HTMLTextAreaElement>(root, id, "[data-ask-automate-input]")!,
      WORDS,
    );
    await click(q(root, id, "[data-ask-automate-send]")!);
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].body.automate).toBe(WORDS);
    if (order === "response first") await act(async () => push());
    await act(async () => {});
    await waitFor(() =>
      expect({
        order,
        stage: count(root, id, "[data-ask-rule-stage]"),
      }).toEqual({ order, stage: 1 }),
    );
    view.unmount();
  }
});

it("on the Inbox, after the Undo time, the card of the sent answer with automate is at its rule stage", async () => {
  jest.useFakeTimers();
  const id = "held";
  const { view, latest } = inbox.mount([inbox.ask(id, "a1", 5)]);
  const root = view.container;
  onPost = () =>
    latest.dispatch({
      type: "ask_upserted",
      entry: {
        ...inbox.ask(id, "a1", 5),
        ...answered("dismissed", undefined),
      },
    } as never);
  await click(q(root, id, '[data-ask-tag="dismiss"]')!);
  await click(q(root, id, "[data-ask-automate-open]")!);
  await type(
    q<HTMLTextAreaElement>(root, id, "[data-ask-automate-input]")!,
    WORDS,
  );
  await click(q(root, id, "[data-ask-automate-send]")!);
  expect(posts.length).toBe(0);
  await act(async () => {
    jest.advanceTimersByTime(ASK_UNDO_MS);
  });
  await act(async () => {});
  await act(async () => {});
  expect(posts.map((p) => p.path)).toEqual([`/api/asks/${id}/dismiss`]);
  expect(count(root, id, "[data-ask-rule-stage]")).toBe(1);
});

it("a Rewrite and automate that waits for the answer keeps the answer controls but not the automate opener", async () => {
  const id = "rs40";
  const view = await stack(
    ask(id, { automateRequest: { at: NOW, byUserId: "u1", words: WORDS } }),
  );
  const root = view.container;
  expect({
    stage: count(root, id, "[data-ask-rule-stage]"),
    input: count(root, id, "[data-ask-reply-input]"),
    opener: count(root, id, "[data-ask-automate-open]"),
  }).toEqual({ stage: 0, input: 1, opener: 0 });
});
