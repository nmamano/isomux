// A new agent on the access slider (task e77304b1, merge B): a stop below
// Standard goes in the spawn itself, Privileged is one PUT /access after it,
// and a Codex agent cannot take a stop below Standard.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const { AGENT_PACK_PRESETS } = await import("../../shared/agent-access.ts");
const {
  BELOW,
  cleanup,
  pick,
  renderSpawn,
  route,
  save,
  settle,
  shim,
  stopRadio,
} = await import("../test-support/access-slider-fixture.tsx");
type AgentAccess = import("../../shared/agent-access.ts").AgentAccess;

describe("a new agent", () => {
  it("goes below Standard in the spawn itself, and to Privileged with one PUT /access after it", async () => {
    const cases: Array<[AgentAccess, Record<string, unknown>, string[]]> = [
      [
        "office",
        { access: "office", pack: AGENT_PACK_PRESETS.asksOnly },
        ["POST /api/agents"],
      ],
      ["privileged", {}, ["POST /api/agents", "PUT :id/access"]],
    ];
    for (const [stop, fields, order] of cases) {
      const calls = shim();
      const view = renderSpawn();
      try {
        await settle();
        await pick(view.container, stop);
        await save(view.container);
        expect({ stop, order: calls.map(route) }).toEqual({ stop, order });
        const post = calls[0].body as Record<string, unknown>;
        expect({
          stop,
          access: post.access ?? "standard",
          pack: post.pack,
        }).toEqual({
          stop,
          access: (fields.access as string | undefined) ?? "standard",
          pack: fields.pack,
        });
        if (stop === "privileged")
          expect(calls[1].body).toEqual({ access: "privileged" });
      } finally {
        cleanup(view);
      }
    }
  });

  it("a new Codex agent has the stops below Standard disabled, and a stop below Standard the Codex card", async () => {
    shim();
    const view = renderSpawn();
    try {
      await settle();
      expect(stopRadio(view.container, "office").disabled).toBe(false);
      const codex = [
        ...view.container.querySelectorAll<HTMLButtonElement>(
          ".spawn-engine-options button",
        ),
      ].find((b) => b.textContent?.startsWith("Codex"))!;
      expect(codex.disabled).toBe(false);
      await pick(view.container, "office");
      expect(codex.disabled).toBe(true);
      await pick(view.container, "standard");
      expect(codex.disabled).toBe(false);
      await act(async () => {
        fireEvent.click(codex);
      });
      for (const stop of BELOW)
        expect({
          stop,
          disabled: stopRadio(view.container, stop).disabled,
        }).toEqual({
          stop,
          disabled: true,
        });
    } finally {
      cleanup(view);
    }
  });
});
