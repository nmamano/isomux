// The agent dialog's memory box (task bf94d714): whoever opens the dialog
// reads the agent's memory, and only the agent's manager and office owners
// edit it - the server refuses anyone else's save.
import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();
const { setApiShim } = await import("../api.ts");
const { agentAt, cleanup, renderEdit, settle, viewer } =
  await import("../test-support/access-slider-fixture.tsx");

const NOTE = "- Peer, 2026-11-04: the agent's note";

function memoryBox(container: HTMLElement): HTMLTextAreaElement {
  const box = container.querySelector<HTMLTextAreaElement>(
    ".agent-memory-field textarea",
  );
  if (!box) throw new Error("no memory box");
  return box;
}

describe("the agent dialog's memory box", () => {
  it("shows the memory to every viewer, and is read-only for one who neither manages the agent nor owns the office", async () => {
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
      const view = renderEdit(agentAt("standard"), () => {}, sessionContext);
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
      peer: { value: NOTE, readOnly: true },
    });
  });
});
