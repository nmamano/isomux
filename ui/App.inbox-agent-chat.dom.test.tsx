// The Inbox's chat panel (task e3c25581), through the real App and store: an
// ask's agent name opens a chat with that agent over the Inbox, a select moves
// it to any front-desk agent the member sees, and "Open full chat" goes to the
// agent's chat. Its text draft is the agent's chat draft, and a send is an
// ordinary member message. "Discuss in chat" is in
// ui/App.inbox-ask-about.dom.test.tsx, the panel's chat itself (WidgetChat) in
// ui/AppWidgetPage.dom.test.tsx, and the setup in
// ui/test-support/inbox-fixture.tsx.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { shimEmit } = await import("./ws.ts");
const { saveDraft } = await import("./view-persistence.ts");
const {
  addBackRoom,
  addRanger,
  ask,
  boot,
  chatComposer,
  chatPanel,
  chatSelect,
  inboxButton,
  openFullChat,
  ranger,
  sentMessages,
  setAsks,
  setUpInboxTests,
} = await import("./test-support/inbox-fixture.tsx");
type View = import("./test-support/inbox-fixture.tsx").View;

setUpInboxTests();

const inboxOpen = (view: View) =>
  view.container.querySelector("[data-inbox]") !== null;
// The full chat's own ask stack: it shows only in an agent's chat.
const fullChatOpen = (view: View) =>
  view.container.querySelector("[data-asks-stack]") !== null;

async function clickName(view: View, agentId: string) {
  const name = view.container.querySelector<HTMLButtonElement>(
    `[data-asks-agent="${agentId}"]`,
  );
  expect(name).not.toBeNull();
  await act(async () => fireEvent.click(name!));
}

function say(agentId: string, id: string, content: string) {
  shimEmit({
    type: "log_entry",
    entry: { id, agentId, kind: "text", content, timestamp: 1_000 },
  } as never);
}

