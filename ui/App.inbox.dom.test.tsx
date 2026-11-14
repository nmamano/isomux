// The Inbox through the real App and store: the office bar entry counts the
// open asks and opens the Inbox, which holds the Asks view and no tab row
// (task 74e8fc07, slice 4: pages are paged asks), and an old path or an old
// page link lands on the Asks view. The chat bar's entry is in
// ui/App.inbox-chat.dom.test.tsx, an ask's link in
// ui/App.inbox-ask-links.dom.test.tsx, the setup in
// ui/test-support/inbox-fixture.tsx, and the view in AsksView.dom.test.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const {
  askCards,
  askReads,
  boot,
  chatFromInbox,
  inboxButton,
  inboxOpen,
  inboxTitleCount,
  pageReads,
  ranger,
  ask,
  selectedTab,
  selfRecord,
  seenPosts,
  setAskRead,
  setPageAsks,
  setSelfSeen,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

it("counts the open asks, and opens the Inbox on the Asks view with no tab row", async () => {
  const view = await boot();
  const button = inboxButton(view)!;
  expect(button).toBeDefined();
  // The hidden-room ask is in the store but neither counted nor listed.
  expect(button.querySelector(".nav-action-badge")?.textContent).toBe("2");
  expect(inboxTitleCount(view)).toBe(2);
  await act(async () => fireEvent.click(button));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(inboxOpen(view)).toBe(true);
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelector('[role="tablist"]')).toBeNull();
  expect(view.container.querySelector('[role="tab"]')).toBeNull();
  expect(view.container.querySelector("[data-inbox-tab]")).toBeNull();
  expect(askCards(view)).toBe(2);
  await chatFromInbox(view, "a1");
  expect(window.location.pathname).toBe("/");
  expect(inboxOpen(view)).toBe(false);
  expect(view.container.querySelector("[data-asks-stack]")).not.toBeNull();
});

it("opens the Asks view with no ask open, and closes to what was under the Inbox", async () => {
  const view = await boot();
  await act(async () => shimEmit({ type: "ask_removed", id: "q1" } as never));
  await act(async () => shimEmit({ type: "ask_removed", id: "q2" } as never));
  expect(inboxButton(view)!.querySelector(".nav-action-badge")).toBeNull();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(selectedTab(view)).toBe("asks");
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(window.location.pathname).toBe("/");
  expect(inboxOpen(view)).toBe(false);
});

// A page is a paged ask: no client asks for a page list or hears a page event.
it("counts a paged ask like any ask, and a pager event changes nothing", async () => {
  const view = await boot();
  await act(async () =>
    shimEmit({
      type: "ask_upserted",
      entry: {
        ...ask("q7", "a1"),
        priority: "P1",
        page: { state: "ringing", pageId: "00112233aabbccdd" },
      },
    } as never),
  );
  expect(inboxTitleCount(view)).toBe(3);
  await act(async () =>
    shimEmit({
      type: "pager_upserted",
      entry: {
        id: "p1",
        createdAt: 1,
        lastRaisedAt: 1,
        raiseCount: 1,
        source: { kind: "agent", agentId: "a1", name: "Scout", roomId: "r1" },
        targetUserId: "u1",
        title: "Old",
        state: "open",
        delivery: { state: "not_delivered", sends: 0 },
      },
    } as never),
  );
  expect(inboxTitleCount(view)).toBe(3);
  expect(
    inboxButton(view)!.querySelector(".nav-action-badge")?.textContent,
  ).toBe("3");
});

// A Discord or push link from before pages were asks, /?pager=<pageId>: the
// client reads the page's ask and pins it, open or closed.
it("pins the ask an old page link names, and clears the link", async () => {
  setPageAsks({ abcd1234: "q2" });
  const view = await boot("/?pager=abcd1234");
  await act(async () => {});
  expect(pageReads).toEqual(["abcd1234"]);
  // A pinned ask shows /inbox/asks, as for an /inbox/asks/<id> address.
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(window.location.search).toBe("");
  const pinned = view.container.querySelector("[data-asks-pinned]");
  expect(pinned).not.toBeNull();
  expect(pinned!.querySelector('[data-ask="q2"]')).not.toBeNull();
  expect(pinned!.querySelector('[data-ask="q1"]')).toBeNull();
});

it("pins a closed ask an old page link names", async () => {
  setPageAsks({ "00112233aabbccdd": "c0ffee01" });
  setAskRead(async (id) => ({
    ...ask(id, "a1"),
    member: "member",
    closed: { at: 2_000, outcome: "dismissed", by: "member" },
    events: [],
  }));
  const view = await boot("/?pager=00112233aabbccdd");
  await act(async () => {});
  await act(async () => {});
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(askReads).toContain("c0ffee01");
  expect(
    view.container.querySelector(
      '[data-asks-pinned] [data-ask-readonly="c0ffee01"]',
    ),
  ).not.toBeNull();
});

