// Members chat and 1:1 chats keep their layout while the page loads (task
// 133710db, AGENTS.md "UI rules"): full_state's pin count holds the pinned
// bar's place with a busy, disabled strip of the real strip's block shape,
// and the message list holds a busy placeholder until the page lands. Nothing
// stays busy after a failure, on a reconnect that keeps messages, or once the
// page answered. The layout itself (no jump) is checked in a browser by
// scripts/loading-check.sh; happy-dom lays nothing out.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { MembersChatPanel } = await import("./MembersChatPanel.tsx");
const { setApiShim } = await import("../api.ts");
const { blockShape, heldControls } =
  await import("../test-support/held-shape.ts");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
import type { MembersChatState, MemberDmState } from "../store.tsx";
const en = translatorFor("en");
// The panel itself fetches nothing; a call here is a regression.
setApiShim(async (method, path) => {
  throw new Error(`unexpected ${method} ${path}`);
});
afterAll(() => setApiShim(null));

const pin = {
  id: "202608-00000001",
  kind: "user" as const,
  userId: "sam",
  userName: "Sam",
  content: "pinned text",
  timestamp: 1,
  pinnedAt: 2,
  attachments: [],
};
const other = {
  ...pin,
  id: "202608-00000002",
  content: "later",
  pinnedAt: undefined,
};

const held: MembersChatState = {
  messages: [],
  hasMore: false,
  loaded: false,
  readPointer: null,
  unread: 0,
};

function panel(
  membersChat: MembersChatState,
  props: { loadFailed?: boolean } = {},
) {
  return onLanguage(
    "en",
    createElement(MembersChatPanel, { onRetry: () => {}, ...props }),
    { membersChat },
  );
}

const strips = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-members-chat-pinned]"),
];
const list = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-members-chat-list]")!;
const busy = (root: ParentNode) =>
  root.querySelectorAll('[aria-busy="true"]').length;
const rows = (root: ParentNode) =>
  root.querySelectorAll('div[id^="members-chat-"]').length;

it("holds the pinned bar's place from full_state's count with a busy, disabled strip of the real strip's shape", () => {
  const view = render(panel({ ...held, pinCount: 1 }));
  const [heldStrip] = strips(view.container);
  expect(strips(view.container).length).toBe(1);
  expect(heldStrip.getAttribute("aria-busy")).toBe("true");
  const controls = heldControls(view.container).filter((c) =>
    heldStrip.contains(c),
  );
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((c) => c.hasAttribute("disabled"))).toBe(true);
  // The count reads like the real strip's, before anything about the pin.
  expect(heldStrip.textContent).toContain(
    en.t("membersChat.pinned", { count: "1" }),
  );
  const heldShape = blockShape(heldStrip);

  // The page lands: the real strip, not busy, in the same block shape.
  view.rerender(
    panel({
      ...held,
      pinCount: 1,
      loaded: true,
      pinned: [pin],
      messages: [pin, other],
    }),
  );
  expect(strips(view.container).length).toBe(1);
  const [real] = strips(view.container);
  expect(real.hasAttribute("aria-busy")).toBe(false);
  expect(real.textContent).toContain("pinned text");
  expect(blockShape(real)).toBe(heldShape);
  expect(busy(view.container)).toBe(0);
});

it("labels a held strip over the cap as the real strip does", () => {
  const view = render(panel({ ...held, pinCount: 21 }));
  expect(strips(view.container).length).toBe(1);
  const [heldStrip] = strips(view.container);
  expect(heldStrip.getAttribute("aria-busy")).toBe("true");
  expect(heldStrip.textContent).toContain(
    en.t("membersChat.pinned", { count: "20+" }),
  );
});

it("draws no held strip with no pins, from an older server, or once pinned is known", () => {
  // Each case still holds the list, so the panel is in its loading state.
  for (const state of [
    { ...held, pinCount: 0 },
    { ...held },
    // A reconnect after a page that had no pins (or a live unpin of the last).
    { ...held, pinCount: 1, pinned: [] },
  ] satisfies MembersChatState[]) {
    const view = render(panel(state));
    expect(busy(list(view.container))).toBe(1);
    expect(strips(view.container).length).toBe(0);
    view.unmount();
  }
  // A reconnect that kept the pins draws the real strip at once, not busy.
  const view = render(
    panel({ ...held, pinCount: 1, pinned: [pin], messages: [pin] }),
  );
  expect(strips(view.container).length).toBe(1);
  expect(strips(view.container)[0].hasAttribute("aria-busy")).toBe(false);
  view.unmount();
});

it("holds the message list with one busy placeholder until the page lands", () => {
  const view = render(panel(held));
  expect(busy(list(view.container))).toBe(1);
  expect(rows(list(view.container))).toBe(0);

  view.rerender(panel({ ...held, loaded: true, messages: [pin, other] }));
  expect(rows(list(view.container))).toBe(2);
  expect(busy(view.container)).toBe(0);

  // An empty chat that loaded says so; nothing stays busy.
  view.rerender(panel({ ...held, loaded: true }));
  expect(list(view.container).textContent).toContain(en.t("membersChat.empty"));
  expect(busy(view.container)).toBe(0);
});

it("a reconnect that keeps the held messages draws them, not the placeholder", () => {
  const view = render(panel({ ...held, messages: [pin, other] }));
  expect(rows(list(view.container))).toBe(2);
  expect(busy(view.container)).toBe(0);
});

it("a failed load shows the failure with Retry and nothing busy", () => {
  const view = render(panel({ ...held, pinCount: 1 }, { loadFailed: true }));
  const alert = view.getByRole("alert");
  expect(alert.textContent).toContain(en.t("membersChat.loadFailed"));
  expect(
    view.queryByRole("button", { name: en.t("membersChat.retry") }) !== null,
  ).toBe(true);
  expect(busy(view.container)).toBe(0);
  expect(strips(view.container).length).toBe(0);
});

it("a 1:1 chat holds its list the same way and never draws a pinned strip", () => {
  const dm: MemberDmState = {
    ...held,
    peerName: "Pau",
    removed: false,
    lastAt: null,
  };
  // The members chat's count must not leak into a 1:1 chat.
  const base = { membersChat: { ...held, pinCount: 3 } };
  const view = render(
    onLanguage(
      "en",
      createElement(MembersChatPanel, { chat: { kind: "dm", peerId: "u2" } }),
      { ...base, memberDms: { u2: dm } },
    ),
  );
  expect(busy(list(view.container))).toBe(1);
  expect(rows(list(view.container))).toBe(0);
  expect(strips(view.container).length).toBe(0);
  view.rerender(
    onLanguage(
      "en",
      createElement(MembersChatPanel, { chat: { kind: "dm", peerId: "u2" } }),
      {
        ...base,
        memberDms: { u2: { ...dm, loaded: true, messages: [other] } },
      },
    ),
  );
  expect(rows(list(view.container))).toBe(1);
  expect(busy(view.container)).toBe(0);
});
