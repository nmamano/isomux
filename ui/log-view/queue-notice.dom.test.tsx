// An office notice waiting in the queue (task 9019f2f8): the chat already
// shows its system line, so the queue strip does not show it again as a chip
// from the member whose act it reports.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { LogView } = await import("./LogView.tsx");
const { setApiShim } = await import("../api.ts");
const { createElement } = await import("react");
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type QueuedMessage = import("../../shared/types.ts").QueuedMessage;

const NOTICE: QueuedMessage = {
  id: "q1",
  sender: { kind: "user", username: "Tester" },
  text: "[Isomux: NOTICE-LINE]",
  notice: true,
  queuedAt: 1,
};
const MEMBER: QueuedMessage = {
  id: "q2",
  sender: { kind: "user", username: "Tester" },
  text: "MEMBER-LINE",
  queuedAt: 2,
};

const agent = {
  id: "a1",
  name: "Asker",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "thinking",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  outfit: {
    color: "#4A90D9",
    hair: "#222",
    hairStyle: "short",
    skin: "#FFD5B8",
    beard: "none",
    accessory: "none",
    hat: "none",
  },
} as unknown as AgentInfo;

function textWith(queue: QueuedMessage[]): string {
  const withQueue: AgentInfo = { ...agent, queue };
  const view = render(
    onLanguage(
      "en",
      createElement(LogView, {
        agent: withQueue,
        logs: [],
        onBack: () => {},
        onEditAgent: () => {},
      }),
      { agents: [withQueue], hasReceivedInitialState: true, connected: true },
    ),
  );
  const text = view.container.textContent ?? "";
  view.unmount();
  return text;
}

it("the queue strip leaves out a waiting notice and keeps the member's message", () => {
  setApiShim(async () => undefined);
  try {
    const both = textWith([NOTICE, MEMBER]);
    expect(both).toContain("MEMBER-LINE");
    expect(both).not.toContain("NOTICE-LINE");
    // The strip counts what it shows: the same as with the member's message
    // alone.
    expect(both).toBe(textWith([MEMBER]));
    // A notice alone leaves no strip at all.
    expect(textWith([NOTICE])).toBe(textWith([]));
  } finally {
    setApiShim(null);
  }
});

// A queued message's text is lost when it is removed, with no Undo (task
// c6589760): its remove button asks first.
it("removing a queued message arms on the first click and sends nothing; the second removes that message once", async () => {
  const deletes: string[] = [];
  setApiShim(async (method, path) => {
    if (method === "DELETE") deletes.push(path);
    return undefined;
  });
  const OTHER: QueuedMessage = { ...MEMBER, id: "q3", text: "OTHER-LINE" };
  const withQueue: AgentInfo = { ...agent, queue: [MEMBER, OTHER] };
  const view = render(
    onLanguage(
      "en",
      createElement(LogView, {
        agent: withQueue,
        logs: [],
        onBack: () => {},
        onEditAgent: () => {},
      }),
      { agents: [withQueue], hasReceivedInitialState: true, connected: true },
    ),
  );
  // The one button in the chip that holds the message.
  const removeOf = (text: string) => {
    const buttons = [
      ...view.container.querySelectorAll<HTMLElement>("button"),
    ].filter((b) => {
      const chip = b.parentElement;
      return (
        !!chip?.textContent?.includes(text) &&
        !chip.textContent.includes(
          text === "MEMBER-LINE" ? "OTHER-LINE" : "MEMBER-LINE",
        )
      );
    });
    expect(buttons).toHaveLength(1);
    return buttons[0];
  };
  try {
    await act(async () => fireEvent.click(removeOf("MEMBER-LINE")));
    expect(deletes).toEqual([]);
    expect(removeOf("MEMBER-LINE").hasAttribute("data-confirm-armed")).toBe(
      true,
    );
    expect(removeOf("OTHER-LINE").hasAttribute("data-confirm-armed")).toBe(
      false,
    );
    await act(async () => fireEvent.click(removeOf("MEMBER-LINE")));
    expect(deletes).toEqual(["/api/agents/a1/queue/q2"]);
  } finally {
    view.unmount();
    setApiShim(null);
  }
});
