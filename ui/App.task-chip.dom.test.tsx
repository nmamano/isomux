import { afterAll, beforeEach, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { App } = await import("./App.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
type AgentInfo = import("../shared/types.ts").AgentInfo;
type TaskItem = import("../shared/types.ts").TaskItem;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));
beforeEach(() => window.history.replaceState(null, "", "/"));

const agent = {
  id: "a1",
  name: "Tester",
  desk: 0,
  roomId: "r1",
  cwd: "~",
  state: "idle",
  agentType: "claude",
  modelFamily: "opus",
  topic: null,
  capabilities: {},
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

const task = {
  id: "ce5e7fe0",
  title: "Task hashes open the correct board detail",
  priority: "P0",
  status: "done",
  createdBy: "Nil",
  username: "Nil",
  createdAt: 1,
  roomId: "r2",
} as TaskItem;

it("opens a visible task chip in an unfiltered board detail", async () => {
  const state = {
    ...initialState,
    agents: [agent],
    focusedAgentId: agent.id,
    currentRoomId: "r1",
    rooms: [
      { id: "r1", name: "One" },
      { id: "r2", name: "Two" },
    ],
    tasks: [task],
    tasksLoaded: true,
    logs: new Map([
      [
        agent.id,
        [
          {
            id: "u1",
            agentId: agent.id,
            kind: "user_message" as const,
            content: `please handle ${task.id}`,
            timestamp: 1,
          },
          {
            id: "t1",
            agentId: agent.id,
            kind: "text" as const,
            content: `Working on ${task.id}`,
            timestamp: 2,
          },
        ],
      ],
    ]),
  } as unknown as typeof initialState;
  const view = render(
    createElement(
      StateCtx.Provider,
      { value: state },
      createElement(App),
    ),
  );
  const chips = view.getAllByRole("button", {
    name: "P0 - Task hashes open the…",
  });
  expect(chips).toHaveLength(2);
  await act(async () => fireEvent.click(chips[0]));

  expect(window.location.pathname).toBe("/tasks");
  const scope = view.container.querySelector(
    'select:has(option[value="global"])',
  ) as HTMLSelectElement;
  const status = view.container.querySelector(
    'select:has(option[value="active"])',
  ) as HTMLSelectElement;
  expect(scope.value).toBe("r2");
  expect(status.value).toBe("all");
  expect(
    view.container.querySelector<HTMLInputElement>(
      `input[value="${task.title}"]`,
    ) !== null,
  ).toBe(true);

  await act(async () =>
    fireEvent.keyDown(document.body, { key: "t", bubbles: true }),
  );
  await act(async () =>
    fireEvent.keyDown(document.body, { key: "t", bubbles: true }),
  );
  expect(
    view.container.querySelector<HTMLInputElement>(
      `input[value="${task.title}"]`,
    ) === null,
  ).toBe(true);
  const reopenedStatus = view.container.querySelector(
    'select:has(option[value="active"])',
  ) as HTMLSelectElement;
  expect(reopenedStatus.value).toBe("active");

});
