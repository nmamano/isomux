// The wait for an in-place edit on the ask card (task b1cf73eb). After
// Rewrite, after an answer with automate (until the agent proposes the rule)
// and after the rule's Change, the agent edits the same ask. Until it does,
// one banner tops the card and the rest of the card is frozen: inert, so
// nothing in it reacts. A minute after the request, while the asking agent is
// not working (an agent the store does not have counts as not working), the
// wait is stalled: the banner says so, keeps Undo and Don't save, and the card
// is no longer frozen. Nothing is stalled while the store is disconnected.
//
// Hooks: [data-ask-updating] (the banner), [data-ask-update-stalled],
// [data-ask-frozen] (the frozen wrapper, with the inert attribute),
// [data-ask-simplify-pending] / [data-ask-rule-pending] (the banner's kind),
// [data-ask-simplify-undo], [data-ask-rule-decline].
import { afterAll, afterEach, beforeEach, expect, it, jest } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
const inbox = await import("../test-support/asks-view.ts");
const { mount: stackMount, seeded } =
  await import("../test-support/asks-stack-fixture.tsx");
type AskEntry = import("../../shared/types.ts").AskEntry;
type AgentState = import("../../shared/types.ts").AgentState;
type AppState = import("../test-support/asks-view.ts").AppState;

type Post = { path: string; body: Record<string, unknown> };
let posts: Post[] = [];
beforeEach(() => {
  posts = [];
  setApiShim(async (method, path, body) => {
    if (method === "POST")
      posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    return undefined;
  });
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());
afterAll(() => setApiShim(null));
// The chat stack's store opens the socket: a shim keeps it from failing
// (a failed socket marks the store disconnected).
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
});

const AGENT = "a1";
const SEC = 1_000;

// The three waits, each from a request made `ago` ms before now.
type Kind = "rewrite" | "rule" | "change";
function waiting(id: string, kind: Kind, ago: number, agentId = AGENT) {
  const at = Date.now() - ago;
  const base: AskEntry = {
    ...inbox.ask(id, agentId, 5),
    options: ["Ship now", "Wait"],
  };
  const answered = {
    automateRequest: {
      at,
      byUserId: "u1",
      words: "Pick the copy yourself next time.",
      answer: { outcome: "replied" as const, text: "Ship now", at },
    },
  };
  const rule = {
    step: {
      kind: "instructions-line" as const,
      scope: "agent" as const,
      line: "Copy changes: go with your pick.",
      targetId: agentId,
    },
  };
  if (kind === "rewrite") return { ...base, simplifyRequestedAt: at };
  if (kind === "rule") return { ...base, ...answered };
  return { ...base, ...answered, ...rule, simplifyRequestedAt: at };
}

function place(state: AgentState | null, connected = true): Partial<AppState> {
  return {
    connected,
    agents: (state === null
      ? []
      : [{ id: AGENT, name: "Scout", roomId: "r1", state }]) as never,
  };
}

