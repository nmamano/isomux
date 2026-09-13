import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { LogView } = await import("./LogView.tsx");
const { StateCtx, initialState } = await import("../store.tsx");
const { setApiShim } = await import("../api.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

setApiShim(async () => ({ counts: {} }));
afterAll(() => setApiShim(null));

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

it("opens the grouped skills menu from a leading slash draft and preserves it on Escape", () => {
  const state = {
    ...initialState,
    drafts: new Map([[agent.id, "/ver"]]),
    slashCommands: new Map([
      [
        agent.id,
        {
          commands: [{ name: "clear", autoRun: true }],
          skills: [{ name: "verify", origin: "user" as const }],
        },
      ],
    ]),
  };
  const page = (draft: string) => (
    <StateCtx.Provider
      value={{ ...state, drafts: new Map([[agent.id, draft]]) }}
    >
      <LogView
        agent={agent}
        logs={[]}
        onBack={() => {}}
        onEditAgent={() => {}}
      />
    </StateCtx.Provider>
  );
  const view = render(page("/ver"));
  const textarea = view.container.querySelector("textarea")!;
  expect(textarea.value).toBe("/ver");
  expect(view.getByText("Member") !== null).toBe(true);
  expect(view.getByText("/verify") !== null).toBe(true);
  expect(view.container.querySelector('input[placeholder]') === null).toBe(
    true,
  );
  fireEvent.keyDown(textarea, { key: "Escape" });
  expect(textarea.value).toBe("/ver");
  expect(view.queryByText("/verify") === null).toBe(true);
  fireEvent.change(textarea, { target: { value: "/veri" } });
  expect(view.queryByText("/verify") === null).toBe(true);
  fireEvent.change(textarea, { target: { value: "" } });
  view.rerender(page(""));
  fireEvent.change(textarea, { target: { value: "/" } });
  view.rerender(page("/"));
  expect(view.getByText("/verify") !== null).toBe(true);

  fireEvent.change(textarea, { target: { value: "/verify arg" } });
  view.rerender(page("/verify arg"));
  expect(view.queryByText("/verify") === null).toBe(true);
});
