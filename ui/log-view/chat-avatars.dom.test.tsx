import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { DispatchCtx } = await import("../store.tsx");
const { onLanguage, selfUserRecord } =
  await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type Action = Parameters<
  ReturnType<typeof import("../store.tsx").useDispatch>
>[0];

const outfit = {
  color: "#4A90D9",
  hair: "#222",
  hairStyle: "short",
  skin: "#FFD5B8",
  beard: "none",
  accessory: "none",
  hat: "none",
};
const agentInfo = (id: string, name: string) =>
  ({
    id,
    name,
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "idle",
    agentType: "claude",
    modelFamily: "opus",
    topic: null,
    outfit,
    queue: [],
    pendingPrompt: null,
    contextUsage: null,
    capabilities: { edit: true },
  }) as unknown as AgentInfo;
const agent = agentInfo("a1", "Worker");
const peer = agentInfo("a2", "Dwight");
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

// The viewer is "Tester" (language-fixture); "Stephen" is another member.
const stephen = { ...selfUserRecord(null), id: "u2", name: "Stephen" };
const selfName = selfUserRecord(null).name;

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  metadata: LogEntry["metadata"] = {},
): LogEntry {
  return { id, agentId: agent.id, timestamp: 1, kind, content, metadata };
}

function mount(logs: LogEntry[], agents: AgentInfo[], actions: Action[]) {
  const element = onLanguage(
    null,
    createElement(LogView, { agent, logs, onBack() {}, onEditAgent() {} }),
    {
      agents,
      users: new Map([
        [selfName.toLowerCase(), selfUserRecord(null)],
        ["stephen", stephen],
      ]),
      rooms: [
        { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
      ],
      hasReceivedInitialState: true,
      connected: true,
    },
  );
  return createElement(
    DispatchCtx.Provider,
    { value: (action: Action) => actions.push(action) },
    element,
  );
}

// The message bubble or card that holds `text`.
function cardOf(text: string, selector: string): Element {
  const node = [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(text),
  );
  if (!node) throw new Error(`no ${selector} holds ${text}`);
  return node;
}

describe("avatars and agent links in the chat", () => {
  it("shows a member's avatar on their messages but not on the viewer's own", () => {
    const logs = [
      entry("m1", "user_message", "From Stephen", { username: "Stephen" }),
      entry("m2", "user_message", "From me", { username: selfName }),
    ];
    const view = render(mount(logs, [agent, peer], []));
    const card = (text: string) =>
      view.getByText(text).closest("div[style*='border-left']")!;
    expect(
      card("From Stephen").querySelectorAll("[data-chat-avatar]"),
    ).toHaveLength(1);
    expect(card("From me").querySelectorAll("[data-chat-avatar]")).toHaveLength(
      0,
    );
  });

  it("puts an agent's message on one compact row whose name opens that agent while it exists", () => {
    const logs = [
      entry("p1", "user_message", "Same raccoon.", {
        sender_agent_id: peer.id,
        sender_agent_name: peer.name,
        sender_agent_room: "Room",
      }),
    ];
    const actions: Action[] = [];
    const view = render(mount(logs, [agent, peer], actions));
    const row = cardOf("Same raccoon.", "[data-peer-message]");
    expect(row.querySelectorAll("[data-chat-avatar]")).toHaveLength(1);
    const link = view.getByRole("link", { name: peer.name });
    expect(row.contains(link)).toBe(true);
    fireEvent.click(link);
    expect(actions).toEqual([{ type: "focus", agentId: peer.id }]);

    // The sender is gone: its name stays, as plain text without an avatar.
    view.rerender(mount(logs, [agent], actions));
    const gone = cardOf("Same raccoon.", "[data-peer-message]");
    expect(view.queryByRole("link", { name: peer.name })).toBeNull();
    expect(gone.textContent).toContain(peer.name);
    expect(gone.querySelectorAll("[data-chat-avatar]")).toHaveLength(0);
  });

  it("shows a sent message's text on its card's row, and the receiver's name opens the receiver, not the card", () => {
    const command =
      "curl -s -X POST localhost:4000/api/agents/a2/messages -H \"Authorization: Bearer $ISOMUX_AGENT_TOKEN\" -H 'Content-Type: text/plain' -o /tmp/reply.json --data-binary @- <<'EOF'\nIs it the same raccoon?\nEOF";
    const logs = [
      entry("t1", "tool_call", "Bash", {
        toolId: "tool-1",
        input: { command },
      }),
      entry("t2", "tool_result", '{"ok":true}', { toolUseId: "tool-1" }),
    ];
    const actions: Action[] = [];
    const view = render(mount(logs, [agent, peer], actions));
    const text = document.querySelector("[data-message-text]")!;
    expect(text.textContent).toBe("Is it the same raccoon?");
    const card = text.closest("button")!;
    expect(card.querySelectorAll("[data-chat-avatar]")).toHaveLength(1);
    // The text is not repeated as a field; the output file still shows.
    expect(card.textContent?.split("Is it the same raccoon?")).toHaveLength(2);
    expect(card.textContent).toContain("/tmp/reply.json");

    fireEvent.click(view.getByRole("link", { name: peer.name }));
    expect(actions).toEqual([{ type: "focus", agentId: peer.id }]);
    expect(document.body.textContent).not.toContain("curl -s -X POST");
    // The rest of the row still opens the card.
    fireEvent.click(text);
    expect(document.body.textContent).toContain("curl -s -X POST");
  });
});