it("opens a chat panel over the Inbox from an agent's name; Escape closes the panel and then the Inbox; Open full chat goes to the agent with the panel's draft", async () => {
  setAsks([ask("q1", "a1")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(chatPanel(view)).toBeNull();

  await clickName(view, "a1");
  const panel = chatPanel(view);
  expect(panel).not.toBeNull();
  expect(panel!.getAttribute("role")).toBe("dialog");
  expect(chatSelect(view)?.value).toBe("a1");
  // The Inbox is still open under it, and no full chat opened.
  expect(window.location.pathname).toBe("/inbox/asks");
  expect(inboxOpen(view)).toBe(true);
  expect(view.container.querySelector('[data-ask="q1"]')).not.toBeNull();
  expect(fullChatOpen(view)).toBe(false);

  // Escape in the panel closes the panel only; the next one the Inbox.
  await act(async () =>
    fireEvent.keyDown(chatComposer(view)!, { key: "Escape" }),
  );
  expect(chatPanel(view)).toBeNull();
  expect(inboxOpen(view)).toBe(true);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(inboxOpen(view)).toBe(false);

  // Text typed in the panel is the agent's chat draft: the full chat opens
  // with it, and the Inbox and the panel close.
  await act(async () => fireEvent.click(inboxButton(view)!));
  await clickName(view, "a1");
  await act(async () =>
    fireEvent.change(chatComposer(view)!, {
      target: { value: "typed in the panel" },
    }),
  );
  await openFullChat(view);
  expect(window.location.pathname).toBe("/");
  expect(document.title).toContain("Scout");
  expect(inboxOpen(view)).toBe(false);
  expect(chatPanel(view)).toBeNull();
  const all = view.container.querySelectorAll("textarea");
  expect(all[all.length - 1].value).toBe("typed in the panel");
});

it("moves the panel to the agent picked in the select: its transcript, its draft, and a send that is an ordinary member message and clears that draft", async () => {
  addRanger();
  setAsks([ask("q1", "a1")]);
  // A draft the member left in Ranger's chat.
  saveDraft("member", "a2", "left for Ranger");
  const view = await boot();
  await act(async () => {
    say("a1", "s1", "Scout was here");
    say("a2", "r1", "Ranger was here");
  });
  await act(async () => fireEvent.click(inboxButton(view)!));
  await clickName(view, "a1");
  const panelText = () => chatPanel(view)?.textContent ?? "";
  expect(panelText()).toContain("Scout was here");
  expect(panelText()).not.toContain("Ranger was here");

  // Every front-desk agent the member sees is a choice, Ranger too, though
  // no ask of its is open.
  const select = chatSelect(view)!;
  const choices = [...select.querySelectorAll("option")].map((o) => o.value);
  expect(choices.sort()).toEqual(["a1", "a2"]);
  await act(async () => fireEvent.change(select, { target: { value: "a2" } }));
  expect(chatSelect(view)?.value).toBe("a2");
  expect(panelText()).toContain("Ranger was here");
  expect(panelText()).not.toContain("Scout was here");
  expect(chatComposer(view)!.value).toBe("left for Ranger");

  // The send goes to Ranger with no app context: a plain member message.
  await act(async () =>
    fireEvent.change(chatComposer(view)!, {
      target: { value: "hello Ranger" },
    }),
  );
  await act(async () => {
    fireEvent.submit(chatPanel(view)!.querySelector("form")!);
  });
  expect(sentMessages.map((m) => m.path)).toEqual(["/api/agents/a2/messages"]);
  expect(sentMessages[0].body.text).toBe("hello Ranger");
  expect("appContext" in sentMessages[0].body).toBe(false);
  expect(chatComposer(view)!.value).toBe("");

  // The sent text left Ranger's chat draft too.
  await openFullChat(view);
  expect(document.title).toContain("Ranger");
  const all = view.container.querySelectorAll("textarea");
  expect(all[all.length - 1].value).toBe("");
});

it("closes the panel when its agent leaves, keeps it closed when the agent comes back, and opens the Inbox without it", async () => {
  addRanger();
  setAsks([ask("q1", "a1"), ask("q2", "a2")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));

  // The panel is not kept across a close of the Inbox.
  await clickName(view, "a1");
  expect(chatPanel(view)).not.toBeNull();
  await act(async () =>
    fireEvent.click(view.getByRole("button", { name: "←" })),
  );
  expect(inboxOpen(view)).toBe(false);
  await act(async () => fireEvent.click(inboxButton(view)!));
  expect(inboxOpen(view)).toBe(true);
  expect(chatPanel(view)).toBeNull();

  // Ranger is removed while its panel is open: the panel closes, the Inbox
  // stays.
  await clickName(view, "a2");
  expect(chatSelect(view)?.value).toBe("a2");
  await act(async () => {
    shimEmit({ type: "agent_removed", agentId: "a2", roomId: "r1" } as never);
  });
  expect(chatPanel(view)).toBeNull();
  expect(inboxOpen(view)).toBe(true);
  // It does not come back with the agent, as when the member shows its room
  // again.
  await act(async () => {
    shimEmit({ type: "agent_added", agent: ranger } as never);
  });
  expect(view.container.querySelector('[data-asks-agent="a2"]')).not.toBeNull();
  expect(chatPanel(view)).toBeNull();
});

it("offers no back-room agent in the select but its own: an ask's back-room agent opens the panel and is its choice until the member moves to another agent", async () => {
  addBackRoom();
  setAsks([ask("q1", "a1"), ask("q8", "a8")]);
  const view = await boot();
  await act(async () => fireEvent.click(inboxButton(view)!));
  // The choices in order, each with its room's group.
  const choices = () =>
    [...chatSelect(view)!.querySelectorAll("option")].map(
      (o) => `${o.closest("optgroup")?.label}/${o.value}`,
    );

  // From Scout's ask: the front desks only, by desk.
  await clickName(view, "a1");
  expect(chatSelect(view)?.value).toBe("a1");
  expect(choices()).toEqual(["First room/a1", "First room/a2"]);

  // From Builder's ask: Builder is the panel's agent and a choice, after the
  // front desks; Checker, another back-room agent, is not.
  await act(async () =>
    fireEvent.keyDown(chatComposer(view)!, { key: "Escape" }),
  );
  await clickName(view, "a8");
  expect(chatPanel(view)).not.toBeNull();
  expect(chatSelect(view)?.value).toBe("a8");
  expect(choices()).toEqual([
    "First room/a1",
    "First room/a2",
    "First room/a8",
  ]);

  // Moved to Ranger, the panel no longer offers Builder.
  await act(async () =>
    fireEvent.change(chatSelect(view)!, { target: { value: "a2" } }),
  );
  expect(chatSelect(view)?.value).toBe("a2");
  expect(choices()).toEqual(["First room/a1", "First room/a2"]);
});
