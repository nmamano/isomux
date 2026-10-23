// An OpenCode turn that a model change fixes, and a model OpenCode no longer
// lists (task 73951c9f): the failed line and the header open the agent
// settings with the model picker, the same dialog the header's name opens.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
import { DEFAULT_AGENT_CAPABILITIES } from "../../shared/types.ts";

setUpDomTestFile();
const { fireEvent, render } = await import("@testing-library/react");
const { createElement } = await import("react");
const { StoreProvider } = await import("../store.tsx");
const { LogView } = await import("./LogView.tsx");
const { setShim, connect } = await import("../ws.ts");
const { setApiShim } = await import("../api.ts");
setShim(() => {});
setApiShim(async () => ({}));
afterAll(() => {
  setApiShim(null);
  setShim(() => {});
  connect(
    () => {},
    () => {},
  );
});

type Agent = Parameters<typeof LogView>[0]["agent"];
const GONE = "opencode/removed-model";

function agent(extra: Partial<Agent> = {}): Agent {
  return {
    id: "pick-model-agent",
    name: "Receptionist",
    userId: "owner",
    username: "Owner",
    agentType: "opencode",
    roomId: "lobby",
    cwd: "/tmp",
    state: "error",
    permissionMode: "default",
    modelFamily: GONE,
    effort: "high",
    topic: null,
    sessionId: null,
    customPrompt: null,
    outfit: {},
    capabilities: DEFAULT_AGENT_CAPABILITIES,
    ...extra,
  } as unknown as Agent;
}

function mount(a: Agent, metadata: Record<string, unknown>[]) {
  let edits = 0;
  const logs = metadata.map((meta, i) => ({
    id: `entry-${i}`,
    agentId: a.id,
    timestamp: Date.now() + i,
    kind: "error" as const,
    content: "OpenCode no longer lists this model.",
    metadata: meta,
  }));
  const view = render(
    createElement(StoreProvider, {
      children: createElement(LogView, {
        agent: a,
        logs,
        onBack: () => {},
        onEditAgent: () => {
          edits++;
        },
      }),
    }),
  );
  return { view, edits: () => edits };
}

describe("the model picker under a failed turn", () => {
  it("shows under each entry that asks for it, and opens the agent settings", () => {
    const { view, edits } = mount(agent(), [
      { pickModel: true },
      {},
      { pickModel: true },
    ]);
    const buttons = view.container.querySelectorAll("[data-pick-model]");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].tagName).toBe("BUTTON");
    fireEvent.click(buttons[1]);
    expect(edits()).toBe(1);
  });
});

describe("the gone-model mark in the header", () => {
  it("shows while the agent carries a gone model, names it, and opens the agent settings", () => {
    const { view, edits } = mount(agent({ goneModel: GONE }), []);
    const marks = view.container.querySelectorAll("[data-gone-model]");
    expect(marks.length).toBeGreaterThan(0);
    const mark = marks[0];
    expect(mark.getAttribute("title") ?? "").toContain(GONE);
    // An SVG, not a glyph: iOS draws glyphs through the emoji font.
    expect(mark.querySelector("svg")).not.toBeNull();
    fireEvent.click(mark);
    expect(edits()).toBe(1);
  });

  it("is absent without a gone model", () => {
    const { view } = mount(agent(), []);
    // The header is up: the agent's name is there.
    expect(view.getAllByText("Receptionist").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll("[data-gone-model]")).toHaveLength(
      0,
    );
  });
});

// OpenCode reports no subscription usage. The pill draws a "?" without a
// reading, so the header leaves it out for OpenCode instead.
describe("the subscription pill in the header", () => {
  it("shows for Claude and not for OpenCode", () => {
    const pills = (a: Agent) => {
      const { view } = mount(a, []);
      const count = view.container.querySelectorAll(
        '[data-testid="subscription-pill"]',
      ).length;
      view.unmount();
      return count;
    };
    expect(pills(agent({ agentType: "claude" }))).toBe(1);
    expect(pills(agent())).toBe(0);
  });
});
