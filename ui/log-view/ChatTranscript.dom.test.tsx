import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { renderHook } = await import("@testing-library/react");
const { useChatTranscript } = await import("./ChatTranscript.tsx");

it("groups settled calls, preserves a live tail, and puts turn actions on the last visible entry", () => {
  const logs: import("../../shared/types.ts").LogEntry[] = [
    {
      id: "u",
      agentId: "a",
      timestamp: 0,
      kind: "user_message",
      content: "request",
    },
    {
      id: "c1",
      agentId: "a",
      timestamp: 1,
      kind: "tool_call",
      content: "Bash",
      metadata: { toolId: "t1", input: { command: "pwd" } },
    },
    {
      id: "r1",
      agentId: "a",
      timestamp: 2,
      kind: "tool_result",
      content: "one",
      metadata: { toolUseId: "t1" },
    },
    {
      id: "c2",
      agentId: "a",
      timestamp: 3,
      kind: "tool_call",
      content: "Bash",
      metadata: { toolId: "t2", input: { command: "ls" } },
    },
    {
      id: "r2",
      agentId: "a",
      timestamp: 4,
      kind: "tool_result",
      content: "two",
      metadata: { toolUseId: "t2" },
    },
  ];
  const view = renderHook(({ busy }) => useChatTranscript(logs, busy), {
    initialProps: { busy: false },
  });
  expect([...view.result.current.rawToolGroupByFirstId.keys()]).toEqual(["c1"]);
  expect([...view.result.current.groupedChildIds]).toEqual(["c2"]);
  expect(view.result.current.turnData.get("c1")?.isLastInTurn).toBe(true);
  expect(view.result.current.turnData.get("r2")?.isLastInTurn).toBe(false);
  expect(view.result.current.turnData.get("u")?.isLastInTurn).toBe(false);
  view.rerender({ busy: true });
  expect(view.result.current.rawToolGroupByFirstId.size).toBe(0);
  expect(view.result.current.turnData.get("c2")?.isLastInTurn).toBe(true);
  expect(view.result.current.turnData.get("r2")?.isLastInTurn).toBe(false);
});
