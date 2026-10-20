// The server records an agent's sends in its own log (agent_outbound,
// api_token_outbound) for search and summaries. The chat shows neither: the
// curl card of the same tool call is the view (Nil, 2026-09-07). A hidden
// record must also not take the turn's copy button, since a scheduled send is
// recorded when it fires, often as the last entry of a turn.

import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { LogView } = await import("./LogView.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim } = await import("../api.ts");

type LogEntry = import("../../shared/types.ts").LogEntry;
type AgentInfo = import("../../shared/types.ts").AgentInfo;
const agent = {
  id: "a1",
  name: "Worker",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
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
  queue: [],
  pendingPrompt: null,
  contextUsage: null,
  capabilities: { edit: true },
} as unknown as AgentInfo;
setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
let copied: string[] = [];
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});
afterEach(() => {
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function entry(
  id: string,
  kind: LogEntry["kind"],
  content: string,
  metadata?: LogEntry["metadata"],
): LogEntry {
  return { id, agentId: agent.id, timestamp: 1, kind, content, metadata };
}

const AGENT_SENT = "AGENT-SENT verdict body";
const TOKEN_SENT = "TOKEN-SENT report body";
const turn: LogEntry[] = [
  entry("u1", "user_message", "Please send the verdict."),
  entry("c1", "tool_call", "Bash", {
    toolId: "t1",
    input: { command: "echo sending" },
  }),
  entry("o1", "agent_outbound", AGENT_SENT, {
    recipient_agent_id: "a2",
    recipient_agent_name: "Reviewer",
  }),
  entry("r1", "tool_result", "sent", { toolUseId: "t1" }),
  entry("x1", "text", "Sent it."),
  // Last in the turn, as a scheduled send that fires after the reply.
  entry("o2", "api_token_outbound", TOKEN_SENT, {
    recipient_api_token_name: "Laptop",
  }),
];
const visible = turn.filter(
  (e) => e.kind !== "agent_outbound" && e.kind !== "api_token_outbound",
);

const mount = (logs: LogEntry[]) =>
  render(
    onLanguage(
      null,
      createElement(LogView, { agent, logs, onBack() {}, onEditAgent() {} }),
      {
        agents: [agent],
        rooms: [
          { id: "r1", name: "Room", prompt: null, canCloseWhenEmpty: true },
        ],
        hasReceivedInitialState: true,
        connected: true,
        isMobile: false,
      },
    ),
  );

it("shows no card for an agent's recorded sends, and the turn copy skips them", async () => {
  const control = mount(visible);
  const controlCopies = control.container.querySelectorAll(".copy-btn").length;
  control.unmount();
  // The control turn has its copy button.
  expect(controlCopies).toBeGreaterThan(0);

  const view = mount(turn);
  const text = view.container.textContent ?? "";
  expect(text).toContain("Sent it.");
  expect(text).not.toContain(AGENT_SENT);
  expect(text).not.toContain(TOKEN_SENT);
  // The turn's copy button stays on the reply, not on a hidden record.
  const copies = view.container.querySelectorAll(".copy-btn");
  expect(copies.length).toBe(controlCopies);

  await act(async () => {
    fireEvent.click(copies[copies.length - 1]);
  });
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain("Sent it.");
  expect(copied[0]).not.toContain(AGENT_SENT);
  expect(copied[0]).not.toContain(TOKEN_SENT);
});
