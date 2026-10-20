// Task 1b8084fd: the chat header has one topic slot. With a user message it
// shows the label or a placeholder, both editable, then the refresh button,
// which spins and is disabled while a generation runs. A blank chat shows
// neither.
import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, StoreProvider, useAppState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
const { setShim, connect } = await import("../ws.ts");
setShim(() => {});
afterAll(() => {
  connect(
    () => {},
    () => {},
  );
  setShim(null);
  setApiShim(null);
});
type AgentInfo = import("../../shared/types.ts").AgentInfo;
type LogEntry = import("../../shared/types.ts").LogEntry;

function agentWith(fields: {
  topic: string | null;
  topicGenerating?: boolean;
  topicGen?: boolean;
}): AgentInfo {
  return {
    id: "a1",
    name: "Tester",
    desk: 0,
    roomId: "r1",
    cwd: "~",
    state: "waiting_for_response",
    agentType: "codex",
    modelFamily: "gpt-6-astra",
    topic: fields.topic,
    topicGenerating: fields.topicGenerating ?? false,
    capabilities: { edit: true, topicGen: fields.topicGen ?? true },
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
}

const userMessage: LogEntry = {
  id: "msg-1",
  agentId: "a1",
  timestamp: 1,
  kind: "user_message",
  content: "hello",
};

function Page({ agent, logs }: { agent: AgentInfo; logs: LogEntry[] }) {
  const state = useAppState();
  return (
    <StateCtx.Provider value={state}>
      <LogView
        agent={agent}
        logs={logs}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
}

const calls: { method: string; path: string; body: unknown }[] = [];

async function show(agent: AgentInfo, logs: LogEntry[]) {
  calls.length = 0;
  setApiShim(async (method, path, body) => {
    calls.push({ method, path, body });
    return { counts: {} };
  });
  const view = render(
    <StoreProvider>
      <Page agent={agent} logs={logs} />
    </StoreProvider>,
  );
  const text = () =>
    view.container.querySelector<HTMLElement>("[data-topic-text]");
  const refresh = () =>
    view.container.querySelector<HTMLButtonElement>("[data-topic-refresh]");
  const done = async () => {
    // Let pending effects settle before the DOM goes away.
    await act(async () => {});
    view.unmount();
  };
  return { view, text, refresh, done };
}

const topicCalls = () => calls.filter((c) => c.path === "/api/agents/a1/topic");

it("shows a placeholder and a refresh when a chat has no topic", async () => {
  const { text, refresh, done } = await show(agentWith({ topic: null }), [
    userMessage,
  ]);
  expect(text()?.dataset.topicText).toBe("placeholder");
  expect(refresh()?.disabled).toBe(false);
  fireEvent.click(refresh()!);
  expect(topicCalls()).toEqual([
    { method: "DELETE", path: "/api/agents/a1/topic", body: undefined },
  ]);
  await done();
});

it("shows no topic slot on a blank chat", async () => {
  const { text, refresh, done } = await show(agentWith({ topic: null }), []);
  expect(text()).toBe(null);
  expect(refresh()).toBe(null);
  await done();
});

it("keeps the label and disables the refresh while a generation runs", async () => {
  const labelled = await show(
    agentWith({ topic: "Earlier label", topicGenerating: true }),
    [userMessage],
  );
  expect(labelled.text()?.dataset.topicText).toBe("label");
  expect(labelled.text()?.textContent).toBe("Earlier label");
  expect(labelled.refresh()?.disabled).toBe(true);
  await labelled.done();

  // With no label, the spinning refresh takes the placeholder's place.
  const empty = await show(agentWith({ topic: null, topicGenerating: true }), [
    userMessage,
  ]);
  expect(empty.text()).toBe(null);
  expect(empty.refresh()?.disabled).toBe(true);
  await empty.done();
});

it("keeps the placeholder editable on a backend that cannot generate topics", async () => {
  const { text, refresh, done } = await show(
    agentWith({ topic: null, topicGen: false }),
    [userMessage],
  );
  expect(text()?.dataset.topicText).toBe("placeholder");
  expect(refresh()).toBe(null);
  await done();
});

it("sends an emptied label as a blank topic, and nothing for an untouched placeholder", async () => {
  const labelled = await show(agentWith({ topic: "Old label" }), [userMessage]);
  fireEvent.click(labelled.text()!);
  const input = labelled.view.container.querySelector("input")!;
  fireEvent.change(input, { target: { value: "  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(topicCalls()).toEqual([
    { method: "PUT", path: "/api/agents/a1/topic", body: { topic: "" } },
  ]);
  await labelled.done();

  const empty = await show(agentWith({ topic: null }), [userMessage]);
  fireEvent.click(empty.text()!);
  fireEvent.keyDown(empty.view.container.querySelector("input")!, {
    key: "Enter",
  });
  expect(topicCalls()).toEqual([]);
  await empty.done();
});
