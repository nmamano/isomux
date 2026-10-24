// A Codex agent with no stored codexSandbox runs with full access (the Codex
// adapter's default). The edit dialog shows that, and a Save that does not
// touch the sandbox sends none, so a name edit does not write a sandbox and
// replace the session (task 375b000e).
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const {
  claudeAgent,
  renameAndSave,
  renderEdit,
  selectWith,
  settle,
  shimRequests,
} = await import("../test-support/claude-limits-fixture.tsx");
const { CODEX_MODELS } = await import("../../shared/types.ts");
type AgentInfo = import("../../shared/types.ts").AgentInfo;

function codexAgentWithoutSandbox(): AgentInfo {
  const agent: AgentInfo = {
    ...claudeAgent(CODEX_MODELS[0].value, "never", []),
    agentType: "codex",
  };
  delete agent.codexSandbox;
  return agent;
}

const sandboxSelect = (container: HTMLElement) =>
  selectWith(container, "workspace-write");

async function switchEngine(container: HTMLElement, engine: string) {
  const select = container.querySelector(
    ".agent-engine-control select",
  ) as HTMLSelectElement;
  await act(async () => {
    fireEvent.change(select, { target: { value: engine } });
  });
  await settle();
}

describe("edit dialog: Codex agent with no stored sandbox", () => {
  it("shows full access, and a name-only Save sends no sandbox", async () => {
    const patches = shimRequests();
    const agent = codexAgentWithoutSandbox();
    expect("codexSandbox" in agent).toBe(false);
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      expect(sandboxSelect(view.container).value).toBe("danger-full-access");
      await renameAndSave(view.container);
      expect(patches).toEqual([{ name: "Renamed" }]);
    } finally {
      view.unmount();
    }
  });

  it("shows full access again after a switch to Claude and back, and Save sends no sandbox", async () => {
    const patches = shimRequests();
    const agent = codexAgentWithoutSandbox();
    expect("codexSandbox" in agent).toBe(false);
    const { view } = renderEdit(agent, []);
    try {
      await settle();
      await switchEngine(view.container, "claude");
      expect(
        [...view.container.querySelectorAll("select")].some((select) =>
          [...select.options].some((o) => o.value === "workspace-write"),
        ),
      ).toBe(false);
      await switchEngine(view.container, "codex");
      expect(sandboxSelect(view.container).value).toBe("danger-full-access");
      await renameAndSave(view.container);
      expect(patches).toEqual([{ name: "Renamed" }]);
    } finally {
      view.unmount();
    }
  });
});
