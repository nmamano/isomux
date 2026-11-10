// A new agent on the access slider (task e77304b1, merge B): a stop below
// Standard goes in the spawn itself, Privileged is one PUT /access after it,
// and a Codex agent takes one only on its proven model.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { act, fireEvent } = await import("@testing-library/react");
const {
  BELOW,
  cleanup,
  pick,
  renderSpawn,
  route,
  save,
  settle,
  shim,
  stopChecked,
  stopDisabled,
} = await import("../test-support/access-slider-fixture.tsx");
type AgentAccess = import("../../shared/agent-access.ts").AgentAccess;

describe("a new agent", () => {
  it("goes below Standard in the spawn itself, and to Privileged with one PUT /access after it", async () => {
    const cases: Array<[AgentAccess, Record<string, unknown>, string[]]> = [
      // The spawn carries the stop alone (task 82da687b: no pack).
      ["office", { access: "office" }, ["POST /api/agents"]],
      ["web", { access: "web" }, ["POST /api/agents"]],
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
          pack: "pack" in post,
        }).toEqual({
          stop,
          access: (fields.access as string | undefined) ?? "standard",
          pack: false,
        });
        if (stop === "privileged")
          expect(calls[1].body).toEqual({ access: "privileged" });
      } finally {
        cleanup(view);
      }
    }
  });

  // Codex runs every stop below Standard on gpt-5.5 only (engineRunsAccess).
  it("a new Codex agent on its default model has the stops below Standard disabled; the Codex card stays open at every stop", async () => {
    shim();
    const view = renderSpawn();
    try {
      await settle();
      expect(stopDisabled(view.container, "office")).toBe(false);
      const codex = codexCard(view.container);
      expect(codex.disabled).toBe(false);
      for (const stop of ["office", "folder", "web"] as const) {
        await pick(view.container, stop);
        expect({ stop, disabled: codex.disabled }).toEqual({
          stop,
          disabled: false,
        });
      }
      await pick(view.container, "standard");
      expect(codex.disabled).toBe(false);
      await act(async () => {
        fireEvent.click(codex);
      });
      await settle();
      for (const stop of BELOW)
        expect({
          stop,
          disabled: stopDisabled(view.container, stop),
        }).toEqual({
          stop,
          disabled: true,
        });
    } finally {
      cleanup(view);
    }
  });

  it("Codex picked at office lands on the proven model and keeps every stop below Standard", async () => {
    const calls = shim();
    const view = renderSpawn();
    try {
      await settle();
      await pick(view.container, "office");
      await act(async () => {
        fireEvent.click(codexCard(view.container));
      });
      await settle();
      expect(stopChecked(view.container, "office")).toBe(true);
      expect(
        Object.fromEntries(
          BELOW.map((stop) => [stop, stopDisabled(view.container, stop)]),
        ),
      ).toEqual({ chat: false, office: false, folder: false, web: false });
      await save(view.container);
      const spawn = calls.find(
        (c) => c.method === "POST" && c.path === "/api/agents",
      );
      expect(spawn?.body).toMatchObject({
        agentType: "codex",
        modelFamily: "gpt-5.5",
        access: "office",
      });
    } finally {
      cleanup(view);
    }
  });
});

function codexCard(container: HTMLElement): HTMLButtonElement {
  const card = [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".spawn-engine-options button",
    ),
  ].find((b) => b.textContent?.startsWith("Codex"));
  if (!card) throw new Error("no Codex card");
  return card;
}