it("opens the Asks view with no pin for an old page link the office does not know", async () => {
  const view = await boot("/?pager=ffffffffffffffff");
  await act(async () => {});
  expect(pageReads).toEqual(["ffffffffffffffff"]);
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(window.location.search).toBe("");
  expect(selectedTab(view)).toBe("asks");
  expect(view.container.querySelector("[data-asks-pinned]")).toBeNull();
  expect(askCards(view)).toBe(2);
});

// Task a930c9d6: the badge counts the asks not yet shown on the Asks view,
// so a filter left on there never hides an ask from it; the entry's title
// keeps every open ask. Task 64d3950a: what was shown is on the member's
// record (inboxSeen), so a mark on one device clears the badge on the others.
const badgeOf = (view: View) =>
  inboxButton(view)!.querySelector(".nav-action-badge")?.textContent ?? null;
const closeInbox = (view: View) =>
  act(async () => fireEvent.click(view.getByRole("button", { name: "←" })));
const emitSelf = (inboxSeen: string[]) =>
  act(async () =>
    shimEmit({
      type: "user_self_updated",
      user: selfRecord(inboxSeen),
    } as never),
  );

it("badges the asks no device has shown, sends only the new marks, and follows the marks of another device", async () => {
  const view = await boot();
  // Nothing seen yet on any device: every open ask is new.
  expect(badgeOf(view)).toBe("2");
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(askCards(view)).toBe(2);
  // The hidden-room ask is not on the view, so it is not marked.
  expect(seenPosts.map((keys) => [...keys].sort())).toEqual([["q1", "q2"]]);
  await closeInbox(view);
  // Clear at once, before the record comes back.
  expect(badgeOf(view)).toBeNull();
  expect(inboxTitleCount(view)).toBe(2);
  await emitSelf(["q1", "q2"]);
  expect(badgeOf(view)).toBeNull();

  // A new ask lights it.
  await act(async () =>
    shimEmit({ type: "ask_upserted", entry: ask("q9", "a1") } as never),
  );
  expect(badgeOf(view)).toBe("1");
  expect(inboxTitleCount(view)).toBe(3);

  // Another device of the member shows q9: the badge here follows, and this
  // device sends nothing.
  await emitSelf(["q1", "q2", "q9"]);
  expect(badgeOf(view)).toBeNull();
  expect(seenPosts.length).toBe(1);

  // The agent of the hidden-room ask reaches the client (its room shown
  // again): that ask was never on a view, so it lights the badge, and the
  // next showing sends only its mark.
  await act(async () =>
    shimEmit({
      type: "agent_added",
      agent: { ...ranger, id: "hidden" },
    } as never),
  );
  expect(badgeOf(view)).toBe("1");
  expect(inboxTitleCount(view)).toBe(4);
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(askCards(view)).toBe(4);
  expect(seenPosts.slice(1)).toEqual([["q3"]]);
  await closeInbox(view);
  expect(badgeOf(view)).toBeNull();
});

it("a device that loads after another showed an ask does not badge it, and badges nothing before the member's record arrives", async () => {
  setSelfSeen(null);
  const view = await boot();
  // The asks are in, the record is not: no badge yet, the title counts.
  expect(inboxTitleCount(view)).toBe(2);
  expect(badgeOf(view)).toBeNull();
  // The public roster carries no marks: still unknown, so still no badge.
  await act(async () =>
    shimEmit({
      type: "users_list",
      users: [
        {
          id: "u1",
          name: "member",
          role: "member",
          avatarColor: "#4a90d9",
          avatarVariant: "classic",
          createdAt: 0,
        },
      ],
    } as never),
  );
  expect(badgeOf(view)).toBeNull();
  // The member's record: another device showed q1.
  await emitSelf(["q1"]);
  expect(badgeOf(view)).toBe("1");
  await emitSelf(["q1", "q2"]);
  expect(badgeOf(view)).toBeNull();
  expect(seenPosts.length).toBe(0);
});

// The old paths: the alias table is pinned in ui/routes.test.ts and the
// canonical rewrite in ui/App.deeplink.dom.test.tsx. This proves the boot page
// reaches the Inbox's Asks view.
it("lands the old /asks and /inbox/pages paths, and a view saved on Pages, on the Asks view", async () => {
  for (const path of ["/asks", "/inbox/pages", "/inbox/pages/abcd1234"]) {
    const view = await boot(path);
    expect({ path, tab: selectedTab(view) }).toEqual({ path, tab: "asks" });
    expect(window.location.pathname).toBe("/inbox/asks");
    view.unmount();
  }
});