const card = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-ask="${id}"]`)!;
// The card's wait, as a list of scalars (never DOM nodes in an assertion).
function look(root: HTMLElement, id: string) {
  const c = card(root, id);
  const banner = c.querySelector<HTMLElement>("[data-ask-updating]");
  const prompt = c.querySelector<HTMLElement>("[data-ask-prompt]");
  return {
    banner: banner !== null,
    bannerFirst:
      c.firstElementChild?.hasAttribute("data-ask-updating") ?? false,
    stalled: banner?.hasAttribute("data-ask-update-stalled") ?? false,
    frozen: c.querySelectorAll("[data-ask-frozen]").length,
    inert: c.querySelectorAll("[inert]").length,
    promptInert: (prompt?.closest("[inert]") ?? null) !== null,
    bannerInert: (banner?.closest("[inert]") ?? null) !== null,
  };
}
const UPDATING = {
  banner: true,
  bannerFirst: true,
  stalled: false,
  frozen: 1,
  inert: 1,
  promptInert: true,
  bannerInert: false,
};
const STALLED = {
  banner: true,
  bannerFirst: true,
  stalled: true,
  frozen: 0,
  inert: 0,
  promptInert: false,
  bannerInert: false,
};
const NONE = {
  banner: false,
  bannerFirst: false,
  stalled: false,
  frozen: 0,
  inert: 0,
  promptInert: false,
  bannerInert: false,
};

const advance = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el));

it("each wait puts the banner on top and the rest of the card, the prompt with it, in one inert wrapper", async () => {
  const cases: [Kind, string, string, boolean, boolean][] = [
    // kind, id, the banner's kind mark, Undo, Don't save
    ["rewrite", "uw01", "data-ask-simplify-pending", true, false],
    ["rule", "uw02", "data-ask-rule-pending", false, true],
    ["change", "uw03", "data-ask-rule-pending", true, true],
  ];
  for (const [kind, id, mark, undo, decline] of cases) {
    const { view } = inbox.mount(
      [waiting(id, kind, 0)],
      place("waiting_for_response"),
    );
    await advance(1);
    const root = view.container;
    const banner = card(root, id).querySelector("[data-ask-updating]");
    expect({ kind, ...look(root, id) }).toEqual({ kind, ...UPDATING });
    expect({
      kind,
      mark: banner?.hasAttribute(mark) ?? false,
      both:
        (banner?.hasAttribute("data-ask-simplify-pending") ?? false) &&
        (banner?.hasAttribute("data-ask-rule-pending") ?? false),
      undo: banner?.querySelectorAll("[data-ask-simplify-undo]").length,
      decline: banner?.querySelectorAll("[data-ask-rule-decline]").length,
    }).toEqual({
      kind,
      mark: true,
      both: false,
      undo: undo ? 1 : 0,
      decline: decline ? 1 : 0,
    });
    view.unmount();
  }
});

it("once the agent's edit lands, the banner goes and the card is not inert", async () => {
  for (const kind of ["rewrite", "rule", "change"] as const) {
    const id = `uw1${kind.length}`;
    const { view, latest } = inbox.mount(
      [waiting(id, kind, 0)],
      place("thinking"),
    );
    await advance(1);
    const root = view.container;
    expect({ kind, ...look(root, id) }).toEqual({ kind, ...UPDATING });
    const now = waiting(id, kind, 0);
    const landed: AskEntry =
      kind === "rewrite"
        ? {
            ...now,
            simplifyRequestedAt: undefined,
            originalPrompt: now.prompt,
            prompt: "Ship it now?",
          }
        : kind === "rule"
          ? {
              ...now,
              step: {
                kind: "instructions-line",
                scope: "agent",
                line: "Copy changes: go with your pick.",
                targetId: AGENT,
              },
            }
          : { ...now, simplifyRequestedAt: undefined };
    await act(async () => {
      latest.dispatch({ type: "ask_upserted", entry: landed } as never);
    });
    expect({ kind, ...look(root, id) }).toEqual({ kind, ...NONE });
    view.unmount();
  }
});

it("an idle agent's wait turns stalled at the minute mark, by a timer, and the card is not inert then", async () => {
  const id = "uw20";
  const { view, latest } = inbox.mount(
    [waiting(id, "rewrite", 50 * SEC)],
    place("waiting_for_response"),
  );
  const root = view.container;
  expect({
    connected: latest.state.connected,
    agent: latest.state.agents.find((a) => a.id === AGENT)?.state,
  }).toEqual({ connected: true, agent: "waiting_for_response" });
  await advance(1);
  expect(look(root, id)).toEqual(UPDATING);
  await advance(5 * SEC);
  expect(look(root, id)).toEqual(UPDATING);
  await advance(6 * SEC);
  expect(look(root, id)).toEqual(STALLED);
});

it("a working agent keeps the wait at updating past the mark; it stalls when the agent stops and updates again when it works", async () => {
  const pairs: [AgentState, AgentState][] = [
    ["thinking", "waiting_for_response"],
    ["tool_executing", "stopped"],
  ];
  for (const [busy, idle] of pairs) {
    const id = `uw3${busy.length}`;
    const { view, latest } = inbox.mount(
      [waiting(id, "rule", 90 * SEC)],
      place(busy),
    );
    const root = view.container;
    const set = (state: AgentState) =>
      act(async () => {
        latest.dispatch({
          type: "agent_updated",
          agentId: AGENT,
          changes: { state },
        });
      });
    await advance(1);
    expect({ busy, connected: latest.state.connected }).toEqual({
      busy,
      connected: true,
    });
    expect({ busy, ...look(root, id) }).toEqual({ busy, ...UPDATING });
    await set(idle);
    expect({ idle, ...look(root, id) }).toEqual({ idle, ...STALLED });
    await set(busy);
    expect({ busy, ...look(root, id) }).toEqual({ busy, ...UPDATING });
    view.unmount();
  }
});

it("nothing stalls while the store is disconnected", async () => {
  const id = "uw40";
  const { view, latest } = inbox.mount(
    [waiting(id, "rewrite", 90 * SEC)],
    place("waiting_for_response", false),
  );
  const root = view.container;
  await advance(1);
  expect({ connected: latest.state.connected, ...look(root, id) }).toEqual({
    connected: false,
    ...UPDATING,
  });
  await act(async () => {
    latest.dispatch({ type: "connected" });
  });
  expect({ connected: latest.state.connected, ...look(root, id) }).toEqual({
    connected: true,
    ...STALLED,
  });
});

it("an agent the store does not have is not stalled at once, only at the minute mark", async () => {
  // The Inbox drops the asks of an agent it does not know; the chat's stack
  // of that agent's asks still draws them.
  const id = "uw50";
  const view = stackMount(false, "zz");
  const root = view.container;
  await act(async () => {
    seeded({ type: "connected" });
    seeded({
      type: "ask_upserted",
      entry: waiting(id, "rewrite", 10 * SEC, "zz") as never,
    });
  });
  await advance(1);
  const open = root.querySelector<HTMLElement>(
    "[data-asks-stack=collapsed] button",
  );
  if (open) await click(open);
  expect(look(root, id)).toEqual(UPDATING);
  await advance(40 * SEC);
  expect(look(root, id)).toEqual(UPDATING);
  await advance(11 * SEC);
  expect(look(root, id)).toEqual(STALLED);
  view.unmount();
});

it("Undo and Don't save still send their requests from a stalled banner", async () => {
  const id = "uw60";
  const { view } = inbox.mount(
    [waiting(id, "change", 90 * SEC)],
    place("waiting_for_response"),
  );
  const root = view.container;
  await advance(1);
  expect(look(root, id)).toEqual(STALLED);
  const banner = card(root, id).querySelector<HTMLElement>(
    "[data-ask-updating]",
  )!;
  await click(banner.querySelector<HTMLElement>("[data-ask-simplify-undo]")!);
  await act(async () => {});
  expect(posts.map((p) => p.path)).toEqual([`/api/asks/${id}/simplify/undo`]);
  await click(banner.querySelector<HTMLElement>("[data-ask-rule-decline]")!);
  await advance(10 * 60 * SEC);
  await act(async () => {});
  expect(posts.map((p) => p.path)).toEqual([
    `/api/asks/${id}/simplify/undo`,
    `/api/asks/${id}/dismiss`,
  ]);
});

// Task d6f3d315: a banner that the member's own action on this card brought
// (a rewrite, the rule's Change, an answer with automate) is scrolled into
// view once, with block "nearest": the tap is at the bottom of a long card
// and the banner at its top. The server's push may come before or after the
// POST's reply. A banner from elsewhere (another device, a page load), a
// failed POST, and a push more than a minute after the POST do not move the
// page.
const { ASK_UNDO_MS } = await import("../components/AsksView.tsx");
type Scroll = { ask: string | null; banner: boolean; block: unknown };
let scrolls: Scroll[] = [];
let restoreScroll: (() => void) | null = null;
function spyScroll() {
  scrolls = [];
  const proto = Element.prototype as unknown as {
    scrollIntoView?: (options?: unknown) => void;
  };
  const before = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  proto.scrollIntoView = function (this: Element, options?: unknown) {
    scrolls.push({
      ask: this.closest("[data-ask]")?.getAttribute("data-ask") ?? null,
      banner: this.hasAttribute("data-ask-updating"),
      block: (options as { block?: unknown } | undefined)?.block,
    });
  };
  restoreScroll = () => {
    if (before) Object.defineProperty(proto, "scrollIntoView", before);
    else delete proto.scrollIntoView;
  };
}
afterEach(() => {
  restoreScroll?.();
  restoreScroll = null;
});
const bannerScrolls = () => scrolls.filter((s) => s.banner);

// The POST whose path ends with `route` waits until the test settles it,
// with success or with a failure.
function holdPost(route: string) {
  let settle: ((ok: boolean) => void) | null = null;
  setApiShim(async (method, path, body) => {
    if (method !== "POST") return undefined;
    posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    if (!path.endsWith(route)) return undefined;
    await new Promise<void>((resolve, reject) => {
      settle = (ok) => (ok ? resolve() : reject(new Error("offline")));
    });
    return undefined;
  });
  return async (ok: boolean) => {
    expect(settle !== null).toBe(true);
    await act(async () => settle!(ok));
    await act(async () => {});
  };
}

const open = (id: string): AskEntry => ({
  ...inbox.ask(id, AGENT, 5),
  options: ["Ship now", "Wait"],
});
// What the server pushes once it took each request.
function pushed(id: string, kind: Kind): AskEntry {
  const at = Date.now();
  if (kind === "rewrite") return { ...open(id), simplifyRequestedAt: at };
  const rule = waiting(id, "change", 0);
  if (kind === "change") return { ...rule, simplifyRequestedAt: at };
  return {
    ...open(id),
    automateRequest: {
      at,
      byUserId: "u1",
      words: "Pick the copy yourself next time.",
      answer: { outcome: "replied", text: "Ship now", at },
    },
  };
}
// The rule stage with the agent's rule in place: Change is open.
const ruleShown = (id: string): AskEntry => {
  const { simplifyRequestedAt: _, ...rest } = waiting(id, "change", 0);
  return rest;
};

const q = <T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  id: string,
  sel: string,
) => card(root, id).querySelector<T>(sel)!;
const type = (el: HTMLElement, value: string) =>
  act(async () => void fireEvent.change(el, { target: { value } }));

// The member's action on the card, up to its POST being sent.
async function act_(root: HTMLElement, id: string, kind: Kind) {
  if (kind === "rewrite") {
    await click(q(root, id, '[data-ask-tag="rewrite"]'));
    await type(q(root, id, "[data-ask-reply-input]"), "Shorter please");
    await click(q(root, id, "[data-ask-send]"));
  } else if (kind === "change") {
    await type(q(root, id, "[data-ask-rule-change-input]"), "Only copy");
    await click(q(root, id, "[data-ask-rule-change]"));
  } else {
    await type(q(root, id, "[data-ask-reply-input]"), "Ship now");
    await click(q(root, id, "[data-ask-automate-open]"));
    await type(q(root, id, "[data-ask-automate-input]"), "Copy: your pick.");
    await click(q(root, id, "[data-ask-automate-send]"));
    // The Inbox holds the answer for its Undo time, then sends it.
    await advance(ASK_UNDO_MS);
  }
}
const ROUTE: Record<Kind, string> = {
  rewrite: "/rewrite",
  change: "/rewrite",
  rule: "/reply",
};

it("a banner brought by the member's own rewrite, Change or answer with automate is scrolled into view once, whether the push comes before or after the POST's reply", async () => {
  const cases: [Kind, "post-first" | "push-first"][] = [
    ["rewrite", "post-first"],
    ["rewrite", "push-first"],
    ["change", "post-first"],
    ["change", "push-first"],
    ["rule", "post-first"],
    ["rule", "push-first"],
  ];
  for (const [i, [kind, order]] of cases.entries()) {
    const id = `us0${i}`;
    posts = [];
    spyScroll();
    const settle = holdPost(ROUTE[kind]);
    const { view, latest } = inbox.mount(
      [kind === "change" ? ruleShown(id) : open(id)],
      place("waiting_for_response"),
    );
    const root = view.container;
    await advance(1);
    expect({ kind, ...look(root, id) }).toEqual({ kind, ...NONE });
    await act_(root, id, kind);
    expect({ kind, order, posts: posts.map((p) => p.path) }).toEqual({
      kind,
      order,
      posts: [`/api/asks/${id}${ROUTE[kind]}`],
    });
    const push = () =>
      act(async () => {
        latest.dispatch({
          type: "ask_upserted",
          entry: pushed(id, kind),
        } as never);
      });
    if (order === "push-first") {
      await push();
      await settle(true);
    } else {
      await settle(true);
      await push();
    }
    expect({ kind, order, ...look(root, id) }).toEqual({
      kind,
      order,
      ...UPDATING,
    });
    expect({ kind, order, scrolls: bannerScrolls() }).toEqual({
      kind,
      order,
      scrolls: [{ ask: id, banner: true, block: "nearest" }],
    });
    view.unmount();
    restoreScroll?.();
  }
});

it("the scroll is not repeated when the wait turns stalled or the card renders again", async () => {
  spyScroll();
  const id = "us10";
  const settle = holdPost("/rewrite");
  const { view, latest } = inbox.mount(
    [open(id)],
    place("waiting_for_response"),
  );
  const root = view.container;
  await advance(1);
  await act_(root, id, "rewrite");
  await settle(true);
  await act(async () => {
    latest.dispatch({
      type: "ask_upserted",
      entry: pushed(id, "rewrite"),
    } as never);
  });
  expect(bannerScrolls()).toHaveLength(1);
  await act(async () => {
    latest.dispatch({
      type: "agent_updated",
      agentId: AGENT,
      changes: { state: "thinking" },
    });
  });
  await advance(61 * SEC);
  await act(async () => {
    latest.dispatch({
      type: "agent_updated",
      agentId: AGENT,
      changes: { state: "waiting_for_response" },
    });
  });
  expect(look(root, id)).toEqual(STALLED);
  expect(bannerScrolls()).toHaveLength(1);
});

it("the scroll uses up the member's action: a rewrite from elsewhere on the same ask a moment later is not scrolled to", async () => {
  spyScroll();
  const id = "us11";
  const settle = holdPost("/rewrite");
  const { view, latest } = inbox.mount(
    [open(id)],
    place("waiting_for_response"),
  );
  const root = view.container;
  const push = (entry: AskEntry) =>
    act(async () => {
      latest.dispatch({ type: "ask_upserted", entry } as never);
    });
  await advance(1);
  await act_(root, id, "rewrite");
  await settle(true);
  await push(pushed(id, "rewrite"));
  expect({ ...look(root, id), scrolls: bannerScrolls().length }).toEqual({
    ...UPDATING,
    scrolls: 1,
  });
  // The agent's edit lands, then another device asks for a rewrite.
  await push({ ...open(id), prompt: "Ship it now?" });
  expect(look(root, id)).toEqual(NONE);
  await advance(5 * SEC);
  await push(pushed(id, "rewrite"));
  expect({ ...look(root, id), scrolls: bannerScrolls().length }).toEqual({
    ...UPDATING,
    scrolls: 1,
  });
});

it("a banner from elsewhere is not scrolled to: a rewrite pending at page load, and one pushed with no action on this card", async () => {
  spyScroll();
  const { view, latest } = inbox.mount(
    [waiting("us20", "rewrite", 5 * SEC), open("us21")],
    place("waiting_for_response"),
  );
  const root = view.container;
  await advance(1);
  await act(async () => {
    latest.dispatch({
      type: "ask_upserted",
      entry: pushed("us21", "rewrite"),
    } as never);
  });
  expect([look(root, "us20"), look(root, "us21")]).toEqual([
    UPDATING,
    UPDATING,
  ]);
  expect(bannerScrolls()).toEqual([]);
});

it("after a failed rewrite POST, a banner that comes later is not scrolled to", async () => {
  spyScroll();
  const id = "us30";
  const settle = holdPost("/rewrite");
  const { view, latest } = inbox.mount(
    [open(id)],
    place("waiting_for_response"),
  );
  const root = view.container;
  await advance(1);
  await act_(root, id, "rewrite");
  await settle(false);
  expect({
    posts: posts.map((p) => p.path),
    failed: card(root, id).querySelectorAll('[role="alert"]').length,
    ...look(root, id),
  }).toEqual({ posts: [`/api/asks/${id}/rewrite`], failed: 1, ...NONE });
  await act(async () => {
    latest.dispatch({
      type: "ask_upserted",
      entry: pushed(id, "rewrite"),
    } as never);
  });
  expect(look(root, id)).toEqual(UPDATING);
  expect(bannerScrolls()).toEqual([]);
});

it("a banner pushed more than a minute after the member's rewrite is not scrolled to", async () => {
  spyScroll();
  const id = "us40";
  const settle = holdPost("/rewrite");
  const { view, latest } = inbox.mount(
    [open(id)],
    place("waiting_for_response"),
  );
  const root = view.container;
  await advance(1);
  await act_(root, id, "rewrite");
  await settle(true);
  expect(look(root, id)).toEqual(NONE);
  const before = Date.now();
  await advance(61 * SEC);
  expect(Date.now() - before).toBeGreaterThanOrEqual(61 * SEC);
  await act(async () => {
    latest.dispatch({
      type: "ask_upserted",
      entry: pushed(id, "rewrite"),
    } as never);
  });
  expect(look(root, id)).toEqual(UPDATING);
  expect(bannerScrolls()).toEqual([]);
});
