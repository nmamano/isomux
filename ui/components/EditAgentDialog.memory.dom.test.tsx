// The agent settings' memory box (tasks bf94d714, 39b2c176), on the page's
// Instructions and memory section (task 59538509): whoever can edit the
// agent's instructions also edits its memory, whether or not they manage the
// agent.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { setApiShim } = await import("../api.ts");
const { agentAt, cleanup, renderEdit, settle, viewer } =
  await import("../test-support/access-slider-fixture.tsx");
const { RECORDING_PRIVATE_ATTR } = await import("../recording-mode.ts");

const NOTE = "- Peer, 2026-11-04: the agent's note";

function memoryBox(container: HTMLElement): HTMLTextAreaElement {
  const box = container.querySelector<HTMLTextAreaElement>(
    ".agent-memory-field textarea",
  );
  if (!box) throw new Error("no memory box");
  return box;
}

describe("the agent dialog's memory box", () => {
  it("shows the memory to every viewer, and lets each one edit it, a member who does not manage the agent too", async () => {
    // The fixture agent's manager is the member "member".
    const viewers = {
      owner: viewer([]),
      manager: {
        ...viewer([]),
        userId: "member",
        username: "Member",
        role: "member" as const,
      },
      peer: {
        ...viewer([]),
        userId: "peer",
        username: "Peer",
        role: "member" as const,
      },
    };
    const seen: Record<string, { value: string; readOnly: boolean }> = {};
    for (const [who, sessionContext] of Object.entries(viewers)) {
      setApiShim(async (_method, path) => {
        if (path.startsWith("/api/memory"))
          return { text: NOTE, version: "v1", size: NOTE.length, cap: 5000 };
        if (path === "/api/me/rooms") return { rooms: [] };
        if (path === "/api/validate/cwd") return { ok: true };
        if (path.includes("/sessions"))
          return { sessions: [], currentSessionId: null };
        if (path.startsWith("/api/backends/")) return { models: [] };
        return {};
      });
      const view = renderEdit(
        agentAt("standard"),
        () => {},
        sessionContext,
        "instructions",
      );
      try {
        await settle();
        await settle();
        const box = memoryBox(view.container);
        seen[who] = { value: box.value, readOnly: box.readOnly };
      } finally {
        cleanup(view);
      }
    }
    expect(seen).toEqual({
      owner: { value: NOTE, readOnly: false },
      manager: { value: NOTE, readOnly: false },
      peer: { value: NOTE, readOnly: false },
    });
  });

  // Task 1a5c9478: recording mode blurs memory and instructions until a
  // click, whatever they hold. Each field names its own scope, with the
  // agent's id, so a reveal does not carry over to another agent or field.
  it("marks the memory and the instructions as private, each with its own scope", async () => {
    setApiShim(async (_method, path) => {
      if (path.startsWith("/api/memory"))
        return { text: NOTE, version: "v1", size: NOTE.length, cap: 5000 };
      if (path === "/api/me/rooms") return { rooms: [] };
      if (path === "/api/validate/cwd") return { ok: true };
      if (path.includes("/sessions"))
        return { sessions: [], currentSessionId: null };
      if (path.startsWith("/api/backends/")) return { models: [] };
      return {};
    });
    const agent = agentAt("standard");
    const view = renderEdit(agent, () => {}, viewer([]), "instructions");
    try {
      await settle();
      await settle();
      const memory = memoryBox(view.container).getAttribute(
        RECORDING_PRIVATE_ATTR,
      );
      const instructions = [
        ...view.container.querySelectorAll<HTMLTextAreaElement>(
          ".agent-instructions-section textarea",
        ),
      ]
        .filter((ta) => !ta.closest(".agent-memory-field"))
        .map((ta) => ta.getAttribute(RECORDING_PRIVATE_ATTR));
      expect(instructions).toHaveLength(1);
      for (const scope of [memory, instructions[0]])
        expect({ scope, hasAgent: !!scope?.includes(agent.id) }).toEqual({
          scope,
          hasAgent: true,
        });
      expect(memory).not.toBe(instructions[0]);
    } finally {
      cleanup(view);
    }
  });
});
