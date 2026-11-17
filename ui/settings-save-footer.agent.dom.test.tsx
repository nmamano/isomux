// One save footer for every Settings part that saves (task f0d50877): an
// agent's parts. They opened with Save enabled before anything changed; now
// they act like every part (ui/test-support/save-footer-contract.ts). Its own
// file: an agent page mount costs most of a DOM file's time cap.

import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent } = await import("@testing-library/react");
const { setApiShim } = await import("./api.ts");
const { selfUserRecord } = await import("./test-support/language-fixture.tsx");
const { claudeAgent } =
  await import("./test-support/claude-limits-fixture.tsx");
const {
  expectFooterPlacement,
  expectSaveCycle,
  mountSettingsAt,
  settle,
  shimItemApi,
} = await import("./test-support/save-footer-contract.ts");

afterAll(() => setApiShim(null));

const OWNER = { ...selfUserRecord(null), id: "owner", name: "Owner" };
const AGENT = claudeAgent("opus", "default", []);

it("an agent's part: opens with nothing to save, and saves, edits and cancels like every part", async () => {
  shimItemApi();
  const { view, update } = mountSettingsAt(
    { kind: "agent", agentId: AGENT.id, part: "general" },
    { users: [OWNER], agents: [AGENT] },
  );
  await settle();
  const name = () =>
    view.container.querySelector<HTMLInputElement>(
      ".agent-identity-section input",
    )!;
  expect(name().value).toBe(AGENT.name);
  expectFooterPlacement(view.container);
  await expectSaveCycle({
    root: view.container,
    value: () => name().value,
    edit: async (step) => {
      await act(async () => {
        fireEvent.change(name(), { target: { value: `Agent ${step}` } });
      });
    },
    // Cancel on an agent rebuilds the form from the record, so the record
    // must hold the saved name, as the server's event makes it.
    broadcast: () => update({ agents: [{ ...AGENT, name: "Agent 1" }] }),
  });
  view.unmount();
});
